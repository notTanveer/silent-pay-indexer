import { CacheInterceptor } from '@nestjs/cache-manager';
import {
    BadRequestException,
    Controller,
    Get,
    NotFoundException,
    Param,
    ParseIntPipe,
    Query,
    UseInterceptors,
} from '@nestjs/common';
import { TransactionsService } from '@/transactions/transactions.service';
import { MAX_BLOCK_RANGE } from '@/common/constants';

@Controller('transactions')
export class TransactionController {
    constructor(private readonly transactionsService: TransactionsService) {}

    @Get('height/:height')
    @UseInterceptors(CacheInterceptor)
    async getTransactionByBlockHeight(
        @Param('height', ParseIntPipe) blockHeight: number,
    ) {
        const transactions =
            await this.transactionsService.getTransactionByBlockHeight(
                blockHeight,
            );

        return { transactions: transactions };
    }

    @Get('range')
    @UseInterceptors(CacheInterceptor)
    async getTransactionsByBlockHeightRange(
        @Query('startHeight', ParseIntPipe) startHeight: number,
        @Query('endHeight', ParseIntPipe) endHeight: number,
    ) {
        if (startHeight < 0 || endHeight < 0) {
            throw new BadRequestException('Block heights must be non-negative');
        }

        if (startHeight > endHeight) {
            throw new BadRequestException(
                'startHeight must be less than or equal to endHeight',
            );
        }

        if (endHeight - startHeight + 1 > MAX_BLOCK_RANGE) {
            throw new BadRequestException(
                `Range too large. Maximum allowed range is ${MAX_BLOCK_RANGE} blocks`,
            );
        }

        const transactions =
            await this.transactionsService.getTransactionsByBlockHeightRange(
                startHeight,
                endHeight,
            );

        return { transactions: transactions };
    }

    @Get('hash/:hash')
    @UseInterceptors(CacheInterceptor)
    async getTransactionByBlockHash(@Param('hash') blockHash: string) {
        const transactions =
            await this.transactionsService.getTransactionByBlockHash(blockHash);

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
    async getTransactionByTxid(@Param('txid') txid: string) {
        const transaction = await this.transactionsService.getTransactionByTxid(
            txid,
        );
        if (!transaction) {
            throw new NotFoundException(
                `Transaction with txid ${txid} not found`,
            );
        }
        return { transaction: transaction };
    }
}
