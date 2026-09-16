import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

declare const module: any;

async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
    app.useWebSocketAdapter(new WsAdapter(app));

    const configService = app.get<ConfigService>(ConfigService);
    const port = configService.get<number>('app.port');
    const host = configService.get<string>('app.host') ?? '0.0.0.0';

    // Behind a same-host reverse proxy the socket address is always 127.0.0.1, which would
    // collapse every client into a single rate-limit bucket. Trusting only loopback makes
    // `req.ip` resolve to the right-most untrusted X-Forwarded-For entry — the real client —
    // without letting a client spoof it by sending its own header.
    app.set('trust proxy', 'loopback');

    app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

    await app.listen(port, host);

    if (module.hot) {
        module.hot.accept();
        module.hot.dispose(() => app.close());
    }
}
bootstrap();
