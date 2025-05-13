import { INestApplication, Logger } from '@nestjs/common';
import { AppModule } from '@/app.module';
import * as Docker from 'dockerode';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { BitcoinRPCUtil } from '@e2e/helpers/rpc.helper';
import { FileLogger } from '@e2e/file-logger';

async function startBitcoinD(
    configPath = './config/e2e.config.yaml',
): Promise<Docker.Container> {
    const logger = new Logger('Bitcoind');
    let container: Docker.Container;

    const config = yaml.load(readFileSync(configPath, 'utf8')) as Record<string, any>;

    const user = config.bitcoinCore.rpcUser;
    const password = config.bitcoinCore.rpcPass;
    const network = config.app.network;
    const port = config.bitcoinCore.rpcPort;

    try {
        const docker = new Docker();
        const imageName = 'btcpayserver/bitcoin:24.0.1-1';
        const LABEL = 'e2e-test=bitcoind'; // Label to identify test containers

        // Check for existing containers with the same label, image, port, and config
        const containers = await docker.listContainers({ 
            all: true,
            filters: { label: [LABEL] }
        });

        let existingContainer: Docker.Container | null = null;

        for (const containerInfo of containers) {
            if (containerInfo.Image !== imageName) continue;

            const portMapped = containerInfo.Ports.some(p => p.PublicPort === port);
            if (!portMapped) continue;

            const container = docker.getContainer(containerInfo.Id);
            const details = await container.inspect();
            const env = details.Config.Env;

            // Check BITCOIN_NETWORK
            const networkVar = env.find(e => e.startsWith('BITCOIN_NETWORK='));
            const existingNetwork = networkVar ? networkVar.split('=')[1] : null;
            if (existingNetwork !== network) continue;

            // Check BITCOIN_EXTRA_ARGS for rpcuser and rpcpassword
            const extraArgsVar = env.find(e => e.startsWith('BITCOIN_EXTRA_ARGS='));
            if (!extraArgsVar) continue;

            const extraArgs = extraArgsVar.split('=')[1].replace(/\n/g, ' ');
            const argsArray = extraArgs.split(' ');
            const rpcUser = argsArray.find(arg => arg.startsWith('rpcuser='))?.split('=')[1];
            const rpcPass = argsArray.find(arg => arg.startsWith('rpcpassword='))?.split('=')[1];

            if (rpcUser !== user || rpcPass !== password) continue;

            existingContainer = container;
            break;
        }

        if (existingContainer) {
            const details = await existingContainer.inspect();
            if (details.State.Running) {
                logger.log(`Reusing existing running container ${existingContainer.id}`);
            } else {
                logger.log(`Starting existing stopped container ${existingContainer.id}`);
                await existingContainer.start();
            }
            // Pipe logs even if reusing container
            const logs = await existingContainer.logs({
                follow: true,
                stdout: true,
                stderr: true,
            });
            logs.pipe(new FileLogger('bitcoind').getWriteStream());
            return existingContainer;
        }

        // Remove any other conflicting containers with the same label and port
        const conflictingContainers = containers.filter(containerInfo => 
            containerInfo.Ports.some(p => p.PublicPort === port)
        );

        for (const containerInfo of conflictingContainers) {
            const container = docker.getContainer(containerInfo.Id);
            logger.log(`Removing conflicting container ${containerInfo.Id} on port ${port}`);
            await container.remove({ force: true, v: true });
        }

        // Pull image if not exists
        const images = await docker.listImages();
        const imageExists = images.some(image => 
            image.RepoTags?.includes(imageName)
        );

        if (!imageExists) {
            logger.log(`Pulling image ${imageName}`);
            await new Promise((resolve, reject) => {
                docker.pull(imageName, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, (err, res) => 
                        err ? reject(err) : resolve(res)
                    );
                });
            });
        }

        // Create and start new container
        container = await docker.createContainer({
            Image: imageName,
            Labels: { 'e2e-test': 'bitcoind' },
            ExposedPorts: { [`${port}/tcp`]: {} },
            HostConfig: {
                PortBindings: {
                    [`${port}/tcp`]: [{ HostPort: `${port}` }]
                }
            },
            Env: [
                `BITCOIN_NETWORK=${network}`,
                `BITCOIN_EXTRA_ARGS=server=1\nrest=1\nrpcbind=0.0.0.0:${port}\n` +
                `rpcallowip=0.0.0.0/0\nrpcuser=${user}\nrpcpassword=${password}\n` +
                `debug=0\nlogips=1\nlogtimemicros=1\nblockmintxfee=0\n` +
                `deprecatedrpc=signrawtransaction\nlistenonion=0\nfallbackfee=0.00001\ntxindex=1`
            ]
        });

        logger.log('Starting bitcoind container...');
        await container.start();

        // Pipe logs
        const logs = await container.logs({ follow: true, stdout: true, stderr: true });
        logs.pipe(new FileLogger('bitcoind').getWriteStream());

        return container;
    } catch (error) {
        logger.error('Error starting bitcoind container:', error);
        if (container) {
            await container.remove({ v: true, force: true }).catch(e => logger.error(e));
        }
        throw error;
    }
}

async function setupTestApp(): Promise<INestApplication> {
    const bitcoinRpc = new BitcoinRPCUtil();
    await bitcoinRpc.waitForBitcoind();

    new Logger('Indexer').log('Starting Indexer...');
    const app = await NestFactory.create(AppModule, {
        logger: new FileLogger('indexer'),
    });

    const configService = app.get<ConfigService>(ConfigService);
    const port = configService.get<number>('app.port');

    await app.listen(port);

    return app;
}

export async function initialiseDep() {
    const bitcoind = await startBitcoinD();
    const app = await setupTestApp();

    return async function shutdownDep() {
        await app.close();
        await bitcoind.stop();
        await bitcoind.remove({ v: true, force: true });
    };
}
