import { Injectable } from '@nestjs/common';
import { StorageService } from '@/storage/storage.service';
import { BatchWriter } from '@/storage/batch-writer';

@Injectable()
export class DbTransactionService {
    constructor(private readonly storageService: StorageService) {}

    async execute<T>(
        executable: (batch: BatchWriter) => Promise<T>,
        onCommit?: (ms: number) => void,
    ): Promise<T> {
        const batch = this.storageService.createBatch();
        try {
            const result = await executable(batch);
            const startedAt = process.hrtime.bigint();
            await batch.commit();
            onCommit?.(Number(process.hrtime.bigint() - startedAt) / 1e6);
            return result;
        } finally {
            // Releases any environment the batch still holds. commit() disposes
            // on its own way out and dispose() is idempotent, so this only bites
            // when the callback threw — which is the case that used to leak,
            // since a failed RPC aborts the batch without committing it.
            batch.dispose();
        }
    }
}
