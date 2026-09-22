import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { open, RootDatabase } from 'lmdb';
import { existsSync } from 'fs';
import { join } from 'path';
import {
    DEFAULT_OPEN_PARTITIONS,
    DEFAULT_PARTITION_BLOCKS,
    DEFAULT_PARTITION_MAP_SIZE,
} from '@/common/constants';
import {
    decodeUInt32,
    encodeMetaKey,
    encodeUInt32,
} from '@/storage/key-encoding';

/** Meta key recording the partition width the data on disk was written under. */
const PARTITION_BLOCKS_META = encodeMetaKey('partitionBlocks');

/**
 * Sort key that places the global environment last in any commit ordering.
 * See the ordering invariant in BatchWriter.commit.
 */
export const GLOBAL_ORDER = Number.MAX_SAFE_INTEGER;

/**
 * A borrowed environment. While a lease is outstanding the environment cannot
 * be evicted, which matters because closing an environment out from under a
 * live cursor crashes the process rather than throwing.
 *
 * Every acquire must be paired with a release, in a `finally`.
 */
export interface EnvLease {
    readonly db: RootDatabase<Buffer, Buffer>;
    readonly order: number;
    release(): void;
}

/** A contiguous run of heights that lives in a single partition. */
export interface PartitionSpan {
    index: number;
    lo: number;
    hi: number;
}

// --- Boundary arithmetic (pure, exported for direct testing) ---

export function partitionIndexFor(
    height: number,
    partitionBlocks: number,
): number {
    return Math.floor(height / partitionBlocks);
}

export function partitionStartHeight(
    index: number,
    partitionBlocks: number,
): number {
    return index * partitionBlocks;
}

/** Inclusive last height held by the partition that `height` falls in. */
export function partitionEndHeight(
    height: number,
    partitionBlocks: number,
): number {
    return (
        partitionStartHeight(
            partitionIndexFor(height, partitionBlocks) + 1,
            partitionBlocks,
        ) - 1
    );
}

/**
 * Last height a commit batch starting at `height` may cover.
 *
 * Clamping to the partition boundary is not a tuning choice: it is what
 * guarantees at most one partition can hold data above the recorded tip after
 * an unclean shutdown, which is what makes crash recovery a single-partition
 * scan instead of a search across the whole chain.
 *
 * Assumes `tipHeight >= height`; the caller's loop guarantees it. The result
 * is then never below `height`, which the sync loop relies on to terminate.
 */
export function clampBatchEnd(
    height: number,
    commitBatchBlocks: number,
    tipHeight: number,
    partitionBlocks: number,
): number {
    return Math.min(
        height + commitBatchBlocks - 1,
        tipHeight,
        partitionEndHeight(height, partitionBlocks),
    );
}

/** Splits an inclusive height range into per-partition spans, ascending. */
export function splitRangeByPartition(
    startHeight: number,
    endHeight: number,
    partitionBlocks: number,
): PartitionSpan[] {
    const spans: PartitionSpan[] = [];
    for (let lo = startHeight; lo <= endHeight; ) {
        const hi = Math.min(endHeight, partitionEndHeight(lo, partitionBlocks));
        spans.push({ index: partitionIndexFor(lo, partitionBlocks), lo, hi });
        lo = hi + 1;
    }
    return spans;
}

/** Zero-padded so partition directories sort in height order. */
export function partitionDirName(index: number): string {
    return index.toString().padStart(6, '0');
}

interface OpenEnv {
    db: RootDatabase<Buffer, Buffer>;
    refCount: number;
    lastUsed: number;
}

/** Shared wording: every incompatibility here is resolved the same way. */
function reindexRequired(dbPath: string, reason: string): Error {
    return new Error(
        `${dbPath} ${reason} Point db.path at a fresh directory and reindex, ` +
            `keeping this one until the new index is verified.`,
    );
}

/**
 * Owns every LMDB environment.
 *
 * Storage is split into one environment per run of `db.partitionBlocks`
 * heights, plus a global environment for the records that cannot be routed by
 * height (block state, operation state, and the hash and timestamp indexes).
 *
 * `db.path` itself is a plain directory, not an environment.
 */
@Injectable()
export class PartitionManager implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PartitionManager.name);
    private readonly dbPath: string;
    private readonly partitionMapSize: number;
    private readonly globalMapSize: number;
    private readonly maxOpen: number;

    readonly partitionBlocks: number;

    private readonly partitions = new Map<number, OpenEnv>();
    private globalEnv: OpenEnv | null = null;
    /** Monotonic counter standing in for a clock in the LRU ordering. */
    private tick = 0;
    /**
     * Closes started by eviction, so shutdown can wait for them. Normally
     * already settled: see evictIfNeeded.
     */
    private readonly closing = new Set<Promise<unknown>>();
    /** Suppresses repeats of the "everything is pinned" warning. */
    private warnedAllPinned = false;

    constructor(private readonly configService: ConfigService) {
        this.dbPath = this.configService.get<string>('db.path');
        this.partitionBlocks =
            this.configService.get<number>('db.partitionBlocks') ??
            DEFAULT_PARTITION_BLOCKS;
        this.partitionMapSize =
            this.configService.get<number>('db.partitionMapSize') ??
            DEFAULT_PARTITION_MAP_SIZE;
        this.globalMapSize = this.configService.get<number>('db.mapSize');
        this.maxOpen =
            this.configService.get<number>('db.openPartitions') ??
            DEFAULT_OPEN_PARTITIONS;
    }

    onModuleInit(): void {
        const legacyDataFile = join(this.dbPath, 'data.mdb');
        if (existsSync(legacyDataFile) && !existsSync(this.globalPath())) {
            throw reindexRequired(
                this.dbPath,
                'holds a pre-partition database. The schema is not compatible ' +
                    '(partitioned layout, 40-byte output values, one idx:bh: ' +
                    'entry per block), so it cannot be read or upgraded in place.',
            );
        }

        // Opened eagerly so a bad path or map size fails at startup rather
        // than on the first request.
        const global = this.acquireGlobal();
        try {
            this.assertPartitionWidthUnchanged(global.db);
        } finally {
            global.release();
        }
    }

    async onModuleDestroy(): Promise<void> {
        // Evictions in flight count too, or shutdown can outrun them.
        const closing: Promise<unknown>[] = [...this.closing];
        for (const entry of this.partitions.values())
            closing.push(entry.db.close());
        this.partitions.clear();
        if (this.globalEnv) {
            closing.push(this.globalEnv.db.close());
            this.globalEnv = null;
        }
        await Promise.all(closing);
        this.logger.log('LMDB environments closed');
    }

    partitionIndex(height: number): number {
        return partitionIndexFor(height, this.partitionBlocks);
    }

    partitionEndHeight(height: number): number {
        return partitionEndHeight(height, this.partitionBlocks);
    }

    clampBatchEnd(
        height: number,
        commitBatchBlocks: number,
        tipHeight: number,
    ): number {
        return clampBatchEnd(
            height,
            commitBatchBlocks,
            tipHeight,
            this.partitionBlocks,
        );
    }

    splitRange(startHeight: number, endHeight: number): PartitionSpan[] {
        return splitRangeByPartition(
            startHeight,
            endHeight,
            this.partitionBlocks,
        );
    }

    acquirePartition(height: number): EnvLease {
        const index = this.partitionIndex(height);
        let entry = this.partitions.get(index);
        if (!entry) {
            this.evictIfNeeded();
            entry = {
                db: this.openEnv(
                    join(this.dbPath, 'parts', partitionDirName(index)),
                    this.partitionMapSize,
                ),
                refCount: 0,
                lastUsed: 0,
            };
            this.partitions.set(index, entry);
        }
        return this.lease(entry, index);
    }

    acquireGlobal(): EnvLease {
        if (!this.globalEnv) {
            this.globalEnv = {
                db: this.openEnv(this.globalPath(), this.globalMapSize),
                refCount: 0,
                lastUsed: 0,
            };
        }
        return this.lease(this.globalEnv, GLOBAL_ORDER);
    }

    /** Open partition count, for tests and diagnostics. */
    get openCount(): number {
        return this.partitions.size;
    }

    /**
     * Environments with an outstanding lease, global included.
     *
     * Should be zero whenever no read or write is in flight. A lease that is
     * never released pins its environment against eviction for the life of the
     * process, and nothing else makes that observable — the LRU quietly
     * exceeds its cap instead of failing.
     */
    get leasedCount(): number {
        let leased = (this.globalEnv?.refCount ?? 0) > 0 ? 1 : 0;
        for (const entry of this.partitions.values())
            if (entry.refCount > 0) leased++;
        return leased;
    }

    /**
     * Partition width is baked into where every record lives, so changing it
     * does not reshuffle the data — it makes the existing data unreachable
     * while `bs:` and `os:` in the global environment still claim the chain is
     * indexed, and the API then serves empty results for blocks it holds.
     *
     * Stamped on first open and compared on every later one. An index built
     * before this stamp existed is adopted at its current configured width;
     * the guard covers every run from then on.
     */
    private assertPartitionWidthUnchanged(db: RootDatabase<Buffer, Buffer>) {
        const stored = db.getBinary(PARTITION_BLOCKS_META);
        if (!stored) {
            db.putSync(
                PARTITION_BLOCKS_META,
                encodeUInt32(this.partitionBlocks),
            );
            return;
        }

        const written = decodeUInt32(Buffer.from(stored));
        if (written !== this.partitionBlocks) {
            throw reindexRequired(
                this.dbPath,
                `was indexed with db.partitionBlocks=${written} but is being ` +
                    `opened with ${this.partitionBlocks}. Every height would ` +
                    `route to a different partition, leaving the existing data ` +
                    `unreachable.`,
            );
        }
    }

    private globalPath(): string {
        return join(this.dbPath, 'global');
    }

    private openEnv(
        path: string,
        mapSize: number,
    ): RootDatabase<Buffer, Buffer> {
        this.logger.debug(`Opening LMDB at ${path}`);
        // No compression: every value here is well under the 1000-byte
        // threshold, but the compressor force-compresses any value whose first
        // byte is >= 250 because that byte doubles as the read-side marker.
        // `out:` values start with a byte of an x-only pubkey, so ~2.3% of all
        // outputs would take an LZ4 round-trip on every read and write and
        // come out larger.
        return open({
            path,
            keyEncoding: 'binary',
            encoding: 'binary',
            mapSize,
        });
    }

    private lease(entry: OpenEnv, order: number): EnvLease {
        entry.refCount++;
        entry.lastUsed = ++this.tick;
        let released = false;
        return {
            db: entry.db,
            order,
            release: () => {
                if (released) return;
                released = true;
                entry.refCount--;
            },
        };
    }

    private evictIfNeeded(): void {
        while (this.partitions.size >= this.maxOpen) {
            let victimIndex: number | null = null;
            let victim: OpenEnv | null = null;

            for (const [index, entry] of this.partitions) {
                if (entry.refCount > 0) continue;
                if (!victim || entry.lastUsed < victim.lastUsed) {
                    victim = entry;
                    victimIndex = index;
                }
            }

            if (!victim) {
                // The cap is a target, not a limit. Nothing here can wait for
                // a release — acquire is synchronous — so exceeding it is the
                // only alternative to deadlocking. Warned once per episode:
                // this is reached on every acquire while it lasts, which for a
                // write batch is once per saved transaction.
                if (!this.warnedAllPinned) {
                    this.warnedAllPinned = true;
                    this.logger.warn(
                        `All ${this.partitions.size} open partitions are in ` +
                            `use; exceeding db.openPartitions (${this.maxOpen}).`,
                    );
                }
                return;
            }

            this.warnedAllPinned = false;

            this.partitions.delete(victimIndex);
            const closed = victim.db.close().catch((error) => {
                this.logger.error(
                    `Failed to close partition ${victimIndex}: ${error.message}`,
                );
            });
            this.closing.add(closed);
            void closed.finally(() => this.closing.delete(closed));

            // lmdb-js only defers a close for pending async writes or a live
            // read cursor. This codebase has neither — every write goes
            // through transactionSync and every getRange is materialised
            // before its lease is released — so the close has already
            // finished by here and the next acquire of this index can reopen
            // the same path safely. If it ever has not, some read or write
            // outlived its lease and the reopen races a half-closed
            // environment, so say so rather than hope.
            if ((victim.db as { status?: string }).status === 'closing') {
                this.logger.error(
                    `Partition ${victimIndex} did not close synchronously, ` +
                        `which means a read or write outlived its lease. ` +
                        `Reopening this partition may race the close.`,
                );
            }
        }
    }
}
