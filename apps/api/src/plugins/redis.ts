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

  // Слушатель ставится ДО connect(): 'error' у EventEmitter без единого
  // подписчика роняет процесс, а ioredis эмитит его при каждом обрыве связи —
  // не только на старте. Обработчик Redis не чинит: он лишь переводит сбой
  // соединения из «падение API» в «строка в логе». Деградация уже описана —
  // rate-limit работает со skipOnError, постановка задач в очередь честно
  // вернёт ошибку запроса.
  redis.on('error', (err) => {
    app.log.error({ err, event: 'redis_error' }, 'redis connection error');
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
