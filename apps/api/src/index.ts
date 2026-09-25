import './instrument.js'; // ПЕРВЫМ — Sentry.init до Fastify/http/postgres
import * as Sentry from '@sentry/node';
import { buildServer } from './server.js';
import { loadEnv } from './lib/env.js';
import { logger } from './lib/logger.js';
import { installFatalHandlers } from './lib/fatal-visibility.js';

// До buildServer: падение при инициализации плагинов тоже должно быть видно.
installFatalHandlers('api');

/** Если app.close() ждёт SSE/keep-alive — без дедлайна контейнер «running», а порта уже нет. */
const SHUTDOWN_TIMEOUT_MS = 12_000;

async function main() {
  const env = loadEnv();
  const app = await buildServer();

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutdown signal received');
    const forceTimer = setTimeout(() => {
      logger.error(
        { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
        'graceful shutdown timed out — forcing exit',
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    try {
      const server = app.server;
      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await app.close();
      await Sentry.close(2000); // дослать буфер событий до выхода
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'graceful shutdown failed');
      clearTimeout(forceTimer);
      process.exit(1);
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV }, 'api listening');
  } catch (err) {
    logger.error({ err }, 'failed to start');
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal error during bootstrap');
  process.exit(1);
});
