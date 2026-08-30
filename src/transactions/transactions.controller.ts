import { CacheInterceptor } from '@nestjs/cache-manager';
import {
    Controller,
    Get,
    NotFoundException,
    Param,
    ParseBoolPipe,
    ParseIntPipe,
    Query,
    UseInterceptors,
} from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import { MAX_BLOCK_RANGE } from '@/common/constants';
import { assertHeightRange } from '@/common/common';

@Controller('transactions')
export class TransactionController {
    constructor(private readonly transactionsService: TransactionsService) {}

    @Get('height/:height')
    @UseInterceptors(CacheInterceptor)
    async getTransactionByBlockHeight(
        @Param('height') blockHeight: number,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        const transactions =
            await this.transactionsService.getTransactionByBlockHeight(
                blockHeight,
                filterSpent,
            );

        return { transactions: transactions };
    }

    @Get('range')
    @UseInterceptors(CacheInterceptor)
    async getTransactionsByBlockHeightRange(
        @Query('startHeight', ParseIntPipe) startHeight: number,
        @Query('endHeight', ParseIntPipe) endHeight: number,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        assertHeightRange(startHeight, endHeight, MAX_BLOCK_RANGE);

        const transactions =
            await this.transactionsService.getTransactionsByBlockHeightRange(
                startHeight,
                endHeight,
                filterSpent,
            );

        return { transactions: transactions };
    }

    @Get('hash/:hash')
    @UseInterceptors(CacheInterceptor)
    async getTransactionByBlockHash(
        @Param('hash') blockHash: string,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        const transactions =
            await this.transactionsService.getTransactionByBlockHash(
                blockHash,
                filterSpent,
            );

        return { transactions: transactions };
    }

    @Get('timestamp-to-height')
    @UseInterceptors(CacheInterceptor)
    async getBlockHeightByTimestamp(
        @Query('timestamp', ParseIntPipe) timestamp: number,
    ) {
        return await this.transactionsService.getBlockHeightByTimestamp(
            timestamp,
        );
    }

    @Get('txid/:txid')
    @UseInterceptors(CacheInterceptor)
    async getTransactionByTxid(
        @Param('txid') txid: string,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        const transaction = await this.transactionsService.getTransactionByTxid(
            txid,
            filterSpent,
        );
        if (!transaction) {
            throw new NotFoundException(
                `Transaction with txid ${txid} not found`,
            );
        }
        return { transaction: transaction };
    }
}
