import { Global, Module } from '@nestjs/common';
import { StorageService } from '@/storage/storage.service';
import { PartitionManager } from '@/storage/partition-manager';

@Global()
@Module({
    providers: [PartitionManager, StorageService],
    exports: [PartitionManager, StorageService],
})
export class StorageModule {}
