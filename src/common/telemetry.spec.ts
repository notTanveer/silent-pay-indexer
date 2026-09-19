import { BlockTimer } from '@/common/telemetry';

describe('BlockTimer', () => {
    it('records a synchronous phase and returns the result', () => {
        const timer = new BlockTimer();
        const result = timer.measure('work', () => 42);

        expect(result).toBe(42);
        expect(timer.summary().phasesMs.work).toBeGreaterThanOrEqual(0);
    });

    it('records an async phase and returns the result', async () => {
        const timer = new BlockTimer();
        const result = await timer.measureAsync('work', async () => {
            await new Promise((r) => setTimeout(r, 5));
            return 'done';
        });

        expect(result).toBe('done');
        expect(timer.summary().phasesMs.work).toBeGreaterThanOrEqual(4);
    });

    it('accumulates repeated phase names into one total', () => {
        const timer = new BlockTimer();
        timer.mark('index', 10);
        timer.mark('index', 5);

        expect(timer.summary().phasesMs.index).toBe(15);
    });

    it('accumulates counters', () => {
        const timer = new BlockTimer();
        timer.count('numTx');
        timer.count('numTx');
        timer.count('numInputs', 4);

        const { counts } = timer.summary();
        expect(counts.numTx).toBe(2);
        expect(counts.numInputs).toBe(4);
    });

    it('still records the phase when the measured fn throws', () => {
        const timer = new BlockTimer();

        expect(() =>
            timer.measure('boom', () => {
                throw new Error('boom');
            }),
        ).toThrow('boom');
        expect(timer.summary().phasesMs.boom).toBeGreaterThanOrEqual(0);
    });

    it('rejects and still records for async throwers', async () => {
        const timer = new BlockTimer();

        await expect(
            timer.measureAsync('boom', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(timer.summary().phasesMs.boom).toBeGreaterThanOrEqual(0);
    });

    it('reports total wall-clock time', () => {
        const timer = new BlockTimer();
        expect(timer.summary().totalMs).toBeGreaterThanOrEqual(0);
    });
});
