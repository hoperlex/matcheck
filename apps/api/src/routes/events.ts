import type { FastifyInstance, FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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
  startSseSubscriber(url, (evt) => bus.emit('sse', evt), log ?? console);
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  // Подписка на Redis-канал — поднимается при регистрации SSE-роутов.
  // Один раз на процесс (см. флаг subscriberStarted).
  ensureSseSubscriber(app.log);

  app.get(
    '/api/v1/events',
    {
      // Сжатие обязано быть выключено: компрессор буферизует поток, и живые
      // события копились бы вместо доставки во вкладку.
      compress: false,
      // SSE-события шлются всем подключённым без скоупа (id/типы чужих сущностей)
      // → metadata-leak. contractor не должен подписываться (live-обновления ему
      // не критичны — списки обновятся на focus-refetch). Закрываем (403).
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
    },
    async (req, reply: FastifyReply) => {
      // Поток отдаём ШТАТНЫМ путём Fastify: заголовки ставит он, тело —
      // PassThrough. Раньше маршрут писал в сокет сам (reply.raw.writeHead) и
      // завершался через `return reply`. Пока в приложении не было ни одного
      // onSend-хука, это работало; 20.08 плагин error-visibility такой хук
      // добавил — и Fastify в конце цепочки попытался записать заголовки
      // второй раз: ERR_HTTP_HEADERS_SENT, никем не пойманный. Каждое
      // подключение к SSE роняло процесс, а портал открывает поток сразу
      // после входа — 854 рестарта за ночь и «Ошибка входа» у всех.
      //
      // reply.hijack() тут не помог (проверено на бою): ответ всё равно
      // доходил до onSendEnd. Поэтому убираем сам конфликт — ручной записи
      // заголовков больше нет, а значит нечему конфликтовать ни с этим
      // хуком, ни с любым будущим.
      const stream = new PassThrough();
      reply
        .header('Content-Type', 'text/event-stream')
        .header('Cache-Control', 'no-cache, no-transform')
        .header('Connection', 'keep-alive')
        // Отключает буферизацию nginx: без этого события копятся в прокси и
        // доходят до вкладки пачками.
        .header('X-Accel-Buffering', 'no');

      stream.write(':ok\n\n');
      const listener = (evt: SseEvent) => {
        stream.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      };
      bus.on('sse', listener);
      const ping = setInterval(() => {
        stream.write(`event: ping\ndata: {"type":"ping","ts":"${new Date().toISOString()}"}\n\n`);
      }, 25_000);
      // Клиент ушёл — снимаем подписку и таймер, иначе они копятся на каждой
      // перезагрузке вкладки (EventSource переподключается сам).
      const stop = (): void => {
        clearInterval(ping);
        bus.off('sse', listener);
        stream.end();
      };
      req.raw.on('close', stop);
      stream.on('error', stop);

      return reply.send(stream);
    },
  );
}
