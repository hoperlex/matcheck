/**
 * Восстановление количества на фото-пути: кто решает, можно ли применять.
 *
 * У фото нет ни dispatch_generation, ни operationTrace, поэтому условия свои и
 * проверяются в роуте. Здесь проверяется главное из них: между проверкой перед
 * распознаванием и записью проходит вызов модели — десятки секунд, за которые
 * приёмку могут подтвердить. Тогда количество обязано вернуться к тому, что
 * прочитала модель: подтверждённые числа машиной не меняем.
 *
 * Запуск: см. шапку photo-recognize-route.int.test.ts. Без TEST_DATABASE_URL
 * набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../../src/plugins/auth.js';
import type * as EnvModule from '../../src/lib/env.js';

const mocks = vi.hoisted(() => ({
  getObject: vi.fn(),
  presign: vi.fn(),
  putObject: vi.fn(),
  deleteObject: vi.fn(),
  headObject: vi.fn(),
  recognizePhotoItems: vi.fn(),
  recognizePhotoUpd: vi.fn(),
  classifyImageKind: vi.fn(),
  qtyRepairMode: 'on' as 'off' | 'shadow' | 'on',
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
vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({
      ...actual.loadEnv(),
      PHOTO_RECOGNIZE_UPD_ROUTE: true,
      UPD_QTY_REPAIR: mocks.qtyRepairMode,
    }),
  };
});

const { photoRoutes } = await import('../../src/routes/photos.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Вода питьевая: модель дала 796 (код ОКЕИ «шт»), правило подставило 15. */
function updResultWithRepair() {
  return {
    items: [
      {
        nameRaw: 'Вода питьевая Королевская вода 19л',
        qty: 15,
        unit: 'шт',
        invNumber: null,
        price: 254.5,
        sum: 4657.35,
        rowNo: 1,
        vatRate: 22,
        vatSum: 839.85,
      },
    ],
    docNumber: 'QR-PHOTO-1',
    docDate: '2026-09-13',
    totalSum: 4657.35,
    vatSum: 839.85,
    itemsCount: null,
    confidence: 0.95,
    model: 'gemini-mock',
    validation: { hasMismatch: false, checkedAt: '2026-09-14T10:00:00.000Z', checks: [] },
    qtyRepair: {
      ruleVersion: 1,
      mode: 'on' as const,
      detectedAt: '2026-09-14T10:00:00.000Z',
      generation: null,
      docVersion: null,
      entries: [
        {
          state: 'applied' as const,
          row: 1,
          kind: 'unit_code_as_qty' as const,
          qtyFrom: 796,
          qtyTo: 15,
          price: 254.5,
          sum: 4657.35,
          base: 3817.5,
          unit: 'шт',
          okeiCode: 796,
        },
      ],
    },
  };
}

suite('фото: применение восстановления количества (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const userId = randomUUID();
  const deliveryId = randomUUID();
  let photoId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', drizzle(sql) as never);
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'QRP'}, 'Qty repair photo')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${userId}, ${`qrp-${userId}@test`}, 'x', 'manager', ${siteId})
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
    mocks.recognizePhotoUpd.mockReset();
    mocks.classifyImageKind.mockReset();
    mocks.getObject.mockResolvedValue(Buffer.from('jpeg-bytes'));
    mocks.classifyImageKind.mockResolvedValue({ kind: 'upd', confidence: 0.95 });
    mocks.qtyRepairMode = 'on';
    mocks.recognizePhotoUpd.mockResolvedValue(updResultWithRepair());
    await sql`DELETE FROM photo_recognized_items WHERE delivery_photo_id = ${photoId}`;
    await setDeliveryStatus('filled');
  });

  async function setDeliveryStatus(code: string): Promise<void> {
    const [st] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = ${code} LIMIT 1`;
    await sql`UPDATE deliveries SET status_id = ${st!.id} WHERE id = ${deliveryId}`;
  }

  async function savedRow() {
    const [r] = await sql<
      {
        items: Array<{ qty: number }>;
        qty_repair: { entries: Array<{ state: string; blockedBy?: string }> } | null;
      }[]
    >`SELECT items, qty_repair FROM photo_recognized_items WHERE delivery_photo_id = ${photoId}`;
    return r!;
  }

  it('приёмка не подтверждена: применение разрешено, след сохранён как applied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/photos/${photoId}/recognize?force=true`,
    });
    expect(res.statusCode).toBe(200);
    // Роут обязан сообщить домену, что применять можно: решение принимается
    // там, где видно состояние операции, а не внутри распознавания.
    expect(mocks.recognizePhotoUpd.mock.calls[0]![0].allowQtyRepairApply).toBe(true);

    const row = await savedRow();
    expect(row.items[0]!.qty).toBe(15);
    expect(row.qty_repair?.entries[0]!.state).toBe('applied');
  });

  it('приёмку подтвердили, пока работала модель: количество возвращено', async () => {
    // Перед распознаванием приёмка была «Оформлена», подтверждение приходит во
    // время вызова модели — ровно та гонка, ради которой проверка повторяется
    // у самой записи.
    mocks.recognizePhotoUpd.mockImplementation(async () => {
      await setDeliveryStatus('confirmed_mol');
      return updResultWithRepair();
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/photos/${photoId}/recognize?force=true`,
    });
    expect(res.statusCode).toBe(200);

    const row = await savedRow();
    expect(row.items[0]!.qty).toBe(796);
    expect(row.qty_repair?.entries[0]!.state).toBe('observed');
    expect(row.qty_repair?.entries[0]!.blockedBy).toBe('operation_trace');
  });

  it.each(['off', 'shadow'] as const)(
    'режим %s: применение не разрешается и состояние операции не спрашивается',
    async (mode) => {
      mocks.qtyRepairMode = mode;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/photos/${photoId}/recognize?force=true`,
      });
      expect(res.statusCode).toBe(200);
      // Применять правило в этих режимах не может по определению, поэтому и
      // ходить в базу за статусом приёмки не за чем: два запроса на каждое
      // распознавание фото — работа впустую.
      expect(mocks.recognizePhotoUpd.mock.calls[0]![0].allowQtyRepairApply).toBe(false);
    },
  );

  it('подтверждённая приёмка: применять не разрешается с самого начала', async () => {
    await setDeliveryStatus('confirmed_mol');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/photos/${photoId}/recognize?force=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.recognizePhotoUpd.mock.calls[0]![0].allowQtyRepairApply).toBe(false);
  });
});
