import { CacheInterceptor } from '@nestjs/cache-manager';
import {
    BadRequestException,
    Controller,
    Get,
    Param,
    ParseBoolPipe,
    ParseIntPipe,
    Query,
    Res,
    UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { MAX_SILENT_BLOCK_RANGE } from '@/common/constants';

@Controller('silent-block')
export class SilentBlocksController {
    constructor(private readonly silentBlocksService: SilentBlocksService) {}

    @Get('height/:height')
    async getSilentBlockByHeight(
        @Param('height') blockHeight: number,
        @Res() res: Response,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        const buffer = await this.silentBlocksService.getSilentBlockByHeight(
            blockHeight,
            filterSpent,
        );

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length,
            'Cache-Control': filterSpent
                ? 'no-store'
                : 'public, max-age=31536000, immutable',
        });
        res.send(buffer);
    }

    @Get('hash/:hash')
    async getSilentBlockByHash(
        @Param('hash') blockHash: string,
        @Res() res: Response,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        const buffer = await this.silentBlocksService.getSilentBlockByHash(
            blockHash,
            filterSpent,
        );

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length,
            'Cache-Control': filterSpent
                ? 'no-store'
                : 'public, max-age=31536000, immutable',
        });
        res.send(buffer);
    }

    @SkipThrottle()
    @Get('range')
    async getSilentBlocksRange(
        @Query('startHeight', ParseIntPipe) startHeight: number,
        @Query('endHeight', ParseIntPipe) endHeight: number,
        @Res() res: Response,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        if (endHeight < startHeight) {
            throw new BadRequestException('endHeight must be >= startHeight');
        }
        if (endHeight - startHeight + 1 > MAX_SILENT_BLOCK_RANGE) {
            throw new BadRequestException(
                `Range exceeds maximum of ${MAX_SILENT_BLOCK_RANGE} blocks`,
            );
        }

        const latestHeight =
            await this.silentBlocksService.getLatestIndexedBlockHeight();

        // filterSpent responses are always live — never cache them
        const isDeepRange =
            !filterSpent && endHeight <= latestHeight - 6;
        res.set({
            'Content-Type': 'application/octet-stream',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': isDeepRange
                ? 'public, max-age=31536000, immutable'
                : 'no-store',
        });

        for await (const frame of this.silentBlocksService.streamSilentBlocksRange(
            startHeight,
            endHeight,
            filterSpent,
        )) {
            res.write(frame);
        }
        res.end();
    }

    @Get('latest-height')
    @UseInterceptors(CacheInterceptor)
    async getLatestIndexedBlockHeight() {
        const height =
            await this.silentBlocksService.getLatestIndexedBlockHeight();
        return { height };
    }
}
