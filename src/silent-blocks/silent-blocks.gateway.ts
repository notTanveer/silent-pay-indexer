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

    constructor(
        @Inject(forwardRef(() => SilentBlocksService))
        private readonly silentBlocksService: SilentBlocksService,
    ) {}

    handleConnection(client: WebSocket) {
        const remoteAddress = (client as any)._socket.remoteAddress;
        this.logger.debug(`Client connected: ${remoteAddress}`);
    }

    handleDisconnect(client: WebSocket) {
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
            const to = Math.min(requestedTo, tip);
            const filterSpent = data?.filterSpent ?? true;

            if (to < from) {
                // Nothing to send (client already at/above tip) — still ack.
                this.sendControl(client, 'synced', { from, to, tip, count: 0 });
                return;
            }

            let count = 0;
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

    broadcastSilentBlock(silentBlock: Buffer) {
        for (const client of this.server.clients) {
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

    private async awaitDrain(client: WebSocket): Promise<void> {
        while (
            client.readyState === WebSocket.OPEN &&
            client.bufferedAmount > MAX_BUFFERED_BYTES
        ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
}
