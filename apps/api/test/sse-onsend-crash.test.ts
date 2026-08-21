/**
 * SSE-поток и глобальные onSend-хуки: регрессия 21.08, уронившая боевой API.
 *
 * Маршрут /api/v1/events пишет заголовки сам (reply.raw.writeHead) — так и
 * должно быть для потока. Но пока обработчик завершался через `return reply`,
 * ответ формально оставался «Fastify-овым»: в конце цепочки onSend вызывался
 * safeWriteHead, а заголовки уже отправлены. Пока в приложении не было ни
 * одного onSend-хука, до этой строки дело не доходило. Плагин error-visibility
 * добавил такой хук — и каждое подключение к SSE стало ронять процесс с
 * ERR_HTTP_HEADERS_SENT. Портал открывает поток сразу после входа, поэтому
 * каждый вход убивал API: 854 рестарта за ночь.
 *
 * Тест держит связку целиком: боевой SSE-маршрут + боевой плагин с onSend +
 * НАСТОЯЩИЙ HTTP-запрос (inject не годится — он не доводит ответ до сокета,
 * а падало именно там). Необработанное исключение в процессе = провал.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

process.env.NODE_ENV = 'production'; // санитизация тела включается только в проде

// Redis-подписчик SSE в тесте не нужен: проверяем HTTP-путь, а не мост событий.
vi.mock('../src/domain/sse/redis-bridge.js', () => ({
  startSseSubscriber: vi.fn(),
  publishSseEvent: vi.fn(),
}));

const { eventsRoutes } = await import('../src/routes/events.js');
const errorVisibility = (await import('../src/plugins/error-visibility.js')).default;

describe('SSE-поток переживает глобальные onSend-хуки', () => {
  let app: FastifyInstance;
  let base: string;
  const fatals: unknown[] = [];
  const onFatal = (err: unknown): void => {
    fatals.push(err);
  };

  beforeAll(async () => {
    // Ловим то, что в бою убивало процесс: без обработчика Node просто выходит,
    // и vitest показал бы «набор упал» без внятной причины.
    process.on('uncaughtException', onFatal);

    app = Fastify({ logger: false });
    // Аутентификация не предмет теста — пропускаем всех.
    app.decorate('authenticate', async () => undefined);
    app.decorate('authorize', () => async () => undefined);
    await app.register(errorVisibility);
    // Любой посторонний onSend — ровно то, чем стал плагин error-visibility для
    // SSE. Защита внутри плагина (ранний выход по headersSent) закрывает только
    // его самого, а маршрут обязан быть безопасным при ЛЮБОМ хуке: следующий
    // напишут через полгода и про поток не вспомнят. Без hijack() эта строка
    // роняет процесс.
    app.addHook('onSend', async (_req, reply, payload) => {
      reply.header('x-test-hook', '1');
      return payload;
    });
    await app.register(eventsRoutes);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    expect(fatals, 'необработанных исключений в процессе быть не должно').toEqual([]);
  });

  afterAll(async () => {
    process.off('uncaughtException', onFatal);
    await app?.close();
  });

  it('отдаёт поток и не роняет процесс', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/events`, { signal: ac.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Первый чанк приходит сразу — значит поток живой, а не буферизуется.
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(':ok');

    ac.abort();
    await reader.cancel().catch(() => undefined);
    // Дать серверу обработать close: падение случалось именно на завершении.
    await new Promise((r) => setTimeout(r, 100));
  });

  it('повторное подключение тоже безопасно', async () => {
    // В бою каждая вкладка открывает свой поток; один успешный запрос ничего
    // не доказывает, если процесс умирает на втором.
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/v1/events`, { signal: ac.signal });
      expect(res.status).toBe(200);
      ac.abort();
      await res.body?.cancel().catch(() => undefined);
    }
    await new Promise((r) => setTimeout(r, 100));
  });
});
