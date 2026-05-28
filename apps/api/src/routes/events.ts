import type { FastifyInstance, FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import type { SseEvent } from '@matcheck/contracts';
import { startSseSubscriber } from '../domain/sse/redis-bridge.js';
import { loadEnv } from '../lib/env.js';

const bus = new EventEmitter();
bus.setMaxListeners(1000);

/**
 * Эмитит событие в локальный SSE-bus. Используется HTTP-ручками API
 * (PATCH/upsert/delete для delivery/shipment/source-document/photo).
 * Worker, как отдельный процесс, не может вызвать publishEvent напрямую —
 * он публикует через Redis Pub/Sub (см. domain/sse/redis-bridge.ts),
 * подписчик ниже принимает событие и эмитит в этот же bus.
 */
export function publishEvent(_app: FastifyInstance, event: SseEvent): void {
  bus.emit('sse', event);
}

// Подключаем Redis-подписчик при первом импорте модуля. Срабатывает один
// раз на процесс — то, что нужно (API-процесс один). Worker этот модуль
// не импортирует (он только публикует через redis-bridge), поэтому
// двойной подписки не будет.
let subscriberStarted = false;
function ensureSseSubscriber(log?: FastifyInstance['log']): void {
  if (subscriberStarted) return;
  subscriberStarted = true;
  const env = loadEnv();
  const url = env.REDIS_URL ?? 'redis://localhost:6379';
  startSseSubscriber(
    url,
    (evt) => bus.emit('sse', evt),
    log ?? console,
  );
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  // Подписка на Redis-канал — поднимается при регистрации SSE-роутов.
  // Один раз на процесс (см. флаг subscriberStarted).
  ensureSseSubscriber(app.log);

  app.get(
    '/api/v1/events',
    {
      preHandler: [app.authenticate],
    },
    async (req, reply: FastifyReply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write(`:ok\n\n`);
      const listener = (evt: SseEvent) => {
        reply.raw.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      };
      bus.on('sse', listener);
      const ping = setInterval(() => {
        reply.raw.write(
          `event: ping\ndata: {"type":"ping","ts":"${new Date().toISOString()}"}\n\n`,
        );
      }, 25_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        bus.off('sse', listener);
      });
      return reply;
    },
  );
}
