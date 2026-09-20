import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '@/storage/storage.service';
import { TransactionData } from '@/storage/interfaces';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const txid = (n: number) => n.toString(16).padStart(64, '0');
const pubKey = (n: number) => n.toString(16).padStart(64, 'a');

const makeTx = (
    id: string,
    outputs: { vout: number; value: number }[],
    blockHeight = 100,
): TransactionData => ({
    id,
    blockHeight,
    blockHash: txid(999),
    blockTime: 1_700_000_000,
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

    describe('markOutputsSpent', () => {
        it('marks a committed output spent and reports the probe as a hit', async () => {
            const commit = storage.createBatch();
            storage.saveTransaction(
                commit,
                makeTx(txid(1), [{ vout: 0, value: 500 }]),
            );
            await commit.commit();

            const batch = storage.createBatch();
            const stats = await storage.markOutputsSpent(batch, [[txid(1), 0]]);
            await batch.commit();

            expect(stats).toEqual({ probes: 1, hits: 1 });
            const tx = await storage.getTransactionByTxid(txid(1), false);
            expect(tx.outputs[0].isSpent).toBe(true);
        });

        it('handles a same-block spend via pendingOutputs without probing the DB', async () => {
            const batch = storage.createBatch();
            const pending = storage.saveTransaction(
                batch,
                makeTx(txid(2), [{ vout: 0, value: 700 }]),
            );

            // Spent by a later transaction in the same block, so the output is
            // not committed yet and must be resolved from the pending map.
            const stats = await storage.markOutputsSpent(
                batch,
                [[txid(2), 0]],
                pending,
            );
            await batch.commit();

            expect(stats).toEqual({ probes: 0, hits: 0 });
            const tx = await storage.getTransactionByTxid(txid(2), false);
            expect(tx.outputs[0].isSpent).toBe(true);
            expect(tx.outputs[0].value).toBe(700);
        });

        it('is a no-op for outpoints that were never indexed', async () => {
            const batch = storage.createBatch();
            const stats = await storage.markOutputsSpent(batch, [
                [txid(3), 0],
                [txid(4), 7],
            ]);
            await batch.commit();

            expect(stats).toEqual({ probes: 2, hits: 0 });
            expect(
                await storage.getTransactionByTxid(txid(3), false),
            ).toBeNull();
        });

        it('does not rewrite an output that is already spent', async () => {
            const setup = storage.createBatch();
            storage.saveTransaction(
                setup,
                makeTx(txid(5), [{ vout: 0, value: 900 }]),
            );
            await setup.commit();

            const first = storage.createBatch();
            await storage.markOutputsSpent(first, [[txid(5), 0]]);
            await first.commit();

            const second = storage.createBatch();
            const stats = await storage.markOutputsSpent(second, [
                [txid(5), 0],
            ]);
            await second.commit();

            // Still found on disk (a hit), but no second write.
            expect(stats).toEqual({ probes: 1, hits: 1 });
            const tx = await storage.getTransactionByTxid(txid(5), false);
            expect(tx.outputs[0].isSpent).toBe(true);
            expect(tx.outputs[0].value).toBe(900);
        });

        it('resolves every outpoint regardless of the order supplied', async () => {
            const setup = storage.createBatch();
            for (let i = 10; i < 20; i++) {
                storage.saveTransaction(
                    setup,
                    makeTx(txid(i), [{ vout: 0, value: i }]),
                );
            }
            await setup.commit();

            // Probing is internally sorted by encoded key; supplying the
            // outpoints in reverse must not change the outcome.
            const outpoints: [string, number][] = [];
            for (let i = 19; i >= 10; i--) outpoints.push([txid(i), 0]);

            const batch = storage.createBatch();
            const stats = await storage.markOutputsSpent(batch, outpoints);
            await batch.commit();

            expect(stats).toEqual({ probes: 10, hits: 10 });
            for (let i = 10; i < 20; i++) {
                const tx = await storage.getTransactionByTxid(txid(i), false);
                expect(tx.outputs[0].isSpent).toBe(true);
                expect(tx.outputs[0].value).toBe(i);
            }
        });
    });

    describe('getOutputsForTxid', () => {
        it('filters spent outputs from the out: scan', async () => {
            const setup = storage.createBatch();
            storage.saveTransaction(
                setup,
                makeTx(txid(30), [
                    { vout: 0, value: 1 },
                    { vout: 1, value: 2 },
                    { vout: 2, value: 3 },
                ]),
            );
            await setup.commit();

            const spend = storage.createBatch();
            await storage.markOutputsSpent(spend, [[txid(30), 1]]);
            await spend.commit();

            const all = await storage.getTransactionByTxid(txid(30), false);
            expect(all.outputs.map((o) => o.vout)).toEqual([0, 1, 2]);

            const unspent = await storage.getTransactionByTxid(txid(30), true);
            expect(unspent.outputs.map((o) => o.vout)).toEqual([0, 2]);
            expect(unspent.outputs.every((o) => !o.isSpent)).toBe(true);
        });

        it('returns null once every output is spent', async () => {
            const setup = storage.createBatch();
            storage.saveTransaction(
                setup,
                makeTx(txid(31), [{ vout: 0, value: 1 }]),
            );
            await setup.commit();

            const spend = storage.createBatch();
            await storage.markOutputsSpent(spend, [[txid(31), 0]]);
            await spend.commit();

            expect(
                await storage.getTransactionByTxid(txid(31), true),
            ).toBeNull();
        });
    });
});
