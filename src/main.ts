import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

declare const module: any;

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    // The app runs behind Nginx/Cloudflare in production.
    // Trusting proxy headers preserves real client IPs.
    app.getHttpAdapter().getInstance().set('trust proxy', true);
    app.useWebSocketAdapter(new WsAdapter(app));

    const configService = app.get<ConfigService>(ConfigService);
    const port = configService.get<number>('app.port');

    app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

    await app.listen(port);

    if (module.hot) {
        module.hot.accept();
        module.hot.dispose(() => app.close());
    }
}
bootstrap();
