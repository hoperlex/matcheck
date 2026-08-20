/**
 * Выгрузка обязана повторять таблицу.
 *
 * Экспорт приёмок жил своей копией WHERE и разошёлся со списком: период,
 * displayId, признаки, отметку проверки и «без фото» он не знал вовсе, а
 * поставщика фильтровал по id справочника без ИНН-маппинга. Пользователь
 * просил «принятые с 01.07 по 31.07», а получал файл за всё время. У отгрузок
 * своего экспорта не было совсем — страница выгружала исходящие документы,
 * которых в базе один за всё время, то есть пустой лист.
 *
 * Теперь оба маршрута строят условия одной функцией (buildDeliveryFilters /
 * buildShipmentFilters). Тест закрепляет именно это: при одинаковых параметрах
 * список и выгрузка отдают ОДИН И ТОТ ЖЕ набор записей.
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
import { deliveries, shipments, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('export.xlsx повторяет список (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const managerId = randomUUID();
  let deliveryStatusId: string;
  let shipmentStatusId: string;

  // Три приёмки: две в июле, одна в августе — период обязан отсечь третью.
  const julyEarly = randomUUID();
  const julyLate = randomUUID();
  const august = randomUUID();
  const shipJuly = randomUUID();
  const shipAugust = randomUUID();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { deliveries, shipments, sites, statuses, users } });

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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'EXP'}, 'Export test')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${managerId}, ${`exp-${managerId}@test`}, 'x', 'manager', NULL)
      ON CONFLICT DO NOTHING`;
    const [d] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const [s] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`;
    deliveryStatusId = d!.id;
    shipmentStatusId = s!.id;

    const seedDelivery = async (id: string, arrivedAt: string, plate: string): Promise<void> => {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, vehicle_plate, version)
        VALUES (${id}, ${siteId}, ${managerId}, ${deliveryStatusId}, ${arrivedAt}, ${plate}, 1)`;
    };
    await seedDelivery(julyEarly, '2025-07-03T08:00:00Z', 'А001АА');
    await seedDelivery(julyLate, '2025-07-28T15:00:00Z', 'В002ВВ');
    await seedDelivery(august, '2025-08-05T09:00:00Z', 'С003СС');

    const seedShipment = async (id: string, shippedAt: string): Promise<void> => {
      await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, shipped_at, version)
        VALUES (${id}, ${siteId}, ${managerId}, ${shipmentStatusId}, 'contractor', ${shippedAt}, 1)`;
    };
    await seedShipment(shipJuly, '2025-07-10T10:00:00Z');
    await seedShipment(shipAugust, '2025-08-11T10:00:00Z');

    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    };
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  /** Короткие id строк верхнего уровня выгрузки (колонка «id»). */
  async function exportDisplayIds(url: string, expectedCount: number): Promise<number[]> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const ids: number[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // шапка
      if (row.outlineLevel === 1) return; // строка позиции
      const value = row.getCell(2).value;
      if (typeof value === 'number') ids.push(value);
    });
    expect(ids).toHaveLength(expectedCount);
    return ids;
  }

  it('приёмки: период в выгрузке отсекает то же, что и в списке', async () => {
    const range = 'arrivedFrom=2025-07-01T00:00:00.000Z&arrivedTo=2025-08-01T00:00:00.000Z';
    const list = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${range}&limit=200` });
    expect(list.statusCode).toBe(200);
    const listIds = (list.json() as { items: { id: string; displayId: number }[] }).items;
    const july = listIds.filter((d) => [julyEarly, julyLate].includes(d.id));
    // В списке ровно две июльские приёмки, августовской нет.
    expect(july).toHaveLength(2);
    expect(listIds.some((d) => d.id === august)).toBe(false);

    // Первая колонка выгрузки — тот же displayId; сравниваем множества.
    const exported = await exportDisplayIds(
      `/api/v1/deliveries/export.xlsx?${range}`,
      listIds.length,
    );
    expect([...exported].sort()).toEqual(listIds.map((d) => d.displayId).sort());
  });

  it('приёмки: фильтр по госномеру одинаково сужает список и выгрузку', async () => {
    const query = 'plate=В002';
    const list = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${query}&limit=200` });
    const items = (list.json() as { items: { id: string; displayId: number }[] }).items;
    expect(items.map((d) => d.id)).toEqual([julyLate]);
    const exported = await exportDisplayIds(`/api/v1/deliveries/export.xlsx?${query}`, 1);
    expect(exported).toEqual([items[0]!.displayId]);
  });

  it('отгрузки: у выгрузки свой маршрут, и он повторяет список', async () => {
    const range = 'shippedFrom=2025-07-01T00:00:00.000Z&shippedTo=2025-08-01T00:00:00.000Z';
    const list = await app.inject({ method: 'GET', url: `/api/v1/shipments?${range}&limit=200` });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: { id: string; displayId: number }[] }).items;
    expect(items.some((s) => s.id === shipJuly)).toBe(true);
    expect(items.some((s) => s.id === shipAugust)).toBe(false);

    const exported = await exportDisplayIds(
      `/api/v1/shipments/export.xlsx?${range}`,
      items.length,
    );
    expect([...exported].sort()).toEqual(items.map((s) => s.displayId).sort());
  });
});
