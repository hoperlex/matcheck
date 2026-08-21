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
      // Поток пишется через reply.raw (ниже), то есть мимо onSend-хуков, — но
      // полагаться на эту деталь реализации нельзя: стоит кому-то перевести
      // ответ на reply.send, и сжатие начнёт буферизовать поток, а живые
      // события перестанут доходить до вкладок. Отключаем явно.
      compress: false,
      // SSE-события шлются всем подключённым без скоупа (id/типы чужих сущностей)
      // → metadata-leak. contractor не должен подписываться (live-обновления ему
      // не критичны — списки обновятся на focus-refetch). Закрываем (403).
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
    },
    async (req, reply: FastifyReply) => {
      // hijack() ДО первой записи в сокет: дальше ответом распоряжаемся мы, и
      // Fastify не выполняет для него ни onSend-хуки, ни финальную запись
      // заголовков.
      //
      // Без этого поток жил на честном слове. Заголовки пишутся вручную
      // (reply.raw.writeHead ниже), а обработчик завершался через `return
      // reply` — Fastify считал ответ своим и в конце цепочки вызывал
      // safeWriteHead. Пока в приложении не было ни одного onSend-хука, до
      // этой строки дело не доходило. 20.08 плагин error-visibility добавил
      // глобальный onSend — и каждое подключение к SSE стало ронять процесс:
      // ERR_HTTP_HEADERS_SENT, никем не пойманный (обработчиков процесса в
      // index.ts нет). Портал открывает SSE сразу после входа, поэтому каждый
      // вход убивал API: 854 рестарта за ночь и «Ошибка входа» у всех, кто
      // попал в окно рестарта.
      reply.hijack();
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
      // Ничего не возвращаем: после hijack() ответ Fastify уже не принадлежит,
      // и `return reply` снова втянул бы его в цепочку onSend.
    },
  );
}
