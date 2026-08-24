import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
    SubscribeMessage,
    MessageBody,
    ConnectedSocket,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';

// Pause the height cursor while the socket's outbound buffer is above this, so a
// slow client can't make the server buffer the whole range in memory.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

// A client that drains nothing at all for this long is treated as dead. Any
// progress at all drops it under the threshold, so this only catches sockets
// the kernel has not yet given up on (half-open connections retry for minutes).
const STALL_TIMEOUT_MS = 60_000;

interface SyncRequest {
    from?: number;
    to?: number;
    filterSpent?: boolean;
}

@Injectable()
@WebSocketGateway()
export class SilentBlocksGateway
    implements OnGatewayConnection, OnGatewayDisconnect
{
    private readonly logger = new Logger(SilentBlocksGateway.name);

    @WebSocketServer() server: Server;

    // Clients mid-backfill: a bare tip broadcast would desync their frame parser.
    private readonly syncing = new Set<WebSocket>();

    constructor(
        @Inject(forwardRef(() => SilentBlocksService))
        private readonly silentBlocksService: SilentBlocksService,
    ) {}

    handleConnection(client: WebSocket) {
        const remoteAddress = (client as any)._socket.remoteAddress;
        this.logger.debug(`Client connected: ${remoteAddress}`);
    }

    handleDisconnect(client: WebSocket) {
        this.syncing.delete(client);
        const remoteAddress = (client as any)._socket.remoteAddress;
        this.logger.debug(`Client disconnected: ${remoteAddress}`);
    }

    /**
     * Stream a contiguous range of binary silent blocks over the socket.
     *
     * Control in (text): { event: 'sync', data: { from, to?, filterSpent? } }
     * Data out (binary): one `height|len|blob` frame per message.
     * Done out (text):   { event: 'synced', data: { from, to, tip, count } }
     * Error out (text):  { event: 'error',  data: { message } }
     *
     * One connection carries the whole backfill, so the ~1.5s tunnel round-trip is
     * paid once per sync session instead of once per 200-block chunk.
     */
    @SubscribeMessage('sync')
    async handleSync(
        @ConnectedSocket() client: WebSocket,
        @MessageBody() data: SyncRequest,
    ): Promise<void> {
        try {
            const from = Math.floor(Number(data?.from));
            if (!Number.isFinite(from) || from < 0) {
                this.sendControl(client, 'error', {
                    message: 'sync requires a non-negative integer `from`',
                });
                return;
            }

            const tip =
                await this.silentBlocksService.getLatestIndexedBlockHeight();
            const requestedTo =
                data?.to != null ? Math.floor(Number(data.to)) : tip;
            if (!Number.isFinite(requestedTo)) {
                this.sendControl(client, 'error', {
                    message: '`to` must be an integer',
                });
                return;
            }
            const to = Math.min(requestedTo, tip);
            const filterSpent = data?.filterSpent ?? true;

            if (to < from) {
                // Nothing to send (client already at/above tip) — still ack.
                this.sendControl(client, 'synced', { from, to, tip, count: 0 });
                return;
            }

            let count = 0;
            this.syncing.add(client);
            try {
                for await (const frame of this.silentBlocksService.streamSilentBlocksRange(
                    from,
                    to,
                    filterSpent,
                )) {
                    if (client.readyState !== WebSocket.OPEN) return; // client gone
                    await this.awaitDrain(client);
                    if (client.readyState !== WebSocket.OPEN) return;
                    client.send(frame, { binary: true });
                    count++;
                }
            } finally {
                this.syncing.delete(client);
            }

            this.sendControl(client, 'synced', { from, to, tip, count });
        } catch (err) {
            this.logger.error(
                `sync stream failed: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            this.sendControl(client, 'error', {
                message: err instanceof Error ? err.message : 'sync failed',
            });
        }
    }

    @SubscribeMessage('ping')
    handlePing(@ConnectedSocket() client: WebSocket): void {
        this.sendControl(client, 'pong', null);
    }

    broadcastSilentBlock(silentBlock: Buffer) {
        for (const client of this.server.clients) {
            if (this.syncing.has(client)) continue;
            if (client.readyState === WebSocket.OPEN) {
                client.send(silentBlock);
            }
        }
    }

    private sendControl(client: WebSocket, event: string, data: unknown): void {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ event, data }));
        }
    }

    // The deadline is per call, so a slow-but-progressing client gets a fresh
    // budget for every frame; only a total stall runs it out.
    private async awaitDrain(client: WebSocket): Promise<void> {
        const deadline = Date.now() + STALL_TIMEOUT_MS;
        let delay = 5;

        while (
            client.readyState === WebSocket.OPEN &&
            client.bufferedAmount > MAX_BUFFERED_BYTES
        ) {
            if (Date.now() > deadline) {
                this.logger.warn(
                    `Terminating client stalled at ${client.bufferedAmount} buffered bytes for ${STALL_TIMEOUT_MS}ms`,
                );
                client.terminate();
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 100);
        }
    }
}
