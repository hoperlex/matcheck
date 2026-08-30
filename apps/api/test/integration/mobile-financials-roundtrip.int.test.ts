/**
 * Круговой путь финансов: сервер отдал — приложение вернуло — деньги целы.
 *
 * Зачем интеграционный. Проверяется не форма запроса, а СОХРАННОСТЬ значений в
 * базе после сохранения. Zod форму пропустит в любом случае: `price` объявлен
 * `.nullable().optional()`, колонки nullable, CHECK на них нет. Единственный
 * способ увидеть потерю — прочитать строки после upsert.
 *
 * Что именно ломается, если этого теста нет. Позиции при сохранении не
 * обновляются, а перезаписываются целиком: `DELETE` всех строк операции и
 * следом `INSERT` присланных (routes/deliveries.ts). Значения берутся как
 * `i.price ?? null`, то есть «поле не прислали» и «прислали null» уравнены.
 * Приложение обязано вернуть финансы на финализации обоих этапов, само их не
 * редактируя, — и если однажды перестанет или поле уйдёт из контракта, деньги
 * в приёмке молча станут пустыми.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import {
  deliveries,
  deliveryItems,
  deliverySources,
  sessions,
  shipmentItems,
  shipmentSources,
  shipments,
  sites,
  sourceDocumentItems,
  sourceDocuments,
  statuses,
  users,
} from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Финансы одной позиции — ровно то, что приложение обязано вернуть нетронутым. */
const MONEY = { price: '82.5000', vatRate: '22.00', vatSum: '1815.00' } as const;

type ItemRow = {
  line_no: number;
  qty_actual: string | null;
  price: string | null;
  vat_rate: string | null;
  vat_sum: string | null;
};

suite('финансы переживают круг «сервер → приложение → сервер» (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const SHIPPED_AT = new Date().toISOString();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, {
      schema: {
        deliveries,
        deliveryItems,
        deliverySources,
        sessions,
        shipments,
        shipmentItems,
        shipmentSources,
        sites,
        sourceDocuments,
        sourceDocumentItems,
        statuses,
        users,
      },
    });

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
    await app.register(deliveryRoutes);
    await app.register(shipmentRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'MFR'}, 'Mobile financials')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${managerId}, ${`mfr-${managerId}@test`}, 'x', 'manager', ${siteId})
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})
      ON CONFLICT DO NOTHING`;

    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  /** Позиция с деньгами — как её собирает сервер при создании приёмки из УПД. */
  const itemWithMoney = (over: Record<string, unknown> = {}) => ({
    nameRaw: 'Кабель ВВГнг 3х2.5',
    qtyPlanned: '100',
    qtyActual: '100',
    unit: 'м',
    lineNo: 1,
    ...MONEY,
    ...over,
  });

  const deliveryBody = (id: string, items: unknown[]) => ({
    id,
    statusCode: 'filled',
    siteId,
    items,
    sourceDocumentIds: [],
  });

  const shipmentBody = (id: string, items: unknown[]) => ({
    id,
    statusCode: 'shipped',
    kind: 'writeoff',
    siteId,
    shippedAt: SHIPPED_AT,
    items,
    sourceDocumentIds: [],
  });

  const postDelivery = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/deliveries', payload: body });

  const postShipment = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/shipments', payload: body });

  const deliveryItemsOf = (id: string) =>
    sql<ItemRow[]>`SELECT line_no, qty_actual, price, vat_rate, vat_sum
                     FROM delivery_items WHERE delivery_id = ${id} ORDER BY line_no`;

  const shipmentItemsOf = (id: string) =>
    sql<ItemRow[]>`SELECT line_no, qty_actual, price, vat_rate, vat_sum
                     FROM shipment_items WHERE shipment_id = ${id} ORDER BY line_no`;

  /**
   * Снимок позиций так, как его получает приложение, — из ответа сервера, а не
   * из своей же посылки. Именно этот путь проходит клиент между этапами:
   * прочитал операцию, показал инспектору, вернул на финализации.
   */
  async function itemsFromServer(url: string): Promise<Record<string, unknown>[]> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Record<string, unknown>[] };
    return body.items;
  }

  /** Позиция снимка → позиция upsert: клиент возвращает поля как есть. */
  const backToUpsert = (i: Record<string, unknown>) => ({
    id: i.id,
    materialId: i.materialId,
    nameRaw: i.nameRaw,
    qtyPlanned: i.qtyPlanned,
    qtyActual: i.qtyActual,
    unit: i.unit,
    lineNo: i.lineNo,
    price: i.price,
    vatRate: i.vatRate,
    vatSum: i.vatSum,
  });

  describe('приёмка', () => {
    it('круг без правок: деньги в базе те же', async () => {
      const id = randomUUID();
      expect((await postDelivery(deliveryBody(id, [itemWithMoney()]))).statusCode).toBe(200);

      const snapshot = await itemsFromServer(`/api/v1/deliveries/${id}`);
      expect(snapshot[0]).toMatchObject(MONEY);

      const second = await postDelivery(deliveryBody(id, snapshot.map(backToUpsert)));
      expect(second.statusCode, second.body).toBe(200);

      const rows = await deliveryItemsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        price: MONEY.price,
        vat_rate: MONEY.vatRate,
        vat_sum: MONEY.vatSum,
      });
    });

    it('правка количества не задевает финансы', async () => {
      // Инспектор принял меньше, чем в накладной, — это единственное, что он
      // меняет на 1 Этапе. Цены при этом обязаны остаться от документа.
      const id = randomUUID();
      await postDelivery(deliveryBody(id, [itemWithMoney()]));

      const snapshot = await itemsFromServer(`/api/v1/deliveries/${id}`);
      const edited = snapshot.map((i) => ({ ...backToUpsert(i), qtyActual: '90' }));
      expect((await postDelivery(deliveryBody(id, edited))).statusCode).toBe(200);

      const rows = await deliveryItemsOf(id);
      expect(rows[0]!.qty_actual).toBe('90.0000');
      expect(rows[0]).toMatchObject({
        price: MONEY.price,
        vat_rate: MONEY.vatRate,
        vat_sum: MONEY.vatSum,
      });
    });

    it('ФИКСАЦИЯ: payload без финансовых полей обнуляет их в базе', async () => {
      // Так повёл бы себя клиент, не знающий этих полей. Тест ДОКУМЕНТИРУЕТ
      // нынешнее поведение, а не одобряет его: позиции перезаписываются
      // целиком, а `i.price ?? null` не отличает «не прислали» от «null».
      //
      // Если поведение решат менять — сохранять прежнее значение при
      // отсутствующем поле, — этот тест упадёт и заставит обновить ожидание
      // осознанно, а не молча.
      const id = randomUUID();
      await postDelivery(deliveryBody(id, [itemWithMoney()]));

      const legacy = [
        { nameRaw: 'Кабель ВВГнг 3х2.5', qtyPlanned: '100', qtyActual: '100', unit: 'м', lineNo: 1 },
      ];
      expect((await postDelivery(deliveryBody(id, legacy))).statusCode).toBe(200);

      const rows = await deliveryItemsOf(id);
      expect(rows[0]).toMatchObject({ price: null, vat_rate: null, vat_sum: null });
    });
  });

  describe('отгрузка', () => {
    it('круг без правок: деньги в базе те же', async () => {
      const id = randomUUID();
      expect((await postShipment(shipmentBody(id, [itemWithMoney()]))).statusCode).toBe(200);

      const snapshot = await itemsFromServer(`/api/v1/shipments/${id}`);
      expect(snapshot[0]).toMatchObject(MONEY);

      const second = await postShipment(shipmentBody(id, snapshot.map(backToUpsert)));
      expect(second.statusCode, second.body).toBe(200);

      const rows = await shipmentItemsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        price: MONEY.price,
        vat_rate: MONEY.vatRate,
        vat_sum: MONEY.vatSum,
      });
    });

    it('правка количества не задевает финансы', async () => {
      const id = randomUUID();
      await postShipment(shipmentBody(id, [itemWithMoney()]));

      const snapshot = await itemsFromServer(`/api/v1/shipments/${id}`);
      const edited = snapshot.map((i) => ({ ...backToUpsert(i), qtyActual: '90' }));
      expect((await postShipment(shipmentBody(id, edited))).statusCode).toBe(200);

      const rows = await shipmentItemsOf(id);
      expect(rows[0]!.qty_actual).toBe('90.0000');
      expect(rows[0]).toMatchObject({
        price: MONEY.price,
        vat_rate: MONEY.vatRate,
        vat_sum: MONEY.vatSum,
      });
    });

    it('ФИКСАЦИЯ: payload без финансовых полей обнуляет их в базе', async () => {
      const id = randomUUID();
      await postShipment(shipmentBody(id, [itemWithMoney()]));

      const legacy = [
        { nameRaw: 'Кабель ВВГнг 3х2.5', qtyPlanned: '100', qtyActual: '100', unit: 'м', lineNo: 1 },
      ];
      expect((await postShipment(shipmentBody(id, legacy))).statusCode).toBe(200);

      const rows = await shipmentItemsOf(id);
      expect(rows[0]).toMatchObject({ price: null, vat_rate: null, vat_sum: null });
    });
  });
});
