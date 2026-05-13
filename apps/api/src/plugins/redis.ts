import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { loadEnv } from '../lib/env.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async (app) => {
  const env = loadEnv();
  const url = env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

  try {
    await redis.connect();
    app.log.info({ url: url.replace(/:[^:@]*@/, ':***@') }, 'redis connected');
  } catch (err) {
    app.log.warn({ err }, 'redis connection failed — rate limiting and queues disabled');
  }

  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    try {
      await redis.quit();
    } catch {
      /* ignore */
    }
  });
});
