// Межпроцессный мост SSE-событий через Redis Pub/Sub.
//
// Проблема: события `*_updated` живут в in-process EventEmitter
// (см. apps/api/src/routes/events.ts), а тяжёлая работа (LLM-парсинг УПД)
// идёт в отдельном процессе matcheck-worker. Без моста worker не может
// уведомить подключённых к API SSE-клиентов о том, что УПД распарсилась —
// мобильный клиент узнавал об этом только через 15-минутный periodic sync.
//
// Решение: worker публикует событие в Redis-канал, API подписан на тот же
// канал и при получении эмитит локально в bus (его уже слушают SSE-listeners
// в /api/v1/events). Канал общий — один для всех типов событий.
//
// Fallback: если Redis недоступен, publish тихо игнорируется, subscribe
// логирует предупреждение. Старое поведение (только in-process events
// из API-ручек) продолжит работать; мобила вернётся к периодическому sync.
//
// Важно: subscribe-соединение в ioredis должно быть ОТДЕЛЬНЫМ — после
// SUBSCRIBE на этом сокете нельзя выполнять обычные команды.

import { Redis } from 'ioredis';
import type { SseEvent } from '@matcheck/contracts';
import { loadEnv } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';

const CHANNEL = 'matcheck:sse';

let publisher: Redis | null = null;

/**
 * Публикует SSE-событие в Redis-канал. Создаёт отдельный publisher при
 * первом вызове (lazy). Безопасно для worker'а — там Fastify нет, поэтому
 * нельзя переиспользовать app.redis.
 */
export async function publishSseEvent(event: SseEvent): Promise<void> {
  try {
    if (!publisher) {
      const env = loadEnv();
      const url = env.REDIS_URL ?? 'redis://localhost:6379';
      publisher = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
      publisher.on('error', (err) => {
        logger.warn({ err }, 'sse redis publisher error');
      });
      await publisher.connect();
    }
    await publisher.publish(CHANNEL, JSON.stringify(event));
  } catch (err) {
    // Не роняем основной flow — событие потеряется, но parsed-запись в БД
    // уже сделана; мобила всё равно подтянет через следующий periodic sync.
    logger.warn({ err, event }, 'sse publish failed');
  }
}

/**
 * Подписывает API-процесс на Redis-канал и перебрасывает приходящие
 * сообщения в локальный bus (in-process EventEmitter). Должна вызываться
 * ОДИН раз при старте API после регистрации redis-плагина.
 *
 * ioredis сам обрабатывает reconnect — при разрыве соединения подписка
 * восстанавливается автоматически на новой сессии. Дополнительной логики
 * не требуется.
 */
export function startSseSubscriber(
  redisUrl: string,
  onMessage: (event: SseEvent) => void,
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } = logger,
): { stop: () => Promise<void> } {
  const subscriber = new Redis(redisUrl, { lazyConnect: true });
  subscriber.on('error', (err) => {
    log.warn({ err }, 'sse redis subscriber error');
  });

  void subscriber
    .connect()
    .then(() => subscriber.subscribe(CHANNEL))
    .then((count) => {
      log.info({ channel: CHANNEL, count }, 'sse redis subscriber listening');
    })
    .catch((err) => {
      log.warn({ err }, 'sse redis subscribe failed');
    });

  subscriber.on('message', (channel, payload) => {
    if (channel !== CHANNEL) return;
    try {
      const evt = JSON.parse(payload) as SseEvent;
      onMessage(evt);
    } catch (err) {
      log.warn({ err, payload }, 'sse redis: bad payload');
    }
  });

  return {
    async stop() {
      try {
        await subscriber.unsubscribe(CHANNEL);
      } catch {
        /* ignore */
      }
      try {
        await subscriber.quit();
      } catch {
        /* ignore */
      }
    },
  };
}
