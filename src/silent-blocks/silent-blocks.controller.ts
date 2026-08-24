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
import { Response } from 'express';
import { SilentBlocksService } from '@/silent-blocks/silent-blocks.service';
import { MAX_SILENT_BLOCK_RANGE } from '@/common/constants';

const CACHE_CONFIRMATION_DEPTH = 6;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

const drained = (res: Response): Promise<void> =>
    new Promise((resolve) => {
        const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
        };
        res.once('drain', done);
        res.once('close', done);
    });

@Controller('silent-block')
export class SilentBlocksController {
    constructor(private readonly silentBlocksService: SilentBlocksService) {}

    @Get('height/:height')
    async getSilentBlockByHeight(
        @Param('height', ParseIntPipe) blockHeight: number,
        @Res() res: Response,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        const buffer = await this.silentBlocksService.getSilentBlockByHeight(
            blockHeight,
            filterSpent,
        );

        const latestHeight =
            await this.silentBlocksService.getLatestIndexedBlockHeight();
        const cacheable =
            !filterSpent &&
            blockHeight <= latestHeight - CACHE_CONFIRMATION_DEPTH;

        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': buffer.length,
            'Cache-Control': cacheable ? IMMUTABLE : NO_STORE,
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
            // Depth is unknowable from a hash, so bound staleness instead.
            'Cache-Control': filterSpent ? NO_STORE : 'public, max-age=60',
        });
        res.send(buffer);
    }

    @Get('range')
    async getSilentBlocksRange(
        @Query('startHeight', ParseIntPipe) startHeight: number,
        @Query('endHeight', ParseIntPipe) endHeight: number,
        @Res() res: Response,
        @Query('filterSpent', new ParseBoolPipe({ optional: true }))
        filterSpent = false,
    ) {
        if (startHeight < 0) {
            throw new BadRequestException('startHeight must be >= 0');
        }
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
            !filterSpent &&
            endHeight <= latestHeight - CACHE_CONFIRMATION_DEPTH;
        res.set({
            'Content-Type': 'application/octet-stream',
            'Cache-Control': isDeepRange ? IMMUTABLE : NO_STORE,
        });

        for await (const frame of this.silentBlocksService.streamSilentBlocksRange(
            startHeight,
            endHeight,
            filterSpent,
        )) {
            if (res.closed || res.destroyed) return;
            if (!res.write(frame)) {
                await drained(res);
            }
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
