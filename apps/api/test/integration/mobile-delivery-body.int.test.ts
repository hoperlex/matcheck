/**
 * Тело «Завершить 1 Этап» планшета 1.0.41 → POST /api/v1/deliveries.
 *
 * Зачем: сборку планшета нельзя откатить (меньший versionCode поверх не
 * ставится, а база Room 27 не открывается старой сборкой). Поэтому формат
 * запроса новой сборки проверяется против НАСТОЯЩЕГО маршрута до раскатки:
 * схема zod, заголовки, протокол «одна машина — одна приёмка».
 *
 * Эталон STAGE1_BODY_1_0_41 — дословная копия строки из теста планшета
 * matcheck.mobile `GroupProtocolHttpTest` («тело 1 Этапа по сети совпадает с
 * эталоном серверного теста»), который сверяет её с тем, что реально уходит по
 * сети (очередь → MutationProcessor → Retrofit). Поменялся формат на планшете —
 * падает тот тест, и эталон обновляется в ОБОИХ местах.
 *
 * Идентификаторы эталона подменяются свежими (объект, поставщик, документы,
 * машина): ключи, типы и форма тела остаются ровно как у планшета.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

vi.mock('../../src/instrument.js', () => ({}));

// Окружение читается и кешируется при импорте модулей (loadEnv), поэтому —
// vi.hoisted: защищённый объект известен раньше, чем загрузится маршрут.
const env = vi.hoisted(() => {
  const protectedSite = globalThis.crypto.randomUUID();
  process.env.GROUPS_ROLLOUT = '1';
  delete process.env.GROUPS_ROLLOUT_SINCE;
  process.env.GROUP_CLAIM_SITES = protectedSite;
  process.env.MACHINE_MERGE_SITES = '';
  return { protectedSite };
});

/** Копия эталона из matcheck.mobile GroupProtocolHttpTest.STAGE1_BODY_1_0_41. */
const STAGE1_BODY_1_0_41 = `{
  "id": "0b0b0b0b-0000-4000-8000-000000000001",
  "statusCode": "filled",
  "siteId": "5e5e5e5e-0000-4000-8000-000000000001",
  "supplierId": "50505050-0000-4000-8000-000000000001",
  "vehiclePlate": "А111АА77",
  "arrivedAt": "2026-11-24T08:15:30.123456Z",
  "comment": "1 Этап: \\"без замечаний\\"",
  "sourceDocumentIds": ["d0c00000-0000-4000-8000-000000000001", "d0c00000-0000-4000-8000-000000000002"],
  "items": [
    {
      "id": "17e70000-0000-4000-8000-000000000001",
      "sourceDocumentId": "d0c00000-0000-4000-8000-000000000001",
      "sourceDocumentItemId": "5d170000-0000-4000-8000-000000000001",
      "nameRaw": "Арматура А500С d12",
      "qtyActual": "10.5",
      "unit": "т",
      "lineNo": 1,
      "price": "65000.00",
      "vatRate": "20",
      "vatSum": "136500.00"
    },
    {
      "id": "17e70000-0000-4000-8000-000000000002",
      "sourceDocumentId": "d0c00000-0000-4000-8000-000000000002",
      "sourceDocumentItemId": "5d170000-0000-4000-8000-000000000002",
      "nameRaw": "Цемент М500",
      "qtyActual": "40",
      "lineNo": 2,
      "price": "450",
      "vatRate": "20",
      "vatSum": "3600"
    }
  ],
  "baseVersion": 0,
  "capabilities": "source_groups_v1,group_claim_v1",
  "groupId": "9a9a9a9a-0000-4000-8000-000000000001",
  "groupRevision": 1
}`;

/** Поля, которых у 1.0.40 не было: без них — тело старой сборки. */
const GROUP_FIELDS = ['capabilities', 'groupId', 'groupRevision'] as const;

const CAPABILITIES = 'source_groups_v1,group_claim_v1';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite(
  'тело 1 Этапа планшета 1.0.41 → POST /api/v1/deliveries (реальный PostgreSQL)',
  { timeout: 60_000 },
  () => {
    let app: FastifyInstance;
    let sql: ReturnType<typeof postgres>;
    let currentUser: AuthUser;

    const openSite = randomUUID();
    const protectedSite = env.protectedSite;
    const supplierId = randomUUID();
    const inspectorId = randomUUID();
    const sessionId = randomUUID();

    type Machine = {
      root: string;
      revision: number;
      docs: [string, string];
      items: [string, string];
    };

    /** Машина из двух УПД одной отправки с портала — как её видит планшет в /sync. */
    async function seedMachine(siteId: string): Promise<Machine> {
      const root = randomUUID();
      await sql`INSERT INTO source_bundles (id, bundle_hash, direction, site_id, status, kind,
              assembly_version, active_upload_generation, expected_date)
              VALUES (${root}, ${`mb${root.replace(/-/g, '')}`.slice(0, 64)}, 'inbound', ${siteId},
                      'parsed', 'mixed', 'legacy', 0, '2026-11-24')`;
      await sql`INSERT INTO ingest_events (bundle_id, channel, public_ticket)
              VALUES (${root}, 'public', ${randomUUID().slice(0, 20)})`;
      const docs: string[] = [];
      const items: string[] = [];
      for (const [i, name] of ['Арматура А500С d12', 'Цемент М500'].entries()) {
        const id = randomUUID();
        const itemId = randomUUID();
        await sql`INSERT INTO source_documents (id, kind, is_technical, direction, origin, status,
                site_id, supplier_id, parsed_at, doc_number, doc_date, total_sum, bundle_id, expected_date)
                VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, ${supplierId},
                        now(), ${`MB-${id.slice(0, 6)}`}, now(), 100, ${root}, '2026-11-24')`;
        await sql`INSERT INTO source_document_items (id, source_document_id, name_raw, qty, unit, price, sum, line_no)
                VALUES (${itemId}, ${id}, ${name}, ${i === 0 ? 10.5 : 40}, ${i === 0 ? 'т' : 'шт'},
                        ${i === 0 ? 65000 : 450}, 100, 1)`;
        docs.push(id);
        items.push(itemId);
      }
      const [r] = await sql<{ group_revision: number }[]>`
      SELECT group_revision FROM source_bundles WHERE id = ${root}`;
      return {
        root,
        revision: Number(r!.group_revision),
        docs: docs as [string, string],
        items: items as [string, string],
      };
    }

    /**
     * Эталон планшета с идентификаторами живой машины. Ключи и типы не трогаем:
     * подмена идёт по значениям строк, ревизия — числом.
     */
    function tabletBody(m: Machine, siteId: string, opts: { legacy?: boolean } = {}) {
      const ids = new Map<string, string>([
        ['0b0b0b0b-0000-4000-8000-000000000001', randomUUID()],
        ['5e5e5e5e-0000-4000-8000-000000000001', siteId],
        ['50505050-0000-4000-8000-000000000001', supplierId],
        ['d0c00000-0000-4000-8000-000000000001', m.docs[0]],
        ['d0c00000-0000-4000-8000-000000000002', m.docs[1]],
        ['5d170000-0000-4000-8000-000000000001', m.items[0]],
        ['5d170000-0000-4000-8000-000000000002', m.items[1]],
        ['17e70000-0000-4000-8000-000000000001', randomUUID()],
        ['17e70000-0000-4000-8000-000000000002', randomUUID()],
        ['9a9a9a9a-0000-4000-8000-000000000001', m.root],
      ]);
      const body = JSON.parse(STAGE1_BODY_1_0_41, (_k, v: unknown) =>
        typeof v === 'string' && ids.has(v) ? ids.get(v) : v,
      ) as Record<string, unknown>;
      body.groupRevision = m.revision;
      if (opts.legacy) for (const f of GROUP_FIELDS) delete body[f];
      return body as Record<string, unknown> & { id: string };
    }

    /** Заголовки, которые ставит AuthHeaderInterceptor планшета. */
    const post = (body: Record<string, unknown>, opts: { capabilitiesHeader: boolean }) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/deliveries',
        payload: body,
        headers: {
          'x-client-type': 'mobile',
          ...(opts.capabilitiesHeader ? { 'x-matcheck-capabilities': CAPABILITIES } : {}),
        },
      });

    const asInspectorOf = (siteId: string) => {
      currentUser = {
        id: inspectorId,
        role: 'inspector_kpp',
        siteId,
        contractorCustomerId: null,
        sessionId,
      };
    };

    async function claimsOf(root: string) {
      return await sql<{ delivery_id: string }[]>`
      SELECT delivery_id FROM operation_group_claims WHERE group_id = ${root}`;
    }

    async function cleanup() {
      for (const s of [openSite, protectedSite]) {
        await sql`DELETE FROM operation_group_claims WHERE group_id IN (SELECT id FROM source_bundles WHERE site_id = ${s})`;
        await sql`DELETE FROM deliveries WHERE site_id = ${s}`;
        await sql`DELETE FROM source_document_items WHERE source_document_id IN (SELECT id FROM source_documents WHERE site_id = ${s})`;
        await sql`DELETE FROM source_documents WHERE site_id = ${s}`;
        await sql`DELETE FROM ingest_events WHERE bundle_id IN (SELECT id FROM source_bundles WHERE site_id = ${s})`;
        await sql`DELETE FROM source_bundles WHERE site_id = ${s}`;
      }
    }

    beforeAll(async () => {
      sql = postgres(TEST_DATABASE_URL!, { max: 4 });
      const db = drizzle(sql, { schema, casing: 'snake_case' });
      const { deliveryRoutes } = await import('../../src/routes/deliveries.js');

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
      await app.ready();

      const code = `MB${Date.now() % 100000}`;
      await sql`INSERT INTO sites (id, code, name) VALUES (${openSite}, ${`${code}O`}, 'Без защиты')`;
      await sql`INSERT INTO sites (id, code, name) VALUES (${protectedSite}, ${`${code}P`}, 'С защитой')`;
      // supplierId планшета — контрагент из УПД (counterparties), не справочник suppliers.
      await sql`INSERT INTO counterparties (id, inn, name)
      VALUES (${supplierId}, ${`77${String(Date.now()).slice(-8)}`}, 'ООО Поставщик эталона')`;
      await sql`INSERT INTO users (id, email, password_hash, role, site_id)
      VALUES (${inspectorId}, ${`mb-${inspectorId}@test`}, 'x', 'inspector_kpp', ${openSite})`;
      // created_by_session_id ссылается на sessions — в бою её создаёт plugins/auth.ts.
      await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${inspectorId})`;
    });

    afterAll(async () => {
      await app?.close();
      if (!sql) return;
      await cleanup();
      await sql`DELETE FROM sessions WHERE user_id = ${inspectorId}`;
      await sql`DELETE FROM users WHERE id = ${inspectorId}`;
      await sql`DELETE FROM counterparties WHERE id = ${supplierId}`;
      await sql`DELETE FROM sites WHERE id IN (${openSite}, ${protectedSite})`;
      await sql.end({ timeout: 5 });
    });

    beforeEach(cleanup);

    it('объект без защиты: тело 1.0.41 принято целиком, машина не занимается', async () => {
      asInspectorOf(openSite);
      const m = await seedMachine(openSite);
      const body = tabletBody(m, openSite);

      const res = await post(body, { capabilitiesHeader: true });
      expect(res.statusCode, res.body).toBe(200);

      const [d] = await sql<
        {
          status: string;
          supplier_id: string;
          vehicle_plate: string;
          comment: string;
          arrived_at: string | Date;
        }[]
      >`SELECT s.code AS status, d.supplier_id, d.vehicle_plate, d.comment, d.arrived_at
        FROM deliveries d JOIN statuses s ON s.id = d.status_id WHERE d.id = ${body.id}`;
      expect(d).toMatchObject({
        status: 'filled',
        supplier_id: supplierId,
        vehicle_plate: 'А111АА77',
        comment: '1 Этап: "без замечаний"',
      });
      // Микросекунды планшета (Instant.toString) сервер принимает; сверяем до миллисекунд (Date).
      expect(new Date(d!.arrived_at).toISOString()).toBe('2026-11-24T08:15:30.123Z');

      const items = await sql<
        {
          name_raw: string;
          qty_actual: string;
          unit: string;
          source_document_id: string;
          source_document_item_id: string;
          price: string;
          vat_sum: string;
        }[]
      >`SELECT name_raw, qty_actual, unit, source_document_id, source_document_item_id, price, vat_sum
        FROM delivery_items WHERE delivery_id = ${body.id} ORDER BY line_no`;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        name_raw: 'Арматура А500С d12',
        unit: 'т',
        source_document_id: m.docs[0],
        source_document_item_id: m.items[0],
      });
      expect(Number(items[0]!.qty_actual)).toBe(10.5);
      expect(Number(items[0]!.price)).toBe(65000);
      // unit "шт" планшет не шлёт (значение по умолчанию) — сервер ставит сам.
      expect(items[1]).toMatchObject({ unit: 'шт', source_document_id: m.docs[1] });
      expect(Number(items[1]!.vat_sum)).toBe(3600);

      const sources = await sql<{ source_document_id: string }[]>`
      SELECT source_document_id FROM delivery_sources WHERE delivery_id = ${body.id}`;
      expect(sources.map((s) => s.source_document_id).sort()).toEqual([...m.docs].sort());
      expect(await claimsOf(m.root)).toHaveLength(0);
    });

    it('объект без защиты: тело 1.0.40 без заголовка — как раньше', async () => {
      asInspectorOf(openSite);
      const m = await seedMachine(openSite);
      const body = tabletBody(m, openSite, { legacy: true });
      expect(body).not.toHaveProperty('groupId');

      const res = await post(body, { capabilitiesHeader: false });
      expect(res.statusCode, res.body).toBe(200);
      expect((await sql`SELECT 1 FROM delivery_items WHERE delivery_id = ${body.id}`).length).toBe(
        2,
      );
    });

    it('объект с защитой: 1.0.41 занимает машину, второй планшет получает полный group_claimed', async () => {
      asInspectorOf(protectedSite);
      const m = await seedMachine(protectedSite);
      const first = tabletBody(m, protectedSite);

      const ok = await post(first, { capabilitiesHeader: true });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await claimsOf(m.root)).map((c) => c.delivery_id)).toEqual([first.id]);

      // Второй планшет оформлял ту же машину офлайн: своя приёмка, тот же состав.
      const second = tabletBody(m, protectedSite);
      const res = await post(second, { capabilitiesHeader: true });
      expect(res.statusCode).toBe(409);
      // Тело целиком: по claimedAt планшет пишет «машину уже оформил другой
      // планшет (HH:MM)». Схема ответа не должна его обрезать.
      expect(res.json()).toMatchObject({
        error: 'group_claimed',
        groupId: m.root,
        claimedByOperationId: first.id,
        claimedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect((await sql`SELECT 1 FROM deliveries WHERE id = ${second.id}`).length).toBe(0);
    });

    it('объект с защитой: тело 1.0.40 без заголовка — как раньше, без занятия машины', async () => {
      asInspectorOf(protectedSite);
      const m = await seedMachine(protectedSite);
      const body = tabletBody(m, protectedSite, { legacy: true });

      const res = await post(body, { capabilitiesHeader: false });
      expect(res.statusCode, res.body).toBe(200);
      expect((await sql`SELECT 1 FROM delivery_items WHERE delivery_id = ${body.id}`).length).toBe(
        2,
      );
      expect(await claimsOf(m.root)).toHaveLength(0);
    });

    it('объект с защитой: тело 1.0.40 из «Очереди», отправленное уже обновлённым приложением — принято, машина занята', async () => {
      asInspectorOf(protectedSite);
      const m = await seedMachine(protectedSite);
      const body = tabletBody(m, protectedSite, { legacy: true });

      const res = await post(body, { capabilitiesHeader: true });
      expect(res.statusCode, res.body).toBe(200);
      expect((await sql`SELECT 1 FROM delivery_items WHERE delivery_id = ${body.id}`).length).toBe(
        2,
      );
      expect((await claimsOf(m.root)).map((c) => c.delivery_id)).toEqual([body.id]);
    });
  },
);
