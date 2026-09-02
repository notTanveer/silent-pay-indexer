import { ConfigService } from '@nestjs/config';
import { EsploraProvider } from '@/block-data-providers/esplora/provider';

/**
 * A coinbase-only block runs zero batches in processBlock (the loop starts at
 * lastProcessedTxIndex + 1 === txids.length), so the height used to be saved as
 * a silent block and broadcast without ever being marked done — a restart then
 * reprocessed and re-emitted it.
 */
describe('Esplora Provider coinbase-only block', () => {
    it('commits block state for a block with only a coinbase tx', async () => {
        const config = {
            'esplora.batchSize': 10,
            'esplora.url': 'http://localhost:3000',
            'app.network': 'regtest',
            'app.requestRetry': {},
        };

        const saveOperationState = jest.fn();
        const saveBlockState = jest.fn();
        const saveSilentBlock = jest.fn();
        const storageService = {
            saveOperationState,
            saveBlockState,
            saveSilentBlock,
            getTransactionsByBlockHeight: jest.fn().mockResolvedValue([]),
        };
        const emit = jest.fn();

        const provider = new EsploraProvider(
            { get: (k: string) => config[k] } as unknown as ConfigService,
            {} as any,
            {} as any,
            {} as any,
            {
                execute: jest.fn((fn) => fn({} as any)),
            } as any,
            { emit } as any,
            storageService as any,
        );

        jest.spyOn(provider, 'getState').mockResolvedValue({
            currentBlockHeight: 0,
            indexedBlockHeight: 99,
            lastProcessedTxIndex: 0,
        });
        // Only the coinbase tx.
        (provider as any).getTxidsForBlock = jest
            .fn()
            .mockResolvedValue(['cb'.repeat(32)]);

        await (provider as any).processBlock(100, 'hash-100');

        expect(saveSilentBlock).toHaveBeenCalled();
        expect(saveBlockState).toHaveBeenCalledWith(expect.anything(), {
            blockHeight: 100,
            blockHash: 'hash-100',
        });
        expect(saveOperationState).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            expect.objectContaining({
                indexedBlockHeight: 100,
                lastProcessedTxIndex: 0,
            }),
        );
        expect(emit).toHaveBeenCalledWith(expect.any(String), 100);
    });
});
