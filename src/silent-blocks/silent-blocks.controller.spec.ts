import { Test, TestingModule } from '@nestjs/testing';
import { CacheModule } from '@nestjs/cache-manager';
import { SilentBlocksController } from '@/silent-blocks/silent-blocks.controller';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';

describe('SilentBlocksController', () => {
    let controller: SilentBlocksController;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            imports: [CacheModule.register()],
            controllers: [SilentBlocksController],
            providers: [
                {
                    provide: SilentBlocksService,
                    useValue: {
                        getSilentBlocksRange: jest.fn(),
                        getSilentBlockByHeight: jest.fn(),
                        getSilentBlockByHash: jest.fn(),
                        getLatestIndexedBlockHeight: jest.fn(),
                    },
                },
            ],
        }).compile();

        controller = module.get<SilentBlocksController>(SilentBlocksController);
    });

    it('should skip throttling on the range endpoint', () => {
        const metadata = Reflect.getMetadata(
            THROTTLER_SKIP + 'default',
            controller.getSilentBlocksRange,
        );
        expect(metadata).toBe(true);
    });
});
