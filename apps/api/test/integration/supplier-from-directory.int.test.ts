/**
 * Выбор поставщика из справочника в приёмке/отгрузке без документа
 * (PATCH /deliveries|shipments/:id/supplier-from-directory).
 *
 * 28.10, приёмка 22204: выбрали «ООО "ВСЕИНСТРУМЕНТЫ.РУ"», записался
 * «ЭСКАЛИФТ» — маршрут брал строку counterparties с тем же ИНН через LIMIT 1, а
 * под ИНН лежало пять покупателей с чужими именами. См. supplier-counterparty.ts.
 *
 * 24.11, приёмка 27099: поставщик без ИНН — 500. Строка с ИНН «0» одна на
 * таблицу (counterparty_inn_unique), и с 21.10 её заняла «СК "ЭСТ"». Теперь —
 * служебная строка с заглушкой «0000…» и ссылкой на запись справочника.
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
    const innVariant = `71${stamp}4`; // место без КПП — та же фирма с опечаткой
    const innMaster = `71${stamp}5`; // ООО «МАСТЕР» с настоящим ИНН
    const inns = [innMany, innFree, innTaken, innFresh, innVariant, innMaster];

    // Поставщики без ИНН (или с ОГРН в графе ИНН) — своя группа записей.
    const noInn = {
      plain: randomUUID(),
      ogrn: randomUUID(),
      masterAo: randomUUID(),
      race: randomUUID(),
      gone: randomUUID(),
      filter: randomUUID(),
    };
    const masterOoo = randomUUID();
    // Строка с ИНН «0»: если в общей тестовой БД её нет — заводим свою.
    let zeroCreated: string | null = null;

    const dir = {
      many: randomUUID(),
      free: randomUUID(),
      taken: randomUUID(),
      fresh: randomUUID(),
      variant: randomUUID(),
    };
    const ids = {
      escalift: randomUUID(),
      viOld: randomUUID(),
      viNew: randomUUID(),
      foreignWithKpp: randomUUID(),
      foreignNoKpp: randomUUID(),
      variantNoKpp: randomUUID(),
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
    ): Promise<{
      status: number;
      supplierId: string | null;
      body: { error?: string; message?: string };
    }> {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/${entity}/${id}/supplier-from-directory`,
        payload: { supplierDirectoryId },
      });
      const rows = await sql<{ supplier_id: string | null }[]>`
      SELECT supplier_id FROM ${sql(entity)} WHERE id = ${id}`;
      return {
        status: res.statusCode,
        supplierId: rows[0]?.supplier_id ?? null,
        body: res.json() as { error?: string; message?: string },
      };
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
      (${dir.fresh}, ${innFresh}, 'ООО "Новый поставщик"'),
      (${dir.variant}, ${innVariant}, 'ООО "КЕРАМЕС ГРУПП"')`;

      // 22204: под одним ИНН покупатели с чужими именами; «ЭСКАЛИФТ» — самый
      // старый, его и отдавал LIMIT 1.
      await sql`INSERT INTO counterparties (id, inn, kpp, name, is_customer, created_at) VALUES
      (${ids.escalift}, ${innMany}, '997750001', 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ЭСКАЛИФТ"', true, '2026-08-24'),
      (${randomUUID()}, ${innMany}, '502701001', 'СТРОИТЕЛЬНАЯ КОМПАНИЯ ЭСТ', true, '2026-08-25'),
      (${ids.viOld}, ${innMany}, '775101001', 'ООО «Всеинструменты.ру»', true, '2026-09-09'),
      (${ids.viNew}, ${innMany}, '771965904', 'ВсеИнструменты.ру', true, '2026-09-17'),
      (${randomUUID()}, ${innMany}, '772001001', 'ООО «МТ-СТРОЙГРУПП»', true, '2026-08-26'),
      (${ids.foreignWithKpp}, ${innFree}, '507401001', 'ООО "ЗМ ГРУПП"', true, '2026-08-28'),
      (${ids.foreignNoKpp}, ${innTaken}, NULL, 'ООО "ЗМ ГРУПП"', true, '2026-09-18'),
      (${ids.variantNoKpp}, ${innVariant}, NULL, 'ООО "КЕРАМЕС ГРУП"', true, '2026-08-24'),
      (${masterOoo}, ${innMaster}, NULL, ${`ООО "МАСТЕР ${stamp}"`}, true, '2026-08-24')`;

      await sql`INSERT INTO suppliers (id, inn, name) VALUES
      (${noInn.plain}, '', ${`ООО "БЕЗ ИНН ${stamp}"`}),
      (${noInn.ogrn}, '1237700057660', ${`ВегаСталь ${stamp}`}),
      (${noInn.masterAo}, '', ${`АО "МАСТЕР ${stamp}"`}),
      (${noInn.race}, ' ', ${`ООО "ГОНКА ${stamp}"`}),
      (${noInn.gone}, '', ${`ООО "УДАЛЁН ${stamp}"`}),
      (${noInn.filter}, '', ${`ООО "ФИЛЬТР ${stamp}"`})`;

      // 21.10 место «0» без КПП заняла «СК "ЭСТ"» — так же и здесь.
      const [zero] = await sql<{ id: string }[]>`
      INSERT INTO counterparties (inn, kpp, name, is_supplier)
      VALUES ('0', NULL, 'ООО "СТРОИТЕЛЬНАЯ КОМПАНИЯ "ЭСТ"', true)
      ON CONFLICT DO NOTHING RETURNING id`;
      zeroCreated = zero?.id ?? null;

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
      await sql`DELETE FROM counterparties
                WHERE supplier_directory_id IN ${sql(Object.values(noInn))}`;
      if (zeroCreated) await sql`DELETE FROM counterparties WHERE id = ${zeroCreated}`;
      await sql`DELETE FROM suppliers WHERE id IN ${sql([...Object.values(dir), ...Object.values(noInn)])}`;
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

    // 17.11, приёмка 25616: под ИНН «Высоты» лежала строка «ИП Сатаневский»
    // (грузополучатель из накладной), и выбор «Высоты» молча ставил её.
    // Теперь — отказ с тем, что записано под ИНН; поставщик не меняется.
    for (const entity of ['deliveries', 'shipments'] as const) {
      it(`${entity}: место без КПП занято чужим именем → 409, поставщик прежний`, async () => {
        const id = entity === 'deliveries' ? await newDelivery() : await newShipment();
        const before = await pick(entity, id, dir.many);
        expect(before.status).toBe(200);
        expect(before.supplierId).not.toBeNull();

        const res = await pick(entity, id, dir.taken);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('supplier_inn_taken');
        expect(res.body.message).toContain(innTaken);
        expect(res.body.message).toContain('ООО "ЗМ ГРУПП"');
        expect(res.supplierId).toBe(before.supplierId);
        const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM counterparties WHERE inn = ${innTaken}`;
        expect(n).toBe(1);
      });
    }

    // Ревью 5a3fb00: отказ — только при действительно другой организации.
    // «КЕРАМЕС ГРУП» в месте без КПП — та же фирма с опечаткой, выбор проходит.
    it('место без КПП занято той же фирмой в другом написании → 200, эта строка', async () => {
      const res = await pick('deliveries', await newDelivery(), dir.variant);
      expect(res.status).toBe(200);
      expect(res.supplierId).toBe(ids.variantNoKpp);
      const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM counterparties WHERE inn = ${innVariant}`;
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

    describe('поставщик без ИНН (приёмка 27099)', () => {
      async function serviceRow(id: string | null) {
        const [row] = await sql<
          {
            inn: string;
            kpp: string | null;
            name: string;
            is_supplier: boolean;
            supplier_directory_id: string | null;
          }[]
        >`
        SELECT inn, kpp, name, is_supplier, supplier_directory_id
          FROM counterparties WHERE id = ${id}`;
        return row;
      }

      async function serviceCount(directoryId: string): Promise<number> {
        const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM counterparties WHERE supplier_directory_id = ${directoryId}`;
        return row!.n;
      }

      it('место «0» занято чужим именем → 200, служебная строка с заглушкой и ссылкой', async () => {
        const [zeros] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM counterparties WHERE inn = '0' AND kpp IS NULL`;
        expect(zeros!.n).toBe(1);

        const res = await pick('deliveries', await newDelivery(), noInn.plain);
        expect(res.status).toBe(200);
        const row = await serviceRow(res.supplierId);
        expect(row).toMatchObject({
          kpp: null,
          name: `ООО "БЕЗ ИНН ${stamp}"`,
          is_supplier: true,
          supplier_directory_id: noInn.plain,
        });
        expect(row!.inn).toMatch(/^0000[0-9a-f]{8}$/);
      });

      it('тот же поставщик в другой приёмке и в отгрузке → та же строка', async () => {
        const first = await pick('deliveries', await newDelivery(), noInn.plain);
        const second = await pick('shipments', await newShipment(), noInn.plain);
        expect([first.status, second.status]).toEqual([200, 200]);
        expect(second.supplierId).toBe(first.supplierId);
        expect(await serviceCount(noInn.plain)).toBe(1);
      });

      it('в графе ИНН 13 цифр (ОГРН) → как без ИНН, а не 500 на varchar(12)', async () => {
        const res = await pick('deliveries', await newDelivery(), noInn.ogrn);
        expect(res.status).toBe(200);
        const row = await serviceRow(res.supplierId);
        expect(row!.inn).toMatch(/^0000[0-9a-f]{8}$/);
        expect(row!.supplier_directory_id).toBe(noInn.ogrn);
      });

      it('АО без ИНН не получает строку ООО с тем же названием', async () => {
        const res = await pick('deliveries', await newDelivery(), noInn.masterAo);
        expect(res.status).toBe(200);
        expect(res.supplierId).not.toBe(masterOoo);
        const row = await serviceRow(res.supplierId);
        expect(row).toMatchObject({
          name: `АО "МАСТЕР ${stamp}"`,
          supplier_directory_id: noInn.masterAo,
        });
      });

      it('одновременный выбор в двух приёмках и отгрузке — одна строка, все 200', async () => {
        const [d1, d2, s1] = await Promise.all([newDelivery(), newDelivery(), newShipment()]);
        const results = await Promise.all([
          pick('deliveries', d1, noInn.race),
          pick('deliveries', d2, noInn.race),
          pick('shipments', s1, noInn.race),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
        expect(new Set(results.map((r) => r.supplierId)).size).toBe(1);
        expect(await serviceCount(noInn.race)).toBe(1);
      });

      // По ИНН такую операцию не найти — фильтр ищет служебную строку по ссылке.
      it('фильтр «Поставщик» находит приёмку и отгрузку с таким поставщиком', async () => {
        const deliveryId = await newDelivery();
        const shipmentId = await newShipment();
        const other = await newDelivery();
        expect((await pick('deliveries', deliveryId, noInn.filter)).status).toBe(200);
        expect((await pick('shipments', shipmentId, noInn.filter)).status).toBe(200);
        expect((await pick('deliveries', other, noInn.plain)).status).toBe(200);

        for (const [entity, id] of [
          ['deliveries', deliveryId],
          ['shipments', shipmentId],
        ] as const) {
          const res = await app.inject({
            method: 'GET',
            url: `/api/v1/${entity}?siteIds=${siteId}&supplierIds=${noInn.filter}&limit=200`,
          });
          expect(res.statusCode).toBe(200);
          const ids = (res.json() as { items: { id: string }[] }).items.map((r) => r.id);
          expect(ids).toEqual([id]);
        }
      });

      it('запись справочника удалена → 404 supplier_not_found, поставщик прежний', async () => {
        await sql`DELETE FROM suppliers WHERE id = ${noInn.gone}`;
        const id = await newDelivery();
        const res = await pick('deliveries', id, noInn.gone);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('supplier_not_found');
        expect(res.supplierId).toBeNull();
      });
    });
  },
);
