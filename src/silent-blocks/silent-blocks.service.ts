import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import { SilentBlocksGateway } from '@/silent-blocks/silent-blocks.gateway';
import { OnEvent } from '@nestjs/event-emitter';
import { INDEXED_BLOCK_EVENT } from '@/common/events';
import { BlockStateService } from '@/block-state/block-state.service';
import { StorageService } from '@/storage/storage.service';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { encodeSilentBlock } from '@/silent-blocks/silent-block-encoder';

const BACKFILL_BATCH_SIZE = 100;

@Injectable()
export class SilentBlocksService implements OnModuleInit {
    private readonly logger = new Logger(SilentBlocksService.name);

    constructor(
        private readonly transactionsService: TransactionsService,
        private readonly silentBlocksGateway: SilentBlocksGateway,
        private readonly blockStateService: BlockStateService,
        private readonly storageService: StorageService,
        private readonly dbTransactionService: DbTransactionService,
    ) {}

    onModuleInit() {
        this.backfillSilentBlocks().catch((err) =>
            this.logger.error(`Silent block backfill failed: ${err.message}`),
        );
    }

    private async backfillSilentBlocks(): Promise<void> {
        const tip = await this.blockStateService.getCurrentBlockState();
        if (!tip) return;

        const startHeight = this.storageService.getLowestBlockStateHeight();
        if (startHeight === null) return;

        const tipHeight = tip.blockHeight;
        let missing = 0;

        for (let h = startHeight; h <= tipHeight; h += BACKFILL_BATCH_SIZE) {
            const batchEnd = Math.min(h + BACKFILL_BATCH_SIZE - 1, tipHeight);
            const existingBlobs = this.storageService.getSilentBlocksRange(
                h,
                batchEnd,
            );
            const existingHeights = new Set(existingBlobs.map((b) => b.height));

            const missingHeights: number[] = [];
            for (let height = h; height <= batchEnd; height++) {
                if (!existingHeights.has(height)) missingHeights.push(height);
            }

            if (missingHeights.length === 0) continue;

            await this.dbTransactionService.execute(async (batch) => {
                for (const height of missingHeights) {
                    const txs =
                        await this.storageService.getTransactionsByBlockHeight(
                            height,
                            false,
                        );
                    this.storageService.saveSilentBlock(
                        batch,
                        height,
                        encodeSilentBlock(txs),
                    );
                    missing++;
                }
            });
        }

        if (missing > 0) {
            this.logger.log(
                `Silent block backfill complete: ${missing} blobs written`,
            );
        }
    }

    @OnEvent(INDEXED_BLOCK_EVENT)
    async handleBlockIndexedEvent(blockHeight: number) {
        this.logger.debug(`New block indexed: ${blockHeight}`);
        const silentBlock = await this.getSilentBlockByHeight(
            blockHeight,
            false,
        );
        this.silentBlocksGateway.broadcastSilentBlock(silentBlock);
    }

    async getSilentBlockByHeight(
        blockHeight: number,
        filterSpent: boolean,
    ): Promise<Buffer> {
        if (!filterSpent) {
            const blob = this.storageService.getSilentBlock(blockHeight);
            if (blob) return blob;
        }

        const transactions =
            await this.transactionsService.getTransactionByBlockHeight(
                blockHeight,
                filterSpent,
            );

        return encodeSilentBlock(transactions);
    }

    async getSilentBlockByHash(
        blockHash: string,
        filterSpent: boolean,
    ): Promise<Buffer> {
        const transactions =
            await this.transactionsService.getTransactionByBlockHash(
                blockHash,
                filterSpent,
            );

        return encodeSilentBlock(transactions);
    }

    /**
     * Returns a framed binary buffer containing silent blocks for each height in
     * [startHeight, endHeight]. Each frame: height (4B BE) | byteLength (4B BE) | silentBlockBytes.
     */
    async getSilentBlocksRange(
        startHeight: number,
        endHeight: number,
    ): Promise<Buffer> {
        const blobs = this.storageService.getSilentBlocksRange(
            startHeight,
            endHeight,
        );

        const blobsByHeight = new Map(blobs.map((b) => [b.height, b.blob]));
        const frames: Buffer[] = [];

        for (let h = startHeight; h <= endHeight; h++) {
            const blob =
                blobsByHeight.get(h) ??
                (await this.getSilentBlockByHeight(h, false));
            const header = Buffer.alloc(8);
            header.writeUInt32BE(h, 0);
            header.writeUInt32BE(blob.length, 4);
            frames.push(header, blob);
        }

        return Buffer.concat(frames);
    }

    async getLatestIndexedBlockHeight(): Promise<number> {
        const currentBlockState =
            await this.blockStateService.getCurrentBlockState();
        return currentBlockState?.blockHeight ?? 0;
    }
}
