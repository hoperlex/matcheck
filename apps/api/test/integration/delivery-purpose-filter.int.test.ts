/**
 * Фильтр «Признак приёмки» (?purposes=) в списке приёмок и выгрузке Excel.
 *
 * Признак у приёмки бывает общий (deliveries.purpose) и, в режиме «Разные
 * получатели», свой у документа: у строки delivery_sources или у свободной УПД
 * из ЭДО (delivery_edo_matches без блока). Приёмка подходит, если хоть один её
 * признак среди выбранных (ИЛИ); none — «Не указан». Свой признак вне режима
 * не действует — так же, как в колонке «Признак» выгрузки.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { deliveries, sites, statuses, users } from '../../src/db/schema.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('фильтр «Признак приёмки» (реальный PostgreSQL)', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let currentUser: AuthUser;
  const RUN = String(Date.now()).slice(-7);
  const siteId = randomUUID();
  const managerId = randomUUID();
  const docIds: string[] = [];

  const d = {
    tolling: randomUUID(),
    realization: randomUUID(),
    ownForces: randomUUID(),
    contractorMaterials: randomUUID(),
    none: randomUUID(),
    // Общий «Материалы подрядчика», у УПД (delivery_sources) свой «Давальческий акт».
    perDocSource: randomUUID(),
    // Общий «Реализация», у свободной УПД из ЭДО свой «Давальческий акт».
    perDocEdo: randomUUID(),
    // Общий «Свои силы», у УПД свой — не выбран (NULL при own_purpose).
    perDocOwnNull: randomUUID(),
    // Свой «Давальческий акт» остался при выключенном режиме — не действует.
    dormant: randomUUID(),
  };
  const ALL = Object.values(d).sort();
  const sorted = (...ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    const db = drizzle(sql, { schema: { deliveries, sites, statuses, users } });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('permissions', {
      enforced: false,
      get: async () => new Map(),
      routeRoles: new Map(),
      invalidateLocal: () => {},
      invalidateEverywhere: async () => {},
    } as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate('authorize', () => async () => undefined);
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${`PF${RUN.slice(-4)}`}, 'Признак приёмки')`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${managerId}, ${`purpose-f-${managerId}@test`}, 'x', 'manager')`;
    const [filled] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    const delivery = async (id: string, purpose: string | null, perDocument = false) =>
      sql`INSERT INTO deliveries (id, site_id, status_id, version, purpose, recipients_per_document)
        VALUES (${id}, ${siteId}, ${filled!.id}, 1, ${purpose}, ${perDocument})`;
    await delivery(d.tolling, 'tolling_act');
    await delivery(d.realization, 'realization');
    await delivery(d.ownForces, 'own_forces');
    await delivery(d.contractorMaterials, 'contractor_materials');
    await delivery(d.none, null);
    await delivery(d.perDocSource, 'contractor_materials', true);
    await delivery(d.perDocEdo, 'realization', true);
    await delivery(d.perDocOwnNull, 'own_forces', true);
    await delivery(d.dormant, 'contractor_materials', false);

    const doc = async (docNumber: string): Promise<string> => {
      const id = randomUUID();
      docIds.push(id);
      await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number)
        VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${docNumber})`;
      return id;
    };
    const linkOwnPurpose = async (deliveryId: string, purpose: string | null) =>
      sql`INSERT INTO delivery_sources (delivery_id, source_document_id, own_purpose, purpose)
        VALUES (${deliveryId}, ${await doc(`УПД-${RUN}-${docIds.length}`)}, true, ${purpose})`;
    await linkOwnPurpose(d.perDocSource, 'tolling_act');
    await linkOwnPurpose(d.perDocOwnNull, null);
    await linkOwnPurpose(d.dormant, 'tolling_act');
    // Свободная УПД из ЭДО (своя копия, без блока скана) со своим признаком.
    await sql`INSERT INTO delivery_edo_matches (delivery_id, source_document_id, own_purpose, purpose)
      VALUES (${d.perDocEdo}, ${await doc(`ЭДО-${RUN}`)}, true, 'tolling_act')`;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE id = ANY(${docIds})`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  const as = (role: UserRole, id = randomUUID(), site: string | null = null): AuthUser => ({
    id,
    role,
    siteId: site,
    contractorCustomerId: null,
    sessionId: randomUUID(),
  });

  async function list(params: Record<string, string>) {
    const qs = new URLSearchParams({ siteIds: siteId, limit: '200', ...params });
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries?${qs}` });
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: { id: string; displayId: number }[] }).items;
  }
  async function listIds(params: Record<string, string>): Promise<string[]> {
    return (await list(params)).map((i) => i.id).sort();
  }
  /** id приёмок из выгрузки — по колонке «id» строк приёмок (не строк позиций). */
  async function exportIds(params: Record<string, string>): Promise<string[]> {
    const byDisplayId = new Map((await list({})).map((i) => [String(i.displayId), i.id]));
    const qs = new URLSearchParams({ siteIds: siteId, ...params });
    const res = await app.inject({ method: 'GET', url: `/api/v1/deliveries/export.xlsx?${qs}` });
    expect(res.statusCode).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ids: string[] = [];
    wb.worksheets[0]!.eachRow((r, i) => {
      if (i > 1 && r.outlineLevel !== 1) {
        ids.push(
          byDisplayId.get(String(r.getCell('B').value)) ?? `?${String(r.getCell('B').value)}`,
        );
      }
    });
    return ids.sort();
  }

  it('один пункт: общий признак и свой у документа в режиме «Разные получатели»', async () => {
    currentUser = as('manager', managerId);
    expect(await listIds({})).toEqual(ALL);
    expect(await listIds({ purposes: 'tolling_act' })).toEqual(
      sorted(d.tolling, d.perDocSource, d.perDocEdo),
    );
    // Общий признак действует и при своём у документа; вне режима свой не мешает.
    expect(await listIds({ purposes: 'contractor_materials' })).toEqual(
      sorted(d.contractorMaterials, d.perDocSource, d.dormant),
    );
    expect(await listIds({ purposes: 'realization_tolling' })).toEqual([]);
  });

  it('несколько пунктов — ИЛИ', async () => {
    currentUser = as('manager', managerId);
    expect(await listIds({ purposes: 'tolling_act,realization' })).toEqual(
      sorted(d.tolling, d.realization, d.perDocSource, d.perDocEdo),
    );
  });

  it('«Не указан»: пустой общий признак или пустой свой у документа', async () => {
    currentUser = as('manager', managerId);
    expect(await listIds({ purposes: 'none' })).toEqual(sorted(d.none, d.perDocOwnNull));
    expect(await listIds({ purposes: 'own_forces,none' })).toEqual(
      sorted(d.ownForces, d.none, d.perDocOwnNull),
    );
  });

  it('чужие значения отбрасываются: одни — список не сужается, вместе с кодом — как один код', async () => {
    currentUser = as('manager', managerId);
    expect(await listIds({ purposes: 'Вывоз материала,foo' })).toEqual(ALL);
    expect(await listIds({ purposes: 'foo,tolling_act,tolling_act' })).toEqual(
      sorted(d.tolling, d.perDocSource, d.perDocEdo),
    );
  });

  it('с другими фильтрами — И', async () => {
    currentUser = as('manager', managerId);
    // УПД привязана только у perDocSource, perDocOwnNull и dormant.
    expect(await listIds({ purposes: 'tolling_act', features: 'upd' })).toEqual([d.perDocSource]);
  });

  it('выгрузка Excel отбирает те же приёмки, что список', async () => {
    currentUser = as('manager', managerId);
    for (const purposes of ['tolling_act', 'none', 'contractor_materials,realization']) {
      expect(await exportIds({ purposes })).toEqual(await listIds({ purposes }));
    }
  });

  it('инспектор своего объекта фильтрует так же', async () => {
    currentUser = as('inspector_kpp', randomUUID(), siteId);
    expect(await listIds({ purposes: 'tolling_act' })).toEqual(
      sorted(d.tolling, d.perDocSource, d.perDocEdo),
    );
  });
});
