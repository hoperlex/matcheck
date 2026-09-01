/**
 * Развилка распознавания фото документа: УПД — в основной парсер, остальное —
 * прежним промптом (реальный PostgreSQL).
 *
 * Зачем интеграционные. Проверяется не «какая функция вызвалась», а что
 * доезжает до кэша и обратно к менеджеру: признак пути (`parser`), сохранённая
 * сверка и поля НДС появились миграцией 0122, а сумма у двух веток стоит на
 * РАЗНЫХ налоговых базах — перепутать их значит соврать на величину налога.
 * На моках БД такую подмену не увидеть.
 *
 * Запуск: см. шапку foreign-site.int.test.ts. Без TEST_DATABASE_URL набор
 * пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';

const mocks = vi.hoisted(() => ({
  getObject: vi.fn(),
  presign: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
  recognizePhotoItems: vi.fn(),
  recognizePhotoUpd: vi.fn(),
  classifyImageKind: vi.fn(),
  updRoute: false,
}));

vi.mock('../../src/domain/storage/s3.signer.js', () => ({
  getObject: mocks.getObject,
  presign: mocks.presign,
  putObject: mocks.putObject,
  deleteObject: mocks.deleteObject,
  headObject: mocks.headObject,
}));
vi.mock('../../src/domain/photos/recognize.js', () => ({
  recognizePhotoItems: mocks.recognizePhotoItems,
}));
vi.mock('../../src/domain/photos/recognize-upd.js', () => ({
  recognizePhotoUpd: mocks.recognizePhotoUpd,
}));
vi.mock('../../src/domain/edo/vision-classifier.js', () => ({
  classifyImageKind: mocks.classifyImageKind,
}));
// Флаг переключается по тесту, остальное окружение — настоящее.
vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/env.js')>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), PHOTO_RECOGNIZE_UPD_ROUTE: mocks.updRoute }),
  };
});

const { photoRoutes } = await import('../../src/routes/photos.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Ответ прежнего промпта: сумма БЕЗ налога (графа 5), НДС не извлекается. */
const PHOTO_V1_RESULT = {
  items: [
    {
      nameRaw: 'Пена монтажная Империал 65 UNIVERSAL',
      qty: 796,
      unit: 'шт',
      price: 118.766,
      sum: 94537.74,
      invNumber: null,
    },
  ],
  docForm: 'other',
  docNumber: '2788',
  docDate: '2026-08-31',
  totalSum: 93375,
  confidence: 0.95,
  model: 'gemini-mock',
  rawResponse: '{}',
};

/** Ответ УПД-ветки: сумма С налогом (графа 9), НДС и номер позиции на месте. */
const UPD_RESULT = {
  items: [
    {
      nameRaw: 'Пена монтажная Империал 65 UNIVERSAL',
      qty: 249,
      unit: 'шт',
      invNumber: null,
      price: 307.38,
      sum: 93375,
      rowNo: 1,
      vatRate: 22,
      vatSum: 16838.11,
    },
  ],
  docNumber: '2788',
  docDate: '2026-08-31',
  totalSum: 93375,
  vatSum: 16838.11,
  itemsCount: null,
  confidence: 0.95,
  model: 'gemini-mock',
  validation: {
    hasMismatch: false,
    checkedAt: '2026-09-01T05:18:14.402Z',
    checks: [
      {
        name: 'sum_total',
        scope: 'document',
        expected: 93375,
        actual: 93375,
        diff: 0,
        tolerance: 0.01,
        ok: true,
      },
    ],
    warnings: [{ name: 'unit_code_as_qty', scope: { row: 1 } }],
  },
};

suite('фото документа: развилка УПД / прежний промпт (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const userId = randomUUID();
  const deliveryId = randomUUID();
  let photoId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: AuthUser['role'][]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (c: number) => { send: (b: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    await app.register(photoRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'IPR'}, 'Integration PhotoRecognize')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${userId}, ${`ipr-${userId}@test`}, 'x', 'manager', ${siteId})
      ON CONFLICT DO NOTHING`;
    const [ds] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${deliveryId}, ${siteId}, ${userId}, ${ds!.id}, 1)`;

    photoId = randomUUID();
    await sql`INSERT INTO delivery_photos (id, delivery_id, kind, s3_key, uploaded_at)
      VALUES (${photoId}, ${deliveryId}, 'document', ${`test/${photoId}.jpg`}, now())`;

    currentUser = {
      id: userId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    };
  });

  afterAll(async () => {
    if (!sql) return;
    await app?.close();
    await sql`DELETE FROM photo_recognized_items WHERE delivery_photo_id = ${photoId}`;
    await sql`DELETE FROM delivery_photos WHERE delivery_id = ${deliveryId}`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    mocks.getObject.mockReset();
    mocks.recognizePhotoItems.mockReset();
    mocks.recognizePhotoUpd.mockReset();
    mocks.classifyImageKind.mockReset();
    mocks.updRoute = false;
    mocks.getObject.mockResolvedValue({ body: Buffer.from('jpeg-bytes') });
    mocks.recognizePhotoItems.mockResolvedValue(PHOTO_V1_RESULT);
    await sql`DELETE FROM photo_recognized_items WHERE delivery_photo_id = ${photoId}`;
  });

  // Часы подменяет только тест про бюджет, но восстанавливать их обязан каждый:
  // упавший на середине тест иначе утащил бы за собой все следующие.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const recognize = () =>
    app.inject({ method: 'POST', url: `/api/v1/photos/${photoId}/recognize?force=true` });

  const savedRow = async () =>
    (
      await sql<
        {
          parser: string;
          validation: unknown;
          vat_sum: string | null;
          items_count: number | null;
        }[]
      >`SELECT parser, validation, vat_sum, items_count FROM photo_recognized_items
        WHERE delivery_photo_id = ${photoId}`
    )[0];

  it('флаг выключен — прежний путь, классификатор не зовётся вовсе', async () => {
    const res = await recognize();

    expect(res.statusCode).toBe(200);
    expect(mocks.classifyImageKind).not.toHaveBeenCalled();
    expect(mocks.recognizePhotoUpd).not.toHaveBeenCalled();
    expect(mocks.recognizePhotoItems).toHaveBeenCalledTimes(1);
    const body = res.json();
    expect(body.parser).toBe('photo_v1');
    expect(body.validation).toBeNull();
    expect(body.items[0].qty).toBe(796);
    const row = await savedRow();
    expect(row?.parser).toBe('photo_v1');
  });

  it('УПД уходит в основной парсер: сумма с НДС, сверка и метка пути сохраняются', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.95 });
    mocks.recognizePhotoUpd.mockResolvedValue(UPD_RESULT);

    const res = await recognize();

    expect(res.statusCode).toBe(200);
    expect(mocks.recognizePhotoItems).not.toHaveBeenCalled();
    const body = res.json();
    expect(body.parser).toBe('upd_vision');
    expect(body.docForm).toBe('upd');
    expect(body.items[0]).toMatchObject({
      qty: 249,
      price: 307.38,
      sum: 93375,
      vatSum: 16838.11,
      rowNo: 1,
    });
    expect(body.vatSum).toBe(16838.11);
    // Обе группы сверки, а не только подозрения.
    expect(body.validation.checks).toHaveLength(1);
    expect(body.validation.warnings[0].name).toBe('unit_code_as_qty');
    const row = await savedRow();
    expect(row?.parser).toBe('upd_vision');
    expect(row?.vat_sum).toBe('16838.11');
  });

  it('метка фото доезжает до классификатора и до парсера', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.95 });
    mocks.recognizePhotoUpd.mockResolvedValue(UPD_RESULT);

    await recognize();

    expect(mocks.classifyImageKind).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ label: `photo:${photoId}` }),
    );
    expect(mocks.recognizePhotoUpd).toHaveBeenCalledWith(
      expect.objectContaining({ label: `photo:${photoId}` }),
    );
  });

  it('накладная остаётся на прежнем промпте', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'transport_waybill', confidence: 0.99 });

    const res = await recognize();

    expect(mocks.recognizePhotoUpd).not.toHaveBeenCalled();
    expect(mocks.recognizePhotoItems).toHaveBeenCalledTimes(1);
    expect(res.json().parser).toBe('photo_v1');
  });

  it('классификатор не смог решить (null) — прежний путь', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue(null);

    const res = await recognize();

    expect(mocks.recognizePhotoUpd).not.toHaveBeenCalled();
    expect(res.json().parser).toBe('photo_v1');
  });

  it('низкая уверенность классификатора — прежний путь', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.4 });

    const res = await recognize();

    expect(mocks.recognizePhotoUpd).not.toHaveBeenCalled();
    expect(res.json().parser).toBe('photo_v1');
  });

  it('УПД-парсер упал — фолбэк на прежний промпт, а не ошибка менеджеру', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.95 });
    mocks.recognizePhotoUpd.mockRejectedValue(new Error('Vision LLM не ответил за 240с'));

    const res = await recognize();

    expect(res.statusCode).toBe(200);
    expect(mocks.recognizePhotoItems).toHaveBeenCalledTimes(1);
    expect(res.json().parser).toBe('photo_v1');
  });

  it('УПД-парсер вернул пусто — фолбэк: строгий промпт мог не увидеть кривой кадр', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.95 });
    mocks.recognizePhotoUpd.mockResolvedValue({ ...UPD_RESULT, items: [] });

    const res = await recognize();

    expect(mocks.recognizePhotoItems).toHaveBeenCalledTimes(1);
    expect(res.json().parser).toBe('photo_v1');
    expect(res.json().items[0].qty).toBe(796);
  });

  it('низкая уверенность УПД-разбора — тоже фолбэк', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.95 });
    mocks.recognizePhotoUpd.mockResolvedValue({ ...UPD_RESULT, confidence: 0.3 });

    const res = await recognize();

    expect(mocks.recognizePhotoItems).toHaveBeenCalledTimes(1);
    expect(res.json().parser).toBe('photo_v1');
  });

  it('бюджет времени вышел — фолбэк не начинаем, отдаём слабый разбор УПД', async () => {
    mocks.updRoute = true;
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.95 });
    // Разбор «занял» девять минут: на второй вызов модели времени уже нет, а
    // начать его — значит перевалить за клиентские 610 с и оборвать запрос.
    const realNow = Date.now;
    let shift = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + shift);
    mocks.recognizePhotoUpd.mockImplementation(async () => {
      shift = 540_000;
      return { ...UPD_RESULT, confidence: 0.3 };
    });

    const res = await recognize();

    expect(mocks.recognizePhotoItems).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.json().parser).toBe('upd_vision');
  });

  it('запись, сделанная до миграции, читается как прежний путь', async () => {
    // Строка кэша от старого кода: ни признака пути, ни сверки.
    const legacyItems = JSON.stringify([
      { nameRaw: 'Труба', qty: 5, unit: 'шт', price: null, sum: null },
    ]);
    await sql`INSERT INTO photo_recognized_items (delivery_photo_id, items, doc_form, doc_number)
      VALUES (${photoId}, ${legacyItems}::jsonb, 'other', '31')`;

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${photoId}/recognition` });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.parser).toBe('photo_v1');
    expect(body.validation).toBeNull();
    expect(body.vatSum).toBeNull();
    expect(body.items[0].nameRaw).toBe('Труба');
  });
});
