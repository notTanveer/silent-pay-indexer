import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from '@/app.service';

@Controller()
export class AppController {
    constructor(private readonly appService: AppService) {}

    // Exempt from rate limiting so uptime probes can never be throttled into a false alarm.
    @SkipThrottle()
    @Get('/health')
    getHealth(): string {
        return this.appService.getHealth();
    }
}
