import { Module } from '@nestjs/common';
import { BlockStateService } from '@/block-state/block-state.service';
import { DbTransactionModule } from '@/db-transaction/db-transaction.module';

@Module({
    imports: [DbTransactionModule],
    providers: [BlockStateService],
    exports: [BlockStateService],
})
export class BlockStateModule {}
