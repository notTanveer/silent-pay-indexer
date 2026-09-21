import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
    PartitionManager,
    clampBatchEnd,
    partitionDirName,
    partitionEndHeight,
    partitionIndexFor,
    partitionStartHeight,
    splitRangeByPartition,
} from '@/storage/partition-manager';
import { BIP352_ACTIVATION_HEIGHT } from '@/common/constants';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('partition arithmetic', () => {
    describe('partitionIndexFor', () => {
        it('groups heights into fixed-width partitions', () => {
            expect(partitionIndexFor(0, 1000)).toBe(0);
            expect(partitionIndexFor(999, 1000)).toBe(0);
            expect(partitionIndexFor(1000, 1000)).toBe(1);
            expect(partitionIndexFor(1001, 1000)).toBe(1);
        });

        it('degenerates to one partition per height at width 1', () => {
            expect(partitionIndexFor(0, 1)).toBe(0);
            expect(partitionIndexFor(7, 1)).toBe(7);
        });

        it('places the activation height in the partition its name implies', () => {
            expect(partitionIndexFor(BIP352_ACTIVATION_HEIGHT, 1000)).toBe(842);
            expect(partitionStartHeight(842, 1000)).toBe(842000);
        });
    });

    describe('partitionEndHeight', () => {
        it('is the inclusive last height of the containing partition', () => {
            expect(partitionEndHeight(0, 1000)).toBe(999);
            expect(partitionEndHeight(999, 1000)).toBe(999);
            expect(partitionEndHeight(1000, 1000)).toBe(1999);
            expect(partitionEndHeight(BIP352_ACTIVATION_HEIGHT, 1000)).toBe(
                842999,
            );
        });

        it('is never below the height it was asked about', () => {
            for (let height = 0; height < 200; height++) {
                for (const width of [1, 3, 5, 17, 1000]) {
                    expect(
                        partitionEndHeight(height, width),
                    ).toBeGreaterThanOrEqual(height);
                }
            }
        });
    });

    describe('clampBatchEnd', () => {
        it('spans the full batch when it fits inside one partition', () => {
            expect(clampBatchEnd(1000, 25, 99999, 1000)).toBe(1024);
        });

        it('stops at the partition boundary rather than crossing it', () => {
            expect(clampBatchEnd(990, 25, 99999, 1000)).toBe(999);
        });

        it('yields a single block when the boundary is the next height', () => {
            expect(clampBatchEnd(999, 25, 99999, 1000)).toBe(999);
        });

        it('stops at the tip when the tip is nearer than either limit', () => {
            expect(clampBatchEnd(1000, 25, 1003, 1000)).toBe(1003);
        });

        it('never returns a height below the start', () => {
            // The sync loop advances with `height = batchEnd + 1`, so a result
            // below `height` would make it spin forever.
            for (let height = 0; height < 300; height++) {
                for (const width of [1, 2, 5, 25, 1000]) {
                    for (const batchSize of [1, 5, 25]) {
                        const tip = height + 500;
                        expect(
                            clampBatchEnd(height, batchSize, tip, width),
                        ).toBeGreaterThanOrEqual(height);
                    }
                }
            }
        });
    });

    describe('splitRangeByPartition', () => {
        it('returns a single span when the range fits one partition', () => {
            expect(splitRangeByPartition(1001, 1005, 1000)).toEqual([
                { index: 1, lo: 1001, hi: 1005 },
            ]);
        });

        it('splits at every boundary it crosses, with no gaps or overlaps', () => {
            const spans = splitRangeByPartition(3, 12, 5);
            expect(spans).toEqual([
                { index: 0, lo: 3, hi: 4 },
                { index: 1, lo: 5, hi: 9 },
                { index: 2, lo: 10, hi: 12 },
            ]);
        });

        it('covers the whole range exactly once for any width', () => {
            for (const width of [1, 3, 5, 50]) {
                const spans = splitRangeByPartition(7, 56, width);
                const covered = spans.flatMap(({ lo, hi }) =>
                    Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
                );
                expect(covered).toEqual(
                    Array.from({ length: 50 }, (_, i) => 7 + i),
                );
            }
        });

        it('handles a single-height range', () => {
            expect(splitRangeByPartition(9, 9, 5)).toEqual([
                { index: 1, lo: 9, hi: 9 },
            ]);
        });
    });

    it('names partition directories so they sort in height order', () => {
        expect([partitionDirName(10), partitionDirName(2)].sort()).toEqual([
            '000002',
            '000010',
        ]);
    });
});

describe('PartitionManager', () => {
    let manager: PartitionManager;
    let tmpDir: string;

    const build = async (overrides: Record<string, unknown> = {}) => {
        const config = {
            'db.path': tmpDir,
            'db.partitionBlocks': 5,
            'db.partitionMapSize': 16 * 1024 * 1024,
            'db.mapSize': 16 * 1024 * 1024,
            'db.openPartitions': 2,
            ...overrides,
        };
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PartitionManager,
                {
                    provide: ConfigService,
                    useValue: { get: (key: string) => config[key] ?? null },
                },
            ],
        }).compile();
        return module.get<PartitionManager>(PartitionManager);
    };

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partitions-test-'));
    });

    afterEach(async () => {
        await manager?.onModuleDestroy();
        manager = undefined;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('opens partitions lazily', async () => {
        manager = await build();
        manager.onModuleInit();

        expect(fs.existsSync(path.join(tmpDir, 'parts', '000003'))).toBe(false);

        manager.acquirePartition(17).release();

        expect(fs.existsSync(path.join(tmpDir, 'parts', '000003'))).toBe(true);
    });

    it('returns the same environment for two heights in one partition', async () => {
        manager = await build();
        manager.onModuleInit();

        const a = manager.acquirePartition(15);
        const b = manager.acquirePartition(19);
        expect(a.db).toBe(b.db);
        a.release();
        b.release();
    });

    it('evicts the least recently used partition past the cap', async () => {
        manager = await build();
        manager.onModuleInit();

        manager.acquirePartition(0).release();
        manager.acquirePartition(5).release();
        // Touch partition 0 again so partition 1 is the oldest.
        manager.acquirePartition(0).release();
        expect(manager.openCount).toBe(2);

        manager.acquirePartition(10).release();

        expect(manager.openCount).toBe(2);
    });

    it('survives a close and reopen of the same partition', async () => {
        manager = await build();
        manager.onModuleInit();

        const key = Buffer.from('k');
        const first = manager.acquirePartition(0);
        first.db.transactionSync(() => {
            first.db.putSync(key, Buffer.from('v'));
        });
        first.release();

        // Force partition 0 out of the cache, then read it back.
        manager.acquirePartition(5).release();
        manager.acquirePartition(10).release();

        const reopened = manager.acquirePartition(0);
        expect(Buffer.from(reopened.db.getBinary(key)).toString()).toBe('v');
        reopened.release();
    });

    it('never evicts a partition that is still leased', async () => {
        manager = await build();
        manager.onModuleInit();

        const held = manager.acquirePartition(0);
        const alsoHeld = manager.acquirePartition(5);

        // Both slots are pinned, so the cap has to give rather than the leases.
        manager.acquirePartition(10).release();

        expect(manager.openCount).toBe(3);
        held.release();
        alsoHeld.release();

        // Once released they are eligible again.
        manager.acquirePartition(15).release();
        expect(manager.openCount).toBeLessThanOrEqual(3);
    });

    it('never evicts the global environment', async () => {
        manager = await build();
        manager.onModuleInit();

        const global = manager.acquireGlobal();
        const db = global.db;
        global.release();

        manager.acquirePartition(0).release();
        manager.acquirePartition(5).release();
        manager.acquirePartition(10).release();

        const again = manager.acquireGlobal();
        expect(again.db).toBe(db);
        again.release();
    });

    it('refuses to start against a database built at another partition width', async () => {
        // The width decides which directory every height lives in, so changing
        // it does not reshuffle anything — it orphans the existing data while
        // the global environment still claims the chain is indexed.
        manager = await build();
        manager.onModuleInit();
        await manager.onModuleDestroy();

        manager = await build({ 'db.partitionBlocks': 10 });

        expect(() => manager.onModuleInit()).toThrow(
            /indexed with db.partitionBlocks=5 but is being opened with 10/,
        );
    });

    it('accepts a reopen at the width it was stamped with', async () => {
        manager = await build();
        manager.onModuleInit();
        await manager.onModuleDestroy();

        manager = await build();

        expect(() => manager.onModuleInit()).not.toThrow();
    });

    it('refuses to start against a pre-partition database', async () => {
        fs.writeFileSync(path.join(tmpDir, 'data.mdb'), '');
        manager = await build();

        expect(() => manager.onModuleInit()).toThrow(/pre-partition database/);
    });
});
