/**
 * Minimal, dependency-free timing helper for the block-indexing hot path.
 *
 * Accumulates named phase durations (in milliseconds) and integer counters so a
 * single structured summary can be logged per block. Phase names that repeat are
 * summed, so e.g. per-transaction `index` calls roll up into one `index` total.
 *
 * Uses process.hrtime.bigint() for monotonic, sub-millisecond precision.
 */
export class BlockTimer {
    private readonly phasesMs = new Map<string, number>();
    private readonly counts = new Map<string, number>();
    private readonly start = process.hrtime.bigint();

    /** Record `ms` against a phase, accumulating if the name repeats. */
    mark(name: string, ms: number): void {
        this.phasesMs.set(name, (this.phasesMs.get(name) ?? 0) + ms);
    }

    /** Time a synchronous function, record it under `name`, and return its result. */
    measure<T>(name: string, fn: () => T): T {
        const started = process.hrtime.bigint();
        try {
            return fn();
        } finally {
            this.mark(name, elapsedMs(started));
        }
    }

    /** Time an async function, record it under `name`, and return its result. */
    async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
        const started = process.hrtime.bigint();
        try {
            return await fn();
        } finally {
            this.mark(name, elapsedMs(started));
        }
    }

    /** Accumulate an integer counter (e.g. numTx, numInputs). */
    count(name: string, n = 1): void {
        this.counts.set(name, (this.counts.get(name) ?? 0) + n);
    }

    /** Total wall-clock time since this timer was created, in milliseconds. */
    totalMs(): number {
        return elapsedMs(this.start);
    }

    /** Structured snapshot of all recorded phases and counters. */
    summary(): {
        phasesMs: Record<string, number>;
        counts: Record<string, number>;
        totalMs: number;
    } {
        return {
            phasesMs: roundedRecord(this.phasesMs),
            counts: Object.fromEntries(this.counts),
            totalMs: round2(this.totalMs()),
        };
    }
}

/** Milliseconds elapsed since a process.hrtime.bigint() reading. */
function elapsedMs(since: bigint): number {
    return Number(process.hrtime.bigint() - since) / 1e6;
}

function round2(ms: number): number {
    return Math.round(ms * 100) / 100;
}

function roundedRecord(map: Map<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of map) out[k] = round2(v);
    return out;
}
