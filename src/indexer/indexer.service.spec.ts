import { Test, TestingModule } from '@nestjs/testing';
import { IndexerService } from '@/indexer/indexer.service';
import { testData } from '@/indexer/indexer.fixture';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { StorageService } from '@/storage/storage.service';
import { PartitionManager } from '@/storage/partition-manager';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('IndexerService', () => {
    let service: IndexerService;
    let storageService: StorageService;
    let partitions: PartitionManager;
    let dbTransactionService: DbTransactionService;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'indexer-test-'));

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                IndexerService,
                DbTransactionService,
                StorageService,
                PartitionManager,
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) => {
                            if (key === 'db.path') return tmpDir;
                            // Small partitions so tests cross boundaries.
                            if (key === 'db.partitionBlocks') return 5;
                            if (key === 'db.partitionMapSize')
                                return 16 * 1024 * 1024;
                            if (key === 'db.mapSize') return 16 * 1024 * 1024;
                            if (key === 'db.openPartitions') return 2;
                            return null;
                        },
                    },
                },
            ],
        }).compile();

        partitions = module.get<PartitionManager>(PartitionManager);
        partitions.onModuleInit();
        storageService = module.get<StorageService>(StorageService);

        service = module.get<IndexerService>(IndexerService);
        dbTransactionService =
            module.get<DbTransactionService>(DbTransactionService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it.each(testData)(
        'should validate that scanTweaks are created for only valid transactions',
        async (transaction) => {
            await dbTransactionService.execute(async (batch) => {
                await service.index(
                    transaction.txid,
                    transaction.vin,
                    transaction.vout,
                    0,
                    '0000000000000000000000000000000000000000000000000000000000000000',
                    0,
                    batch,
                );
            });

            // The fixture indexes everything at height 0.
            const indexed = await storageService.getTransactionsByBlockHeight(
                0,
            );
            const transactionEntity =
                indexed.find((tx) => tx.id === transaction.txid) ?? null;

            if (transaction.scanTweak) {
                expect(transactionEntity.scanTweak).toBe(transaction.scanTweak);
            } else {
                expect(transactionEntity).toBeNull();
            }
        },
    );

    afterEach(async () => {
        await partitions.onModuleDestroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
