import { WebSocket } from 'ws';
import { SilentBlocksGateway } from '@/silent-blocks/silent-blocks.gateway';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';

/** Build a fake `ws` client whose send/readyState/bufferedAmount we can drive. */
function fakeClient(overrides: Partial<WebSocket> = {}) {
    return {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: jest.fn(),
        ...overrides,
    } as unknown as WebSocket;
}

/** A service stub whose stream yields one 8-byte+ frame per height in [from,to]. */
function serviceStub(tip: number): SilentBlocksService {
    return {
        getLatestIndexedBlockHeight: jest.fn().mockResolvedValue(tip),
        async *streamSilentBlocksRange(from: number, to: number) {
            for (let h = from; h <= to; h++) {
                const frame = Buffer.alloc(9);
                frame.writeUInt32BE(h, 0);
                frame.writeUInt32BE(1, 4);
                yield frame;
            }
        },
    } as unknown as SilentBlocksService;
}

/** Split a client's send() calls into binary frames and parsed text controls. */
function classify(send: jest.Mock) {
    const frames: Buffer[] = [];
    const controls: any[] = [];
    for (const [payload] of send.mock.calls) {
        if (typeof payload === 'string') controls.push(JSON.parse(payload));
        else frames.push(payload as Buffer);
    }
    return { frames, controls };
}

describe('SilentBlocksGateway sync stream', () => {
    it('streams one frame per height then a synced control', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient();

        await gateway.handleSync(client, {
            from: 100,
            to: 104,
            filterSpent: true,
        });

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(5); // heights 100..104
        expect(frames[0].readUInt32BE(0)).toBe(100);
        expect(frames[4].readUInt32BE(0)).toBe(104);
        expect(controls).toEqual([
            {
                event: 'synced',
                data: { from: 100, to: 104, tip: 1000, count: 5 },
            },
        ]);
    });

    it('clamps `to` to the current tip', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(102));
        const client = fakeClient();

        await gateway.handleSync(client, { from: 100, to: 999 });

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(3); // 100..102 (clamped)
        expect(controls[0]).toEqual({
            event: 'synced',
            data: { from: 100, to: 102, tip: 102, count: 3 },
        });
    });

    it('acks with count 0 when the client is already at tip', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(50));
        const client = fakeClient();

        await gateway.handleSync(client, { from: 100 });

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(0);
        expect(controls[0]).toEqual({
            event: 'synced',
            data: { from: 100, to: 50, tip: 50, count: 0 },
        });
    });

    it('rejects a missing/invalid `from`', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient();

        await gateway.handleSync(client, {} as any);

        const { frames, controls } = classify(client.send as jest.Mock);
        expect(frames).toHaveLength(0);
        expect(controls[0].event).toBe('error');
    });

    it('stops sending once the socket is no longer open', async () => {
        const gateway = new SilentBlocksGateway(serviceStub(1000));
        const client = fakeClient({ readyState: WebSocket.CLOSING });

        await gateway.handleSync(client, { from: 100, to: 200 });

        // Closed before first send: no frames, no synced control.
        expect(client.send as jest.Mock).not.toHaveBeenCalled();
    });
});
