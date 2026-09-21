import { Injectable } from '@nestjs/common';
import { StorageService } from '@/storage/storage.service';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { BlockStateData } from '@/storage/interfaces';

@Injectable()
export class BlockStateService {
    constructor(
        private readonly storageService: StorageService,
        private readonly dbTransactionService: DbTransactionService,
    ) {}

    async getCurrentBlockState(): Promise<BlockStateData> {
        return this.storageService.getCurrentBlockState();
    }

    async removeState(state: BlockStateData): Promise<void> {
        // Routed through DbTransactionService so the batch is disposed even if
        // this throws; a batch that keeps its lease would pin an environment
        // against eviction forever.
        await this.dbTransactionService.execute(async (batch) => {
            await this.storageService.deleteTransactionsAtBlockHash(
                batch,
                state.blockHash,
            );
            this.storageService.deleteBlockState(batch, state.blockHeight);
        });
    }
}
