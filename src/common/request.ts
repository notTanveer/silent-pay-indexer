import { Logger } from '@nestjs/common';
import { AxiosError, AxiosRequestConfig } from 'axios';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';

/** Provider requests slower than this (ms) are logged at debug for triage. */
const SLOW_REQUEST_THRESHOLD_MS = 250;

/**
 * Bitcoin Core drops idle RPC connections after -rpcservertimeout (30s by
 * default). Retire pooled sockets before it does, so we don't write to a
 * half-closed one and take EPIPE/ECONNRESET on the next request.
 *
 * Note this is a socket timeout, so it also caps a single in-flight request;
 * 20s leaves ample headroom over a verbosity-3 getblock (~2-4s), and the retry
 * below covers the rare loser. It is a timer, so it cannot fire while the event
 * loop is blocked -- keeping the indexing phases short is the real guard.
 */
const KEEP_ALIVE_TIMEOUT_MS = 20_000;

const httpAgent = new http.Agent({
    keepAlive: true,
    timeout: KEEP_ALIVE_TIMEOUT_MS,
});
const httpsAgent = new https.Agent({
    keepAlive: true,
    timeout: KEEP_ALIVE_TIMEOUT_MS,
});

const axiosStatus = (error: AxiosError) => error.status || error.code;

/** Request config safe to log: strips the RPC credentials. */
const redactConfig = (config: AxiosRequestConfig) => ({
    ...config,
    auth: config.auth
        ? { username: config.auth.username, password: '[REDACTED]' }
        : undefined,
});

const axiosErrorResponse = (error: AxiosError) =>
    error.response?.data || error.message;

const exponentialDelay = (
    retryNumber: number,
    retryConfig: AxiosRetryConfig,
): Promise<void> => {
    const delay = 2 ** retryNumber * retryConfig.delay;
    const randomSum = delay * 0.2 * Math.random(); // 0-20% of the delay
    const totalDelay = delay + randomSum;

    return new Promise((resolve) => setTimeout(resolve, totalDelay));
};

export const makeRequest = async (
    requestConfig: AxiosRequestConfig,
    retryConfig: AxiosRetryConfig,
    logger: Logger,
) => {
    for (let count = 1; count <= retryConfig.count; count++) {
        try {
            const startedAt = process.hrtime.bigint();
            const response = await axios.request({
                httpAgent,
                httpsAgent,
                ...requestConfig,
            });
            const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

            if (elapsedMs > SLOW_REQUEST_THRESHOLD_MS) {
                const method = (requestConfig.data as { method?: string })
                    ?.method;
                logger.debug(
                    `Slow provider request: method=${method ?? 'unknown'} ` +
                        `elapsed=${Math.round(elapsedMs)}ms`,
                );
            }

            // Deliberately does not serialise the response: a verbosity-3
            // getblock is multi-MB, and the template literal is built eagerly
            // regardless of whether the verbose level is enabled.
            logger.verbose(
                `Request to Provider succeeded: method=${
                    (requestConfig.data as { method?: string })?.method ??
                    'unknown'
                } elapsed=${Math.round(elapsedMs)}ms`,
            );

            return response.data;
        } catch (error) {
            if (!isNetworkError(error)) throw error;

            if (count === retryConfig.count) {
                logger.error(
                    `Request to Provider failed! after ${count} number of retries\n` +
                        `Status code ${axiosStatus(error)}\n` +
                        `Response:${JSON.stringify(axiosErrorResponse(error))}`,
                );
                throw error;
            }

            if (error instanceof AxiosError) {
                logger.error(
                    `Retrying Request to Provider with retry count: ${count}\n` +
                        `Status code: ${axiosStatus(error)}\n` +
                        `Request:${JSON.stringify(
                            redactConfig(requestConfig),
                        )}`,
                );

                await exponentialDelay(count, retryConfig);

                continue;
            }

            if (error instanceof AggregateError) {
                logger.error(
                    `Aggregate Error encountered: ${error.message}`,
                    error.stack,
                );

                for (const cause of error.errors) {
                    logger.error(`Cause: ${cause.message}`, cause.stack);
                }

                throw error;
            }

            logger.error(`unknown error encountered ${error}`);
            throw error;
        }
    }
};

/**
 * Transport-level failures worth retrying: no HTTP response came back.
 *
 * Note ECONNABORTED is excluded, which is the code axios uses for its own
 * request timeout. No `timeout` is set on our requests today; if one is ever
 * added, update this predicate at the same time or those timeouts will silently
 * become non-retryable.
 */
export const isNetworkError = (error) => {
    return !(
        error.response ||
        !error.code ||
        ['ERR_CANCELED', 'ECONNABORTED'].includes(error.code)
    );
};

export interface AxiosRetryConfig {
    count: number;
    delay: number;
}
