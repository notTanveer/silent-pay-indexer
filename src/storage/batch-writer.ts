import { RootDatabase } from 'lmdb';
import { EnvLease } from '@/storage/partition-manager';

type Op =
    | { type: 'put'; key: Buffer; value: Buffer }
    | { type: 'del'; key: Buffer };

interface EnvGroup {
    lease: EnvLease;
    ops: Op[];
    /**
     * Keys already queued by putOnce/delOnce, tagged by operation so a put and
     * a delete of the same key are never confused for one another.
     */
    coalesced: Set<string>;
}

/**
 * Queues put/del operations against one or more LMDB environments and applies
 * each environment's operations atomically on commit(). If commit() is never
 * called the batch is discarded (implicit rollback), but dispose() must still
 * run so the environments it borrowed can be evicted again.
 */
export class BatchWriter {
    private readonly groups = new Map<RootDatabase<Buffer, Buffer>, EnvGroup>();

    /**
     * Takes ownership of a lease and returns the one this batch holds for that
     * environment, so callers can read through it while it stays pinned for the
     * life of the batch. Handing over a second lease for an environment already
     * held releases it immediately, which is also what keeps each environment
     * to a single atomic transaction rather than one per caller.
     */
    adopt(lease: EnvLease): EnvLease {
        const existing = this.groups.get(lease.db);
        if (existing) {
            // Only a genuinely surplus lease is released. Handing back the one
            // this batch already holds — which every put after the first does —
            // must not drop it, or the environment falls out of the LRU's
            // pinned set and can be closed mid-batch.
            if (existing.lease !== lease) lease.release();
            return existing.lease;
        }
        this.groups.set(lease.db, { lease, ops: [], coalesced: new Set() });
        return lease;
    }

    put(lease: EnvLease, key: Buffer, value: Buffer): this {
        this.groupFor(lease).ops.push({ type: 'put', key, value });
        return this;
    }

    del(lease: EnvLease, key: Buffer): this {
        this.groupFor(lease).ops.push({ type: 'del', key });
        return this;
    }

    /**
     * Queues a put only if this key has not already been queued by putOnce.
     *
     * For keys a caller derives once per record but that are really one entry
     * per block — the `idx:bt:` timestamp index is the only one today. Every
     * transaction in a block derives the identical key and value, so without
     * this a 25-block batch would replay tens of thousands of identical
     * putSyncs against the global environment, each a full B+tree descent.
     *
     * Not a general write-coalescing layer: keying every op by string would
     * cost an allocation per output on the hot path to solve a problem only
     * these keys have.
     */
    putOnce(lease: EnvLease, key: Buffer, value: Buffer): this {
        const group = this.groupFor(lease);
        if (!this.firstTime(group, 'p', key)) return this;
        group.ops.push({ type: 'put', key, value });
        return this;
    }

    /** The delete-side counterpart of putOnce. */
    delOnce(lease: EnvLease, key: Buffer): this {
        const group = this.groupFor(lease);
        if (!this.firstTime(group, 'd', key)) return this;
        group.ops.push({ type: 'del', key });
        return this;
    }

    /**
     * Commits partition environments in ascending order, then the global
     * environment last.
     *
     * THIS ORDERING IS THE INVARIANT, in both directions, and it is the one
     * thing here that cannot be recovered from if broken. LMDB gives no
     * cross-environment atomicity, so the global environment — which holds the
     * authority records, `os:` (the resume pointer) and `bs:` (the reorg
     * trigger) — must always change last.
     *
     *   Writing: a crash between commits leaves data above the resume pointer.
     *   Replay re-puts identical values and converges. State ahead of its data
     *   would not.
     *
     *   Deleting during a reorg: a crash leaves `bs:` still pointing at a
     *   block whose data is gone, so the next traceReorg re-runs the same
     *   deletes, which are no-ops on absent keys, and converges. Dropping the
     *   trigger first would strand records nothing can find, and `idx:h:`
     *   would then serve both the old and the new block at that height.
     *
     * transactionSync's default flags are ABORTABLE | SYNCHRONOUS_COMMIT, so
     * each call fsyncs before returning and the ordering is durable rather
     * than merely visible. Passing NO_SYNC_FLUSH here would break that
     * silently, with no test failure.
     */
    async commit(): Promise<void> {
        try {
            const ordered = [...this.groups.values()].sort(
                (a, b) => a.lease.order - b.lease.order,
            );

            for (const { lease, ops } of ordered) {
                // An adopted environment that was only read from has nothing to
                // write; skip it rather than open an empty transaction.
                if (ops.length === 0) continue;

                const db = lease.db;
                // One top-level transactionSync per environment, never nested:
                // each environment takes its own write lock, and a throw inside
                // a nested one would leave the outer transaction open.
                db.transactionSync(() => {
                    for (const op of ops) {
                        if (op.type === 'put') {
                            db.putSync(op.key, op.value);
                        } else {
                            db.removeSync(op.key);
                        }
                    }
                });
            }
        } finally {
            this.dispose();
        }
    }

    /** Releases every borrowed environment. Idempotent. */
    dispose(): void {
        for (const { lease } of this.groups.values()) lease.release();
        this.groups.clear();
    }

    private groupFor(lease: EnvLease): EnvGroup {
        return this.groups.get(this.adopt(lease).db);
    }

    /** True the first time this (operation, key) pair is seen in a group. */
    private firstTime(group: EnvGroup, op: 'p' | 'd', key: Buffer): boolean {
        const tag = op + key.toString('latin1');
        if (group.coalesced.has(tag)) return false;
        group.coalesced.add(tag);
        return true;
    }
}
