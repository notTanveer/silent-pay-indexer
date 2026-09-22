import { Module } from '@nestjs/common';
import { IndexerService } from '@/indexer/indexer.service';

@Module({
    controllers: [],
    providers: [IndexerService],
    exports: [IndexerService],
})
export class IndexerModule {}
