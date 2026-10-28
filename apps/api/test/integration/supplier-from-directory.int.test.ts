/**
 * Выбор поставщика из справочника в приёмке/отгрузке без документа
 * (PATCH /deliveries|shipments/:id/supplier-from-directory).
 *
 * 28.10, приёмка 22204: выбрали «ООО "ВСЕИНСТРУМЕНТЫ.РУ"», записался
 * «ЭСКАЛИФТ» — маршрут брал строку counterparties с тем же ИНН через LIMIT 1, а
 * под ИНН лежало пять покупателей с чужими именами. См. supplier-counterparty.ts.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { shipmentRoutes } from '../../src/routes/shipments.js';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite(
  'поставщик из справочника → строка counterparties (реальный PostgreSQL)',
  { timeout: 60_000 },
  () => {
    let app: FastifyInstance;
    let sql: ReturnType<typeof postgres>;

    const siteId = randomUUID();
    const managerId = randomUUID();
    const manager = { id: managerId, role: 'manager', siteId: null } as unknown as AuthUser;

    // Уникальные ИНН на прогон: тестовая БД общая для всех наборов.
    const stamp = String(Date.now()).slice(-7);
    const innMany = `71${stamp}0`; // пять строк, две с именем справочника
    const innFree = `71${stamp}1`; // чужое имя с КПП, место без КПП свободно
    const innTaken = `71${stamp}2`; // место без КПП занято чужим именем
    const innFresh = `71${stamp}3`; // строк нет совсем
    const inns = [innMany, innFree, innTaken, innFresh];

    const dir = {
      many: randomUUID(),
      free: randomUUID(),
      taken: randomUUID(),
      fresh: randomUUID(),
    };
    const ids = {
      escalift: randomUUID(),
      viOld: randomUUID(),
      viNew: randomUUID(),
      foreignWithKpp: randomUUID(),
      foreignNoKpp: randomUUID(),
    };

    let deliveryStatusId: string;
    let shipmentStatusId: string;

    async function newDelivery(): Promise<string> {
      const id = randomUUID();
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
              VALUES (${id}, ${siteId}, ${managerId}, ${deliveryStatusId}, now(), 1)`;
      return id;
    }

    async function newShipment(): Promise<string> {
      const id = randomUUID();
      await sql`INSERT INTO shipments (id, site_id, inspector_id, status_id, kind, shipped_at, version)
              VALUES (${id}, ${siteId}, ${managerId}, ${shipmentStatusId}, 'contractor', now(), 1)`;
      return id;
    }

    async function pick(
      entity: 'deliveries' | 'shipments',
      id: string,
      supplierDirectoryId: string,
    ): Promise<{ status: number; supplierId: string | null }> {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/${entity}/${id}/supplier-from-directory`,
        payload: { supplierDirectoryId },
      });
      const rows = await sql<{ supplier_id: string | null }[]>`
      SELECT supplier_id FROM ${sql(entity)} WHERE id = ${id}`;
      return { status: res.statusCode, supplierId: rows[0]?.supplier_id ?? null };
    }

    async function counterpartyOf(id: string | null) {
      const [row] = await sql<
        { name: string; inn: string; kpp: string | null; is_supplier: boolean }[]
      >`
      SELECT name, inn, kpp, is_supplier FROM counterparties WHERE id = ${id}`;
      return row;
    }

    beforeAll(async () => {
      sql = postgres(TEST_DATABASE_URL!, { max: 6 });
      app = Fastify({ logger: false });
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      app.decorate('db', drizzle(sql, { schema, casing: 'snake_case' }) as never);
      app.decorate('authenticate', async (req: { user?: AuthUser }) => {
        req.user = manager;
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

      await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`SFD${stamp}`}, 'Поставщик из справочника')`;
      await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`sfd-${managerId}@test`}, 'x', 'manager', NULL)`;

      await sql`INSERT INTO suppliers (id, inn, name) VALUES
      (${dir.many}, ${innMany}, 'ООО "ВСЕИНСТРУМЕНТЫ.РУ"'),
      (${dir.free}, ${innFree}, 'ООО "Вент-Профиль"'),
      (${dir.taken}, ${innTaken}, 'ООО "Вент-Профиль-2"'),
      (${dir.fresh}, ${innFresh}, 'ООО "Новый поставщик"')`;

      // 22204: под одним ИНН покупатели с чужими именами; «ЭСКАЛИФТ» — самый
      // старый, его и отдавал LIMIT 1.
      await sql`INSERT INTO counterparties (id, inn, kpp, name, is_customer, created_at) VALUES
      (${ids.escalift}, ${innMany}, '997750001', 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ЭСКАЛИФТ"', true, '2026-08-24'),
      (${randomUUID()}, ${innMany}, '502701001', 'СТРОИТЕЛЬНАЯ КОМПАНИЯ ЭСТ', true, '2026-08-25'),
      (${ids.viOld}, ${innMany}, '775101001', 'ООО «Всеинструменты.ру»', true, '2026-09-09'),
      (${ids.viNew}, ${innMany}, '771965904', 'ВсеИнструменты.ру', true, '2026-09-17'),
      (${randomUUID()}, ${innMany}, '772001001', 'ООО «МТ-СТРОЙГРУПП»', true, '2026-08-26'),
      (${ids.foreignWithKpp}, ${innFree}, '507401001', 'ООО "ЗМ ГРУПП"', true, '2026-08-28'),
      (${ids.foreignNoKpp}, ${innTaken}, NULL, 'ООО "ЗМ ГРУПП"', true, '2026-09-18')`;

      deliveryStatusId = (
        await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`
      )[0]!.id;
      shipmentStatusId = (
        await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'shipment' AND code = 'shipped' LIMIT 1`
      )[0]!.id;
    });

    afterAll(async () => {
      if (!sql) return;
      await app.close();
      await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
      await sql`DELETE FROM shipments WHERE site_id = ${siteId}`;
      await sql`DELETE FROM counterparties WHERE inn IN ${sql(inns)}`;
      await sql`DELETE FROM suppliers WHERE id IN ${sql(Object.values(dir))}`;
      await sql`DELETE FROM users WHERE id = ${managerId}`;
      await sql`DELETE FROM sites WHERE id = ${siteId}`;
      await sql.end({ timeout: 5 });
    });

    it('22204: из пяти строк под ИНН берётся строка с именем справочника, а не «ЭСКАЛИФТ»', async () => {
      const res = await pick('deliveries', await newDelivery(), dir.many);
      expect(res.status).toBe(200);
      // Две строки с совпавшим именем — самая старая.
      expect(res.supplierId).toBe(ids.viOld);
    });

    it('отгрузка выбирает так же', async () => {
      const res = await pick('shipments', await newShipment(), dir.many);
      expect(res.status).toBe(200);
      expect(res.supplierId).toBe(ids.viOld);
    });

    it('имени нет, место без КПП свободно — заводится строка с именем справочника', async () => {
      const res = await pick('deliveries', await newDelivery(), dir.free);
      expect(res.status).toBe(200);
      expect(res.supplierId).not.toBe(ids.foreignWithKpp);
      expect(await counterpartyOf(res.supplierId)).toEqual({
        name: 'ООО "Вент-Профиль"',
        inn: innFree,
        kpp: null,
        is_supplier: true,
      });
      // Повторный выбор находит её же по имени, второй не заводит.
      const again = await pick('shipments', await newShipment(), dir.free);
      expect(again.supplierId).toBe(res.supplierId);
    });

    it('ограничение: место без КПП занято чужим именем — остаётся прежний выбор', async () => {
      const res = await pick('deliveries', await newDelivery(), dir.taken);
      expect(res.status).toBe(200);
      expect(res.supplierId).toBe(ids.foreignNoKpp);
      const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM counterparties WHERE inn = ${innTaken}`;
      expect(n).toBe(1);
    });

    it('два одновременных выбора нового поставщика — одна строка и оба 200', async () => {
      const [a, b] = await Promise.all([
        newDelivery().then((id) => pick('deliveries', id, dir.fresh)),
        newShipment().then((id) => pick('shipments', id, dir.fresh)),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.supplierId).not.toBeNull();
      expect(b.supplierId).toBe(a.supplierId);
      const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM counterparties WHERE inn = ${innFresh}`;
      expect(n).toBe(1);
    });
  },
);
