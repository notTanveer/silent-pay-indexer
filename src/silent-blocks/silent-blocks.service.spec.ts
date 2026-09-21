import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { TransactionsService } from '@/transactions/transactions.service';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { silentBlockEncodingFixture } from '@/silent-blocks/silent-blocks.service.fixtures';
import { SilentBlocksGateway } from '@/silent-blocks/silent-blocks.gateway';
import { BlockStateService } from '@/block-state/block-state.service';
import { StorageService } from '@/storage/storage.service';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SilentBlocksService', () => {
    let service: SilentBlocksService;
    let storageService: StorageService;
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-blocks-test-'));

        const module: TestingModule = await Test.createTestingModule({
            imports: [CacheModule.register()],
            providers: [
                SilentBlocksService,
                TransactionsService,
                StorageService,
                {
                    provide: ConfigService,
                    useValue: {
                        get: (key: string) => {
                            if (key === 'db.path') return tmpDir;
                            return null;
                        },
                    },
                },
                {
                    provide: 'BlockDataProvider',
                    useValue: { getTransactionForTweak: jest.fn() },
                },
                {
                    provide: SilentBlocksGateway,
                    useValue: jest.fn(),
                },
                {
                    provide: BlockStateService,
                    useValue: {
                        getCurrentBlockState: jest.fn(),
                    },
                },
            ],
        }).compile();

        storageService = module.get<StorageService>(StorageService);
        await storageService.onModuleInit();
        service = module.get<SilentBlocksService>(SilentBlocksService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it.each(silentBlockEncodingFixture)(
        'should encode a silent block correctly by block height: $blockHeight',
        async ({ transactions, blockHeight, encodedBlockHex }) => {
            // Seed data via StorageService
            const batch = storageService.createBatch();
            for (const tx of transactions) {
                storageService.saveTransaction(batch, {
                    ...tx,
                    outputs: tx.outputs.map((o) => ({
                        ...o,
                        transactionId: tx.id,
                    })),
                });
            }
            await batch.commit();

            const encodedBlock = await service.getSilentBlockByHeight(
                blockHeight,
            );

            expect(encodedBlock.toString('hex')).toEqual(encodedBlockHex);
        },
    );

    it.each(silentBlockEncodingFixture)(
        'should encode a silent block correctly by block hash: $blockHash',
        async ({ transactions, blockHash, encodedBlockHex }) => {
            const batch = storageService.createBatch();
            for (const tx of transactions) {
                storageService.saveTransaction(batch, {
                    ...tx,
                    outputs: tx.outputs.map((o) => ({
                        ...o,
                        transactionId: tx.id,
                    })),
                });
            }
            await batch.commit();

            const encodedBlock = await service.getSilentBlockByHash(blockHash);

            expect(encodedBlock.toString('hex')).toEqual(encodedBlockHex);
        },
    );

    afterEach(async () => {
        await storageService.onModuleDestroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
