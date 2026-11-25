/**
 * Связи «подрядчик × объект → вид» (0159) на настоящем PostgreSQL:
 *   - импорт 1С: dry-run ничего не пишет, apply пишет только onec_*, повтор пуст,
 *     ручной вид переживает повторную загрузку, пропавшая пара снимается или
 *     удаляется, откат по снимку возвращает прежний слой, второй импорт → busy;
 *   - карточка (PATCH/POST /customer-counterparties): неизменённая строка 1С не
 *     становится «ручной», смена вида → ручной, убранная строка 1С скрывается и
 *     загрузка её не возвращает, 409 на устаревшую версию, 422 на плохие объекты;
 *   - гонки: два PATCH с одной версией → ровно один 409; PATCH во время импорта
 *     ждёт его и отвечает 409 (не 500 и не взаимная блокировка);
 *   - видимость: список без ?withSites=1 связей не отдаёт, наблюдатель видит
 *     только свои объекты, суммы 1С — только admin/manager.
 *
 * Импорт работает по всей таблице, поэтому набор создаёт свою базу на сервере
 * TEST_DATABASE_URL, накатывает миграции и удаляет базу в конце.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CustomerCounterparty } from '@matcheck/contracts';
import type { Db } from '../../src/db/client.js';
import * as schema from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import { customerCounterpartyRoutes } from '../../src/routes/customer-counterparties.js';
import {
  ContractorSitesImportError,
  runContractorSitesImport,
  type ImportOptions,
} from '../../src/domain/contractor-sites/apply.js';
import {
  snapshotTarget,
  type ContractorSitesSnapshot,
  type OnecLayer,
  type TargetEntry,
} from '../../src/domain/contractor-sites/plan.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

function layer(kind: OnecLayer['kind'], rd: number, td: number, sum = '100.50'): OnecLayer {
  return {
    kind,
    realizationDocs: rd,
    realizationSum: rd > 0 ? sum : '0.00',
    tollingDocs: td,
    tollingSum: td > 0 ? sum : '0.00',
    objects: ['ОБЪЕКТ В 1С'],
  };
}

suite('связи подрядчик × объект на PostgreSQL', () => {
  const dbName = `matcheck_cc_sites_${Date.now()}`;
  let admin: Sql;
  let sql: Sql;
  let db: Db;
  let app: FastifyInstance;
  const userId = randomUUID();
  let currentUser: AuthUser;
  const siteA = randomUUID();
  const siteB = randomUUID();
  const siteC = randomUUID();
  let ccX: string;
  let ccY: string;

  const asRole = (role: AuthUser['role'], siteIds: string[] = []) => {
    currentUser = {
      id: userId,
      role,
      siteId: null,
      contractorCustomerId: null,
      siteIds,
    } as unknown as AuthUser;
  };

  beforeAll(async () => {
    admin = postgres(TEST_DATABASE_URL!, { max: 1 });
    await admin.unsafe(`create database ${dbName}`);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${dbName}`;
    execFileSync('node_modules/.bin/tsx', ['scripts/migrate.ts'], {
      env: { ...process.env, DATABASE_URL: url.toString() },
      stdio: 'ignore',
    });
    sql = postgres(url.toString(), { max: 6, onnotice: () => {} });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    await sql`insert into users (id, email, password_hash) values (${userId}, ${`cc-sites-${dbName}@test`}, 'x')`;
    await sql`insert into sites (id, code, name, is_active) values
                (${siteA}, 'СВА', 'Объект А', true),
                (${siteB}, 'СВБ', 'Объект Б', true),
                (${siteC}, 'СВВ', 'Объект В (закрыт)', false)`;

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate('authorize', () => async () => undefined);
    await app.register(customerCounterpartyRoutes);
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 5 });
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    asRole('manager');
    await sql`delete from customer_counterparty_sites`;
    await sql`update users set contractor_customer_id = null`;
    await sql`delete from customer_counterparties`;
    ccX = randomUUID();
    ccY = randomUUID();
    await sql`insert into customer_counterparties (id, inn, name) values
                (${ccX}, '', 'ООО "ИКС ТЕСТ"'), (${ccY}, '', 'ООО "ИГРЕК ТЕСТ"')`;
  });

  const entry = (ccId: string, siteId: string, l: OnecLayer): TargetEntry => ({
    ccId,
    siteId,
    layer: l,
    loadedAt: null,
    rowNos: [],
  });

  async function importEntries(entries: TargetEntry[], extra: Partial<ImportOptions> = {}) {
    const build = () => ({ entries });
    const dry = await runContractorSitesImport(db, build, { apply: false });
    return runContractorSitesImport(db, build, {
      ...extra,
      apply: true,
      confirm: dry.plan.fingerprint.slice(0, 16),
    });
  }

  async function tableRows() {
    return sql`select customer_counterparty_id as cc, site_id as site, onec_kind, onec_realization_docs,
                      onec_realization_sum::text as rs, onec_tolling_docs, onec_tolling_sum::text as ts,
                      onec_objects, manual_kind
                 from customer_counterparty_sites order by 1, 2`;
  }

  async function getList(withSites = true): Promise<CustomerCounterparty[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customer-counterparties?limit=5000${withSites ? '&withSites=1' : ''}`,
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: CustomerCounterparty[] }).items;
  }

  async function card(id: string): Promise<CustomerCounterparty> {
    return (await getList()).find((c) => c.id === id)!;
  }

  function patch(id: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/api/v1/customer-counterparties/${id}`,
      payload: body,
    });
  }

  describe('импорт', () => {
    it('dry-run ничего не пишет; apply пишет; повтор пуст', async () => {
      const entries = [
        entry(ccX, siteA, layer('realization', 3, 0)),
        entry(ccY, siteB, layer('tolling_act', 0, 2)),
      ];
      const dry = await runContractorSitesImport(db, () => ({ entries }), { apply: false });
      expect(dry.plan.counts.insert).toBe(2);
      expect(dry.tableMissing).toBe(false);
      expect(await tableRows()).toEqual([]);

      const r = await importEntries(entries);
      expect(r.applied).toBe(true);
      const rows = await tableRows();
      expect(rows).toHaveLength(2);
      expect(rows.find((x) => x.cc === ccX)).toMatchObject({
        onec_kind: 'realization',
        onec_realization_docs: 3,
        rs: '100.50',
        ts: '0.00',
        manual_kind: null,
      });

      const again = await runContractorSitesImport(db, () => ({ entries }), { apply: false });
      expect(again.plan.ops).toEqual([]);
      expect(again.plan.unchanged).toBe(2);
    });

    it('ручной вид переживает повторную загрузку; данные 1С обновляются', async () => {
      await importEntries([entry(ccX, siteA, layer('realization', 3, 0))]);
      const c = await card(ccX);
      expect(
        (
          await patch(ccX, {
            sites: [{ siteId: siteA, kind: 'tolling_act' }],
            sitesVersion: c.sitesVersion,
          })
        ).statusCode,
      ).toBe(200);
      await importEntries([entry(ccX, siteA, layer('realization_tolling', 5, 1))]);
      const [row] = await tableRows();
      expect(row).toMatchObject({
        onec_kind: 'realization_tolling',
        onec_realization_docs: 5,
        manual_kind: 'tolling_act',
      });
      expect((await card(ccX)).sites).toMatchObject([{ kind: 'tolling_act', manual: true }]);
    });

    it('пары нет в файле: ручная — снимаются данные 1С, остальные и скрытые — удаляются', async () => {
      await importEntries([
        entry(ccX, siteA, layer('realization', 3, 0)),
        entry(ccX, siteB, layer('realization', 1, 0)),
        entry(ccY, siteA, layer('tolling_act', 0, 1)),
      ]);
      await sql`update customer_counterparty_sites set manual_kind = 'tolling_act', manual_at = now()
                 where customer_counterparty_id = ${ccX} and site_id = ${siteA}`;
      await sql`update customer_counterparty_sites set manual_kind = 'none', manual_at = now()
                 where customer_counterparty_id = ${ccY} and site_id = ${siteA}`;
      const r = await importEntries([]);
      expect(r.plan.counts).toEqual({ insert: 0, update: 0, clear: 1, delete: 2 });
      expect(await tableRows()).toEqual([
        expect.objectContaining({
          cc: ccX,
          site: siteA,
          onec_kind: null,
          onec_objects: [],
          manual_kind: 'tolling_act',
        }),
      ]);
    });

    it('откат по снимку возвращает прежний слой 1С, ручной вид не трогает', async () => {
      await importEntries([entry(ccX, siteA, layer('realization', 3, 0))]);
      await sql`update customer_counterparty_sites set manual_kind = 'realization_tolling', manual_at = now()`;
      const before = await tableRows();
      let snap: ContractorSitesSnapshot | null = null;
      await importEntries([entry(ccX, siteB, layer('tolling_act', 0, 4))], {
        beforeWrite: async (s) => {
          snap = s;
        },
      });
      expect(snap!.layer).toHaveLength(1);
      expect(await tableRows()).not.toEqual(before);

      const target = snapshotTarget(JSON.parse(JSON.stringify(snap)));
      const dry = await runContractorSitesImport(db, () => target, { apply: false });
      await runContractorSitesImport(db, () => target, {
        apply: true,
        confirm: dry.plan.fingerprint.slice(0, 16),
      });
      expect(await tableRows()).toEqual(before);
    });

    it('второй импорт во время первого — busy; план изменился — fingerprint; ничего не записано', async () => {
      const entries = [entry(ccX, siteA, layer('realization', 3, 0))];
      const dry = await runContractorSitesImport(db, () => ({ entries }), { apply: false });
      const confirm = dry.plan.fingerprint.slice(0, 16);
      let inner: unknown = null;
      await runContractorSitesImport(db, () => ({ entries }), {
        apply: true,
        confirm,
        afterLock: async () => {
          inner = await runContractorSitesImport(db, () => ({ entries }), {
            apply: true,
            confirm,
          }).catch((e: unknown) => e);
        },
      });
      expect(inner).toBeInstanceOf(ContractorSitesImportError);
      expect((inner as ContractorSitesImportError).code).toBe('busy');

      await sql`delete from customer_counterparty_sites`;
      await expect(
        runContractorSitesImport(db, () => ({ entries }), {
          apply: true,
          confirm: '0000000000000000',
        }),
      ).rejects.toMatchObject({ code: 'fingerprint' });
      expect(await tableRows()).toEqual([]);
    });
  });

  describe('карточка', () => {
    it('список без withSites связей не отдаёт; POST/PATCH без sites отдают версию', async () => {
      await importEntries([entry(ccX, siteA, layer('realization', 3, 0))]);
      const plain = (await getList(false)).find((c) => c.id === ccX)!;
      expect(plain.sites).toBeUndefined();
      expect(plain.sitesVersion).toBeUndefined();

      const renamed = await patch(ccX, { name: 'ООО "ИКС НОВОЕ"' });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json()).toMatchObject({
        name: 'ООО "ИКС НОВОЕ"',
        sites: [{ siteCode: 'СВА' }],
      });
      expect(typeof renamed.json().sitesVersion).toBe('string');

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/customer-counterparties',
        payload: { name: 'ООО "НОВЫЙ"', sites: [{ siteId: siteB, kind: 'realization' }] },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        sites: [{ siteId: siteB, kind: 'realization', manual: true, onec: null }],
      });
      const bare = await app.inject({
        method: 'POST',
        url: '/api/v1/customer-counterparties',
        payload: { name: 'ООО "БЕЗ ОБЪЕКТОВ"' },
      });
      expect(bare.statusCode).toBe(201);
      expect(bare.json()).toMatchObject({ sites: [] });
      expect(typeof bare.json().sitesVersion).toBe('string');
    });

    it('правка списка: без изменений, смена вида, скрытие строки 1С, удаление ручной, возврат скрытой', async () => {
      await importEntries([
        entry(ccX, siteA, layer('realization', 3, 0)),
        entry(ccX, siteB, layer('tolling_act', 0, 2)),
      ]);
      let c = await card(ccX);
      expect(c.sites!.map((s) => [s.siteCode, s.kind, s.manual])).toEqual([
        ['СВА', 'realization', false],
        ['СВБ', 'tolling_act', false],
      ]);

      // Тот же список — строки остаются строками 1С.
      let res = await patch(ccX, {
        sites: [
          { siteId: siteA, kind: 'realization' },
          { siteId: siteB, kind: 'tolling_act' },
        ],
        sitesVersion: c.sitesVersion,
      });
      expect(res.statusCode).toBe(200);
      expect((await tableRows()).map((r) => r.manual_kind)).toEqual([null, null]);

      // А: смена вида → ручной; Б убрали → скрыта; В добавили → ручная.
      c = await card(ccX);
      res = await patch(ccX, {
        sites: [
          { siteId: siteA, kind: 'tolling_act' },
          { siteId: siteC, kind: 'realization' },
        ],
        sitesVersion: c.sitesVersion,
      });
      expect(res.statusCode).toBe(200);
      expect(
        (res.json() as CustomerCounterparty).sites!.map((s) => [s.siteCode, s.kind, s.manual]),
      ).toEqual([
        ['СВА', 'tolling_act', true],
        // Закрытый объект — в конце.
        ['СВВ', 'realization', true],
      ]);
      const byId = new Map((await tableRows()).map((r) => [r.site, r.manual_kind]));
      expect(byId.get(siteB)).toBe('none');
      expect((await userRef()).every((u) => u === userId)).toBe(true);

      // Повторная загрузка скрытую строку не возвращает.
      await importEntries([
        entry(ccX, siteA, layer('realization', 3, 0)),
        entry(ccX, siteB, layer('tolling_act', 0, 2)),
      ]);
      expect((await card(ccX)).sites!.map((s) => s.siteCode)).toEqual(['СВА', 'СВВ']);

      // Убрали ручную без 1С → строка удалена; вернули скрытую → видна, ручная.
      c = await card(ccX);
      res = await patch(ccX, {
        sites: [
          { siteId: siteA, kind: 'tolling_act' },
          { siteId: siteB, kind: 'tolling_act' },
        ],
        sitesVersion: c.sitesVersion,
      });
      expect(res.statusCode).toBe(200);
      const rows = await tableRows();
      expect(rows.map((r) => [r.site, r.manual_kind]).sort()).toEqual(
        [
          [siteA, 'tolling_act'],
          [siteB, 'tolling_act'],
        ].sort(),
      );
    });

    async function userRef(): Promise<string[]> {
      return (
        await sql<
          { u: string }[]
        >`select manual_by_user_id as u from customer_counterparty_sites where manual_kind is not null`
      ).map((r) => r.u);
    }

    it('409: версия устарела или не передана; 404: нет контрагента', async () => {
      await importEntries([entry(ccX, siteA, layer('realization', 3, 0))]);
      const stale = (await card(ccX)).sitesVersion;
      await importEntries([entry(ccX, siteA, layer('realization_tolling', 3, 1))]);
      // Данные 1С изменились, но действующий вид — тоже, версия другая.
      const res = await patch(ccX, { sites: [], sitesVersion: stale });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'contractor_sites_conflict' });
      expect((await patch(ccX, { sites: [] })).statusCode).toBe(409);
      expect(await tableRows()).toHaveLength(1);
      expect((await patch(randomUUID(), { sites: [], sitesVersion: stale })).statusCode).toBe(404);
    });

    it('422: объект дважды, чужой uuid, служебный объект', async () => {
      const v = (await card(ccX)).sitesVersion;
      const bad = [
        [
          { siteId: siteA, kind: 'realization' },
          { siteId: siteA, kind: 'tolling_act' },
        ],
        [{ siteId: randomUUID(), kind: 'realization' }],
        [{ siteId: schema.SYSTEM_SITE_ID, kind: 'realization' }],
      ];
      const codes: string[] = [];
      for (const sites of bad) {
        const res = await patch(ccX, { sites, sitesVersion: v });
        expect(res.statusCode).toBe(422);
        codes.push(res.json().error);
      }
      expect(codes).toEqual(['duplicate_site', 'unknown_site', 'system_site']);
      expect(await tableRows()).toEqual([]);
    });

    it('гонка: два PATCH с одной версией — ровно один 409', async () => {
      const v = (await card(ccX)).sitesVersion;
      const [a, b] = await Promise.all([
        patch(ccX, { sites: [{ siteId: siteA, kind: 'realization' }], sitesVersion: v }),
        patch(ccX, { sites: [{ siteId: siteB, kind: 'tolling_act' }], sitesVersion: v }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(await tableRows()).toHaveLength(1);
    });

    it('гонка: PATCH только с sites во время импорта ждёт его и отвечает 409, без 500', async () => {
      const v = (await card(ccX)).sitesVersion;
      const entries = [entry(ccX, siteA, layer('realization', 3, 0))];
      const dry = await runContractorSitesImport(db, () => ({ entries }), { apply: false });
      let pending: ReturnType<typeof patch> | null = null;
      await runContractorSitesImport(db, () => ({ entries }), {
        apply: true,
        confirm: dry.plan.fingerprint.slice(0, 16),
        afterLock: async () => {
          pending = patch(ccX, {
            sites: [{ siteId: siteA, kind: 'tolling_act' }],
            sitesVersion: v,
          });
          let settled = false;
          void pending.then(() => (settled = true));
          for (let i = 0; i < 100; i++) {
            if (settled) throw new Error('PATCH не встал на блокировку импорта');
            const [w] = await sql<{ n: number }[]>`
              select count(*)::int as n from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'`;
            if (w!.n > 0) return;
            await new Promise((res) => setTimeout(res, 20));
          }
          throw new Error('PATCH не встал на блокировку импорта');
        },
      });
      const res = await pending!;
      expect(res.statusCode).toBe(409);
      expect(await tableRows()).toEqual([
        expect.objectContaining({ onec_kind: 'realization', manual_kind: null }),
      ]);
    });

    it('наблюдатель видит только свои объекты; суммы — только admin/manager', async () => {
      await importEntries([
        entry(ccX, siteA, layer('realization', 3, 0)),
        entry(ccX, siteB, layer('tolling_act', 0, 2)),
      ]);
      asRole('observer', [siteB]);
      expect((await card(ccX)).sites!.map((s) => s.siteCode)).toEqual(['СВБ']);

      asRole('monitor');
      const mon = (await card(ccX)).sites!;
      expect(mon).toHaveLength(2);
      expect(mon[0]!.onec).toMatchObject({
        realizationDocs: 3,
        realizationSum: null,
        tollingSum: null,
      });

      asRole('admin');
      expect((await card(ccX)).sites![0]!.onec).toMatchObject({
        realizationSum: '100.50',
        tollingSum: '0.00',
      });
    });

    it('удаление контрагента снимает связи каскадом', async () => {
      await importEntries([entry(ccX, siteA, layer('realization', 3, 0))]);
      asRole('admin');
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/customer-counterparties/${ccX}`,
      });
      expect(res.statusCode).toBe(200);
      expect(await tableRows()).toEqual([]);
    });
  });
});
