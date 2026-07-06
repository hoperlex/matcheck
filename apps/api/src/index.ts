import './instrument.js'; // ПЕРВЫМ — Sentry.init до Fastify/http/postgres
import * as Sentry from '@sentry/node';
import { buildServer } from './server.js';
import { loadEnv } from './lib/env.js';
import { logger } from './lib/logger.js';

async function main() {
  const env = loadEnv();
  const app = await buildServer();

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutdown signal received');
    try {
      await app.close();
      await Sentry.close(2000); // дослать буфер событий до выхода
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'graceful shutdown failed');
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
