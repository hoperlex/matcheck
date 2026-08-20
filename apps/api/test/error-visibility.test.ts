/**
 * Видимость 5xx на БОЕВОЙ сборке приложения.
 *
 * Тест поднимает настоящий buildServer(), а не свою фикстуру: проверяемое
 * свойство — «хуки действительно висят на роутах реального сервера», и лёгкое
 * приложение его не докажет (именно так дефект и прожил в error-handler.test.ts,
 * где роуты объявлены в конфигурации, которой в проде нет).
 *
 * Инфраструктура замокана не для скорости: с настоящими ioredis/BullMQ на
 * закрытом порту процесс после app.close() остаётся жив на reconnect-handles и
 * сыплет «[ioredis] Unhandled error event» — в vitest это повисший набор.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type * as QueuePlugin from '../src/plugins/queue.js';

const ORIGINAL_ENV = { ...process.env };

// Санитизация включается только в production. Vitest по умолчанию ставит
// NODE_ENV=test, и без этой строки набор был бы зелёным, ничего не проверив.
process.env.NODE_ENV = 'production';
process.env.PERMISSIONS_ENFORCE = '0';
process.env.LOG_LEVEL = 'info';
// Метрики включены, чтобы проверить: respBytes считается по фактически
// отправленному телу — наш onSend обязан отработать раньше замера.
process.env.REQUEST_METRICS_ENABLED = '1';
// Внешняя ФОТ: buildServer зовёт warmUpFotMolCache в onReady, а getFotPool
// создаёт настоящий пул, как только переменная есть в окружении.
delete process.env.FOT_DATABASE_URL;

const SENTINEL = 'SENTINEL_DB_DOWN';

const logs = vi.hoisted(() => [] as Array<Record<string, unknown>>);

// req.log — дочерний логгер, поэтому spy на методах инстанса ничего не увидит.
// Подменяем сам модуль настоящим pino с синхронным in-memory назначением.
vi.mock('../src/lib/logger.js', async () => {
  const { pino } = await import('pino');
  return {
    logger: pino(
      { level: 'info' },
      {
        write(line: string) {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ),
  };
});

// db.select() бросает детерминированную ошибку: нужен предсказуемый 500 с
// узнаваемым текстом, чтобы проверить, что наружу он НЕ уходит.
// sql.end() обязателен — его зовёт onClose в plugins/db.ts.
vi.mock('../src/db/client.js', () => {
  const boom = () => {
    throw new Error(`Failed query: select ... /* ${SENTINEL} */`);
  };
  return {
    sql: { end: async () => undefined },
    db: {
      select: boom,
      insert: boom,
      update: boom,
      delete: boom,
      execute: boom,
      transaction: boom,
    },
    schema: {},
  };
});

vi.mock('../src/db/fot-client.js', () => ({ getFotPool: () => null }));

// redis декорируется НУЛЁМ намеренно: truthy-заглушка увела бы
// @fastify/rate-limit в RedisStore, который зовёт defineCommand() у неё же.
// При null плагин выбирает LocalStore, и лимиты остаются рабочими.
vi.mock('../src/plugins/redis.js', async () => {
  const fp = (await import('fastify-plugin')).default;
  return { default: fp(async (app) => { app.decorate('redis', null as never); }) };
});

// Очереди: сохраняем реальные экспорты (роуты импортируют константы очередей),
// подменяем только плагин — он декорирует app.queues.
vi.mock('../src/plugins/queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueuePlugin>();
  const fp = (await import('fastify-plugin')).default;
  const queue = { add: async () => ({}), close: async () => undefined };
  return {
    ...actual,
    default: fp(async (app) => {
      app.decorate('queues', { updParse: queue, s3Cleanup: queue, mailPoll: queue } as never);
    }),
  };
});

let app: FastifyInstance;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BIG_TEXT = 'ю'.repeat(4000);

/** Записи http_5xx, оставленные последним запросом. */
function events5xx(reqId?: unknown) {
  return logs.filter(
    (l) => l.event === 'http_5xx' && (reqId === undefined || l.reqId === reqId),
  );
}

beforeAll(async () => {
  const { buildServer } = await import('../src/server.js');
  app = await buildServer();

  // Фикстуры под публичным префиксом: только он исключён из глобального
  // auth-хука. Регистрируются на root ПОСЛЕ плагина видимости — то есть в
  // точности так же, как их видят боевые хуки.
  app.get('/api/v1/public/__t/explicit-502', async (_req, reply) =>
    reply.code(502).send({ error: 's3_unavailable' }),
  );
  app.get('/api/v1/public/__t/explicit-409', async (_req, reply) =>
    reply.code(409).send({ error: 'pending_deletion', message: 'Документ помечен на удаление' }),
  );
  app.get('/api/v1/public/__t/binary', async (_req, reply) =>
    reply.code(200).header('content-type', 'image/png').send(PNG),
  );
  app.get('/api/v1/public/__t/big-json', async () => ({ text: BIG_TEXT }));
  app.get('/api/v1/public/__t/no-content', async (_req, reply) => reply.code(204).send());
  app.get(
    '/api/v1/public/__t/limited',
    { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } },
    async () => ({ ok: true }),
  );

  await app.ready();
});

afterEach(() => {
  logs.length = 0;
});

afterAll(async () => {
  await app.close();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe('error-visibility: необработанные 5xx', () => {
  it('тело санитизировано, внутренний текст наружу не уходит', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/sites' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SENTINEL);
    expect(res.body).not.toContain('Failed query');
    const body = res.json();
    expect(body).toMatchObject({ error: 'internal_error', message: 'Внутренняя ошибка сервера' });
    expect(typeof body.requestId).toBe('string');
    expect(res.headers['content-type']).toContain('application/json');
    // content-length должен соответствовать НОВОМУ телу, иначе ответ обрезан.
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body));
  });

  it('оставляет ровно одну запись http_5xx со стеком', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/sites' });
    const reqId = res.json().requestId;

    const events = events5xx(reqId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 500,
      method: 'GET',
      route: '/api/v1/public/sites',
      unhandled: true,
      level: 50,
    });
    // Ошибка со стеком — в логе она нужна целиком, это и есть смысл правки.
    expect(JSON.stringify(events[0]!.err)).toContain(SENTINEL);
  });

  it('ip берётся из X-Real-IP, а не из подделываемого X-Forwarded-For', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/sites',
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '10.0.0.7' },
    });

    expect(events5xx(res.json().requestId)[0]).toMatchObject({ ip: '10.0.0.7' });
  });
});

describe('error-visibility: контракты, которые нельзя трогать', () => {
  it('ошибка валидации остаётся 400 в прежнем формате и не порождает 5xx-событий', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/upload-documents/abc',
    });

    expect(res.statusCode).toBe(400);
    // Формат дефолтного обработчика Fastify — ровно то, что видят клиенты сейчас.
    expect(res.json()).toMatchObject({ statusCode: 400, code: 'FST_ERR_VALIDATION' });
    expect(res.headers['content-type']).toContain('application/json');
    // Главный риск шума: onError срабатывает и на 4xx.
    expect(events5xx()).toHaveLength(0);
    expect(logs.filter((l) => l.level === 50)).toHaveLength(0);
  });

  it('явный 502 сохраняет тело-контракт и логируется как unhandled: false', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/__t/explicit-502' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 's3_unavailable' });
    const events = events5xx();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 502, unhandled: false });
  });

  it('коды мобильного классификатора доходят до клиента как есть', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/__t/explicit-409' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'pending_deletion',
      message: 'Документ помечен на удаление',
    });
    expect(events5xx()).toHaveLength(0);
  });
});

describe('error-visibility: успешные ответы', () => {
  it('JSON 200 не тронут', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/__t/big-json' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: BIG_TEXT });
    expect(events5xx()).toHaveLength(0);
  });

  it('крупный JSON со сжатием доезжает целым', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/__t/big-json',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.rawPayload).toString())).toEqual({ text: BIG_TEXT });
  });

  it('бинарный ответ сохраняет байты и content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/__t/binary' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.rawPayload, PNG)).toBe(0);
  });

  it('204 и HEAD остаются без тела', async () => {
    const noContent = await app.inject({ method: 'GET', url: '/api/v1/public/__t/no-content' });
    expect(noContent.statusCode).toBe(204);
    expect(noContent.body).toBe('');

    const head = await app.inject({ method: 'HEAD', url: '/api/v1/public/__t/big-json' });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(events5xx()).toHaveLength(0);
  });
});

describe('error-visibility: соседние механизмы', () => {
  it('respBytes меряет фактически отправленное тело, а не исходную ошибку', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/sites' });

    const metric = logs.find((l) => l.metric === 'request' && l.status === 500);
    expect(metric).toBeDefined();
    // Именно byteLength: сообщение русское, символов и UTF-8-байтов в нём разное число.
    expect(metric!.respBytes).toBe(Buffer.byteLength(res.body));
  });

  it('429 сохраняет retry-after — его ставит сам rate-limit, и хуки его не трогают', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/public/__t/limited' });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'GET', url: '/api/v1/public/__t/limited' });
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.json().message).toContain('Слишком много запросов');
    expect(events5xx()).toHaveLength(0);
  });
});
