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

// Operation-state id + version gating the one-time repair pass. Bump the
// version whenever a fix to the silent block encoding requires existing
// blobs to be rewritten from canonical tx data.
const SILENT_BLOCK_REPAIR_STATE = 'silent-block-repair';
const SILENT_BLOCK_REPAIR_VERSION = 1;

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

        // In repair mode every height is re-encoded from canonical tx data and
        // compared against the stored blob, so blobs corrupted by an older
        // encoder are rewritten. Otherwise we only fill missing heights (cheap:
        // trust existing blobs without re-reading tx data). The pass runs once
        // per version, gated by an operation-state marker.
        const repairState = await this.storageService.getOperationState(
            SILENT_BLOCK_REPAIR_STATE,
        );
        const repair =
            (repairState?.state?.version ?? 0) < SILENT_BLOCK_REPAIR_VERSION;

        let written = 0;

        for (let h = startHeight; h <= tipHeight; h += BACKFILL_BATCH_SIZE) {
            const batchEnd = Math.min(h + BACKFILL_BATCH_SIZE - 1, tipHeight);
            const existingBlobs = this.storageService.getSilentBlocksRange(
                h,
                batchEnd,
            );
            const existingByHeight = new Map(
                existingBlobs.map((b) => [b.height, b.blob]),
            );

            const pending: { height: number; blob: Buffer }[] = [];
            for (let height = h; height <= batchEnd; height++) {
                const existing = existingByHeight.get(height);

                // Gap-fill mode trusts a present blob and skips re-encoding.
                if (existing && !repair) continue;

                const txs =
                    await this.storageService.getTransactionsByBlockHeight(
                        height,
                        false,
                    );
                const fresh = encodeSilentBlock(txs);

                if (!existing || !existing.equals(fresh)) {
                    pending.push({ height, blob: fresh });
                }
            }

            if (pending.length === 0) continue;

            await this.dbTransactionService.execute(async (batch) => {
                for (const { height, blob } of pending) {
                    this.storageService.saveSilentBlock(batch, height, blob);
                    written++;
                }
            });
        }

        // Mark the repair done only after a full successful pass; a crash
        // mid-repair leaves the marker unset so it re-runs (idempotent).
        if (repair) {
            const batch = this.storageService.createBatch();
            this.storageService.saveOperationState(
                batch,
                SILENT_BLOCK_REPAIR_STATE,
                { version: SILENT_BLOCK_REPAIR_VERSION },
            );
            await batch.commit();
        }

        if (written > 0) {
            this.logger.log(
                `Silent block backfill complete: ${written} blobs ${
                    repair ? 'written/repaired' : 'written'
                }`,
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

    async *streamSilentBlocksRange(
        startHeight: number,
        endHeight: number,
    ): AsyncGenerator<Buffer> {
        const blobs = this.storageService.getSilentBlocksRange(
            startHeight,
            endHeight,
        );

        const blobsByHeight = new Map(blobs.map((b) => [b.height, b.blob]));

        for (let h = startHeight; h <= endHeight; h++) {
            const blob =
                blobsByHeight.get(h) ??
                (await this.getSilentBlockByHeight(h, false));
            const header = Buffer.alloc(8);
            header.writeUInt32BE(h, 0);
            header.writeUInt32BE(blob.length, 4);
            yield Buffer.concat([header, blob]);
        }
    }

    async getLatestIndexedBlockHeight(): Promise<number> {
        const currentBlockState =
            await this.blockStateService.getCurrentBlockState();
        return currentBlockState?.blockHeight ?? 0;
    }
}
