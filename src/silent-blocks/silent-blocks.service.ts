import {
    forwardRef,
    Inject,
    Injectable,
    Logger,
    OnModuleInit,
} from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import { SilentBlocksGateway } from '@/silent-blocks/silent-blocks.gateway';
import { OnEvent } from '@nestjs/event-emitter';
import { INDEXED_BLOCK_EVENT } from '@/common/events';
import { BlockStateService } from '@/block-state/block-state.service';
import { StorageService } from '@/storage/storage.service';
import { DbTransactionService } from '@/db-transaction/db-transaction.service';
import { encodeSilentBlock } from '@/silent-blocks/silent-block-encoder';
import { TransactionData } from '@/storage/interfaces';

// type + varint(0)
const EMPTY_SILENT_BLOCK_LENGTH = 2;

// Heights processed per DB scan inside streamSilentBlocksRange. Small enough that
// the first frame is emitted quickly (low TTFB, keeps the proxy connection warm),
// large enough to amortise the range-scan cost.
const SILENT_BLOCK_STREAM_SUB_BATCH = 20;

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
        @Inject(forwardRef(() => SilentBlocksGateway))
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

        // One height at a time. This used to encode 100 heights, yield, then
        // write them all, so a whole batch of encodings could go stale and
        // clobber writes committed during the yield. Read -> encode -> commit
        // per height keeps that window to a single height, and a height the
        // indexer rewrites underneath us is re-saved by its own processBlock.
        // The explicit yield goes after the commit, so these synchronous scans
        // don't starve the indexer and the HTTP server.
        for (let height = startHeight; height <= tipHeight; height++) {
            const existing = this.storageService.getSilentBlock(height);

            // Gap-fill mode trusts a present blob and skips re-encoding.
            if (!existing || repair) {
                const txs =
                    await this.storageService.getTransactionsByBlockHeight(
                        height,
                        false,
                    );
                const fresh = encodeSilentBlock(txs);

                if (!existing || !existing.equals(fresh)) {
                    await this.dbTransactionService.execute(async (batch) => {
                        this.storageService.saveSilentBlock(
                            batch,
                            height,
                            fresh,
                        );
                    });
                    written++;
                }
            }

            await new Promise((resolve) => setImmediate(resolve));
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
        filterSpent = false,
    ): AsyncGenerator<Buffer> {
        // Emit incrementally in small sub-batches rather than scanning the whole
        // span up front. The first frame leaves the origin after one sub-batch
        // (~tens of ms) instead of after the entire range, which keeps the proxy
        // connection fed (no idle-timeout 502s on filterSpent ranges) and lets the
        // client pipeline against its scan. Frame bytes are identical either way.
        for (
            let batchStart = startHeight;
            batchStart <= endHeight;
            batchStart += SILENT_BLOCK_STREAM_SUB_BATCH
        ) {
            const batchEnd = Math.min(
                batchStart + SILENT_BLOCK_STREAM_SUB_BATCH - 1,
                endHeight,
            );

            // filterSpent=false: serve from blob store, fall back per-height on miss.
            // filterSpent=true:  bulk-fetch the sub-batch's txs in one range scan,
            //                    group by height, encode per block.
            const blobsByHeight = new Map<number, Buffer>();

            if (!filterSpent) {
                const blobs = this.storageService.getSilentBlocksRange(
                    batchStart,
                    batchEnd,
                );
                for (const { height, blob } of blobs) {
                    blobsByHeight.set(height, blob);
                }
            } else {
                const txs =
                    await this.transactionsService.getTransactionsByBlockHeightRange(
                        batchStart,
                        batchEnd,
                        true,
                    );
                // Group transactions by block height
                const txsByHeight = new Map<number, TransactionData[]>();
                for (const tx of txs) {
                    const list = txsByHeight.get(tx.blockHeight) ?? [];
                    list.push(tx);
                    txsByHeight.set(tx.blockHeight, list);
                }
                for (const [height, blockTxs] of txsByHeight) {
                    blobsByHeight.set(height, encodeSilentBlock(blockTxs));
                }
            }

            for (let h = batchStart; h <= batchEnd; h++) {
                let blob = blobsByHeight.get(h);

                if (!blob) {
                    if (filterSpent) {
                        // filterSpent=true: blobsByHeight is built from txsByHeight
                        // which only contains heights with unspent SP outputs. Absent
                        // means nothing to scan — skip the frame entirely.
                        continue;
                    }
                    // filterSpent=false: blob store miss, encode from tx data.
                    blob = encodeSilentBlock(
                        await this.transactionsService.getTransactionByBlockHeight(
                            h,
                            false,
                        ),
                    );
                }

                // The client learns the range was clean from the `synced` ACK.
                if (blob.length <= EMPTY_SILENT_BLOCK_LENGTH) continue;

                const header = Buffer.alloc(8);
                header.writeUInt32BE(h, 0);
                header.writeUInt32BE(blob.length, 4);
                yield Buffer.concat([header, blob]);
            }
        }
    }

    async getLatestIndexedBlockHeight(): Promise<number> {
        const currentBlockState =
            await this.blockStateService.getCurrentBlockState();
        return currentBlockState?.blockHeight ?? 0;
    }
}
