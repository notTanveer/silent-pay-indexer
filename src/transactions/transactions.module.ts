import { Module } from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import { TransactionController } from '@/transactions/transactions.controller';
import { BlockProviderModule } from '@/block-data-providers/block-provider.module';

@Module({
    imports: [BlockProviderModule],
    controllers: [TransactionController],
    providers: [TransactionsService],
    exports: [TransactionsService],
})
export class TransactionsModule {}
