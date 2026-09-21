import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '@/storage/storage.service';
import { TransactionData } from '@/storage/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const txid = (n: number) => n.toString(16).padStart(64, '0');
const hash = (n: number) => n.toString(16).padStart(64, 'f');
const pubKey = (n: number) => n.toString(16).padStart(64, 'a');

const makeTx = (
    id: string,
    outputs: { vout: number; value: number }[],
    blockHeight = 100,
    blockHash = hash(999),
    blockTime = 1_700_000_000,
): TransactionData => ({
    id,
    blockHeight,
    blockHash,
    blockTime,
    scanTweak: '02'.padEnd(66, 'b'),
    outputs: outputs.map((o) => ({
        transactionId: id,
        vout: o.vout,
        pubKey: pubKey(o.vout),
        value: o.value,
        isSpent: false,
    })),
});

describe('StorageService', () => {
    let storage: StorageService;
    let tmpDir: string;

    const save = async (...txs: TransactionData[]) => {
        const batch = storage.createBatch();
        for (const tx of txs) storage.saveTransaction(batch, tx);
        await batch.commit();
    };

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StorageService,
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) =>
                            key === 'db.path' ? tmpDir : null,
                    },
                },
            ],
        }).compile();

        storage = module.get<StorageService>(StorageService);
        await storage.onModuleInit();
    });

    afterEach(async () => {
        await storage.onModuleDestroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('transaction reads', () => {
        it('round-trips a transaction and its outputs by txid', async () => {
            await save(
                makeTx(txid(1), [
                    { vout: 0, value: 500 },
                    { vout: 3, value: 700 },
                ]),
            );

            const tx = await storage.getTransactionByTxid(txid(1));
            expect(tx.id).toBe(txid(1));
            expect(tx.blockHeight).toBe(100);
            expect(tx.blockHash).toBe(hash(999));
            expect(tx.blockTime).toBe(1_700_000_000);
            expect(tx.outputs.map((o) => [o.vout, o.value])).toEqual([
                [0, 500],
                [3, 700],
            ]);
        });

        it('returns null for an unknown txid', async () => {
            expect(await storage.getTransactionByTxid(txid(42))).toBeNull();
        });

        it('returns every transaction at a height, txid-ascending', async () => {
            await save(
                makeTx(txid(20), [{ vout: 0, value: 1 }], 500),
                makeTx(txid(10), [{ vout: 0, value: 2 }], 500),
                makeTx(txid(30), [{ vout: 0, value: 3 }], 501),
            );

            const txs = await storage.getTransactionsByBlockHeight(500);
            expect(txs.map((t) => t.id)).toEqual([txid(10), txid(20)]);
        });

        it('spans an inclusive height range in height order', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 10),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 11),
                makeTx(txid(3), [{ vout: 0, value: 3 }], 12),
                makeTx(txid(4), [{ vout: 0, value: 4 }], 13),
            );

            const txs = await storage.getTransactionsByBlockHeightRange(11, 12);
            expect(txs.map((t) => t.id)).toEqual([txid(2), txid(3)]);
        });

        it('returns every transaction for a block hash', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1)),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 11, hash(2)),
            );

            const txs = await storage.getTransactionsByBlockHash(hash(2));
            expect(txs.map((t) => t.id)).toEqual([txid(2)]);
        });

        it('returns an empty list for heights and hashes with no data', async () => {
            expect(await storage.getTransactionsByBlockHeight(7)).toEqual([]);
            expect(await storage.getTransactionsByBlockHash(hash(7))).toEqual(
                [],
            );
        });
    });

    describe('getBlockHeightByTimestamp', () => {
        it('finds the first block strictly after the timestamp', async () => {
            await save(
                makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1), 1000),
                makeTx(txid(2), [{ vout: 0, value: 2 }], 11, hash(2), 2000),
            );

            expect(await storage.getBlockHeightByTimestamp(999)).toBe(10);
            // Strictly after: a block AT the timestamp is not a match.
            expect(await storage.getBlockHeightByTimestamp(1000)).toBe(11);
            expect(await storage.getBlockHeightByTimestamp(2000)).toBeNull();
        });
    });

    describe('block state', () => {
        it('returns the highest recorded height', async () => {
            const batch = storage.createBatch();
            storage.saveBlockState(batch, {
                blockHeight: 10,
                blockHash: hash(1),
            });
            storage.saveBlockState(batch, {
                blockHeight: 12,
                blockHash: hash(2),
            });
            storage.saveBlockState(batch, {
                blockHeight: 11,
                blockHash: hash(3),
            });
            await batch.commit();

            expect(await storage.getCurrentBlockState()).toEqual({
                blockHeight: 12,
                blockHash: hash(2),
            });
        });

        it('falls back to the next-highest once the tip is deleted', async () => {
            const batch = storage.createBatch();
            storage.saveBlockState(batch, {
                blockHeight: 10,
                blockHash: hash(1),
            });
            storage.saveBlockState(batch, {
                blockHeight: 11,
                blockHash: hash(2),
            });
            await batch.commit();

            const remove = storage.createBatch();
            storage.deleteBlockState(remove, 11);
            await remove.commit();

            expect((await storage.getCurrentBlockState()).blockHeight).toBe(10);
        });

        it('returns null when nothing is recorded', async () => {
            expect(await storage.getCurrentBlockState()).toBeNull();
        });
    });

    describe('operation state', () => {
        it('round-trips a JSON state blob', async () => {
            const batch = storage.createBatch();
            storage.saveOperationState(batch, 'core', {
                indexedBlockHeight: 842579,
            });
            await batch.commit();

            expect(await storage.getOperationState('core')).toEqual({
                id: 'core',
                state: { indexedBlockHeight: 842579 },
            });
        });

        it('returns null for an unknown id', async () => {
            expect(await storage.getOperationState('nope')).toBeNull();
        });
    });

    describe('deleteTransactionsByBlockHash', () => {
        it('removes the transactions, outputs and every index for that block', async () => {
            await save(
                makeTx(
                    txid(1),
                    [
                        { vout: 0, value: 1 },
                        { vout: 1, value: 2 },
                    ],
                    10,
                    hash(1),
                    1000,
                ),
                makeTx(txid(2), [{ vout: 0, value: 3 }], 10, hash(1), 1000),
                makeTx(txid(3), [{ vout: 0, value: 4 }], 11, hash(2), 2000),
            );

            const batch = storage.createBatch();
            await storage.deleteTransactionsByBlockHash(batch, hash(1));
            await batch.commit();

            expect(await storage.getTransactionByTxid(txid(1))).toBeNull();
            expect(await storage.getTransactionByTxid(txid(2))).toBeNull();
            expect(await storage.getTransactionsByBlockHeight(10)).toEqual([]);
            expect(await storage.getTransactionsByBlockHash(hash(1))).toEqual(
                [],
            );
            // The time index for the deleted block is gone, so the next block
            // after that timestamp is now block 11.
            expect(await storage.getBlockHeightByTimestamp(999)).toBe(11);

            // The untouched block survives intact.
            const survivors = await storage.getTransactionsByBlockHeight(11);
            expect(survivors.map((t) => t.id)).toEqual([txid(3)]);
        });

        it('is a no-op for a block hash that was never indexed', async () => {
            await save(makeTx(txid(1), [{ vout: 0, value: 1 }], 10, hash(1)));

            const batch = storage.createBatch();
            await storage.deleteTransactionsByBlockHash(batch, hash(5));
            await batch.commit();

            expect(await storage.getTransactionByTxid(txid(1))).not.toBeNull();
        });
    });

    describe('batching', () => {
        it('writes nothing when the batch is never committed', async () => {
            const batch = storage.createBatch();
            storage.saveTransaction(
                batch,
                makeTx(txid(1), [{ vout: 0, value: 1 }]),
            );

            expect(await storage.getTransactionByTxid(txid(1))).toBeNull();
        });
    });
});
