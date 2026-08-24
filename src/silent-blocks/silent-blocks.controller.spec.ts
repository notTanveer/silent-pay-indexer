import { Test, TestingModule } from '@nestjs/testing';
import { CacheInterceptor, CacheModule } from '@nestjs/cache-manager';
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
                        streamSilentBlocksRange: jest.fn(),
                        getSilentBlockByHeight: jest.fn(),
                        getSilentBlockByHash: jest.fn(),
                        getLatestIndexedBlockHeight: jest.fn(),
                    },
                },
            ],
        }).compile();

        controller = module.get<SilentBlocksController>(SilentBlocksController);
    });

    it('should throttle the range endpoint', () => {
        const metadata = Reflect.getMetadata(
            THROTTLER_SKIP + 'default',
            controller.getSilentBlocksRange,
        );
        expect(metadata).toBeUndefined();
    });

    it('should NOT have CacheInterceptor on getSilentBlockByHeight', () => {
        const interceptors = Reflect.getMetadata(
            '__interceptors__',
            controller.getSilentBlockByHeight,
        );
        const hasCacheInterceptor = (interceptors ?? []).some(
            (i: any) =>
                i === CacheInterceptor || i?.name === 'CacheInterceptor',
        );
        expect(hasCacheInterceptor).toBe(false);
    });

    it('should NOT have CacheInterceptor on getSilentBlockByHash', () => {
        const interceptors = Reflect.getMetadata(
            '__interceptors__',
            controller.getSilentBlockByHash,
        );
        const hasCacheInterceptor = (interceptors ?? []).some(
            (i: any) =>
                i === CacheInterceptor || i?.name === 'CacheInterceptor',
        );
        expect(hasCacheInterceptor).toBe(false);
    });
});
