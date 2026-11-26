/**
 * Признак приёмки по справочнику «Контрагенты → Объекты и вид» (0161) на
 * настоящем PostgreSQL (domain/operations/delivery-purpose.ts,
 * domain/contractor-sites/purpose-hint.ts):
 *   - подставляется только при создании, фактической смене пары подрядчик ×
 *     объект или первом подтверждении; сохранение комментария и повторная
 *     синхронизация планшета пустой признак не трогают (хеш 1С прежний);
 *   - ручной выбор (даже равный справочнику) переживает смену объекта;
 *     подставленный следует за парой, «оба вида» — сброс;
 *   - организация — сначала точное совпадение по ИНН: скрытая пара ('none') не
 *     подменяется видом тёзки без ИНН; по имени — только при одном совпадении;
 *   - режим «Разные получатели»: документ со своим получателем не получает в
 *     выгрузке 1С вид подрядчика шапки (скан и свободная УПД из ЭДО).
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserRole } from '@matcheck/contracts';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import { deliveryRoutes } from '../../src/routes/deliveries.js';
import { loadDeliveryBundles } from '../../src/domain/onec/export-loader.js';
import { buildDeliveryBody } from '../../src/domain/onec/export-payload.js';
import { computeContentHash } from '../../src/domain/onec/content-hash.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** Верный 10-значный ИНН (контрольная цифра по ФНС) — normalizeInn его примет. */
function inn10(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  d[0] = 7;
  const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  return d.join('') + String((w.reduce((a, x, i) => a + x * d[i]!, 0) % 11) % 10);
}

suite('признак приёмки по справочнику «Объекты и вид»', () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let currentUser: AuthUser;
  const tag = randomUUID().slice(0, 6);
  const managerId = randomUUID();
  const sessionId = randomUUID();
  // Объекты: S1 — давальческий, S2 — «оба вида», S3 — ручной «Материалы подрядчика».
  const S1 = randomUUID();
  const S2 = randomUUID();
  const S3 = randomUUID();
  // Справочник «Контрагенты».
  const ccA = randomUUID();
  const ccB = randomUUID();
  const ccHidden = randomUUID();
  const ccTwin = randomUUID();
  const ccNoInn = randomUUID();
  const ccAmb1 = randomUUID();
  const ccAmb2 = randomUUID();
  const innA = inn10();
  const innB = inn10();
  const innHidden = inn10();
  // Операционные получатели приёмки.
  const opA = randomUUID();
  const opB = randomUUID();
  const opHidden = randomUUID();
  const opNoInn = randomUUID();
  const opAmb = randomUUID();
  const ccIds = [ccA, ccB, ccHidden, ccTwin, ccNoInn, ccAmb1, ccAmb2];
  const opIds = [opA, opB, opHidden, opNoInn, opAmb];
  const docIds = [randomUUID(), randomUUID()];
  const edoDocIds: string[] = [];
  let filledStatusId: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 5, onnotice: () => {} });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('db', db as never);
    app.decorate('authenticate', async (req: { user?: AuthUser }) => {
      req.user = currentUser;
    });
    app.decorate(
      'authorize',
      (...roles: UserRole[]) =>
        async (
          req: { user?: AuthUser },
          reply: { code: (n: number) => { send: (v: unknown) => void } },
        ) => {
          if (!req.user || !roles.includes(req.user.role)) {
            reply.code(403).send({ error: 'forbidden' });
          }
        },
    );
    app.decorate('permissions', { enforced: true, get: async () => new Map() } as never);
    app.decorate('logUnauthorized', async () => {});
    await app.register(deliveryRoutes);
    await app.ready();

    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${managerId}, ${`pdir-${managerId}@test`}, 'x', 'manager')`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})`;
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    };
    await sql`INSERT INTO sites (id, code, name) VALUES
      (${S1}, ${`PD1${tag}`}, 'Справочник: давальческий'),
      (${S2}, ${`PD2${tag}`}, 'Справочник: оба вида'),
      (${S3}, ${`PD3${tag}`}, 'Справочник: материалы подрядчика')`;
    const [status] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    filledStatusId = status!.id;

    // Справочник. Тёзка без ИНН носит то же имя, что и скрытая по ИНН организация.
    await sql`INSERT INTO customer_counterparties (id, inn, name) VALUES
      (${ccA}, ${`ИНН ${innA}`}, ${`ООО «Альфа ${tag}»`}),
      (${ccB}, ${innB}, ${`ООО «Бета ${tag}»`}),
      (${ccHidden}, ${innHidden}, ${`ООО «Скрытая ${tag}»`}),
      (${ccTwin}, '', ${`ООО «Скрытая ${tag}»`}),
      (${ccNoInn}, '', ${`Иванов Иван ${tag}`}),
      (${ccAmb1}, '', ${`Двойник ${tag}`}),
      (${ccAmb2}, '', ${`Двойник ${tag}`})`;
    const onec = (cc: string, site: string, kind: string, manual: string | null = null) => sql`
      INSERT INTO customer_counterparty_sites (customer_counterparty_id, site_id, onec_kind,
        onec_realization_docs, onec_realization_sum, onec_tolling_docs, onec_tolling_sum,
        onec_loaded_at, manual_kind, manual_at)
      VALUES (${cc}, ${site}, ${kind}, 1, 1, 1, 1, now(), ${manual}::varchar, CASE WHEN ${manual}::varchar IS NULL THEN NULL ELSE now() END)`;
    const manualOnly = (cc: string, site: string, kind: string) => sql`
      INSERT INTO customer_counterparty_sites (customer_counterparty_id, site_id, manual_kind, manual_at)
      VALUES (${cc}, ${site}, ${kind}, now())`;
    await onec(ccA, S1, 'tolling_act');
    await onec(ccA, S2, 'realization_tolling');
    await manualOnly(ccA, S3, 'contractor_materials');
    await onec(ccB, S1, 'realization');
    await onec(ccHidden, S1, 'realization', 'none');
    await manualOnly(ccTwin, S1, 'tolling_act');
    await manualOnly(ccNoInn, S1, 'tolling_act');
    await manualOnly(ccAmb1, S1, 'realization');
    await manualOnly(ccAmb2, S1, 'realization');

    await sql`INSERT INTO counterparties (id, inn, name, is_contractor) VALUES
      (${opA}, ${innA}, ${`ООО «Альфа ${tag}»`}, true),
      (${opB}, ${innB}, ${`ООО «Бета ${tag}»`}, true),
      (${opHidden}, ${innHidden}, ${`ООО «Скрытая ${tag}»`}, true),
      (${opNoInn}, ${`0000${tag.slice(0, 4)}aa11`}, ${`Иванов Иван ${tag}`}, true),
      (${opAmb}, ${`0000${tag.slice(0, 4)}bb22`}, ${`Двойник ${tag}`}, true)`;

    for (const [i, id] of docIds.entries()) {
      await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, parsed_at)
        VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${S1}, ${`PD-${tag}-${i}`}, now(), '100.00', now())`;
    }
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM deliveries WHERE site_id IN (${S1}, ${S2}, ${S3})`;
    await sql`DELETE FROM source_documents WHERE id IN ${sql([...docIds, ...edoDocIds])}`;
    await sql`DELETE FROM counterparties WHERE id IN ${sql(opIds)}`;
    await sql`DELETE FROM customer_counterparties WHERE id IN ${sql(ccIds)}`;
    await sql`DELETE FROM sites WHERE id IN (${S1}, ${S2}, ${S3})`;
    await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql.end({ timeout: 5 });
  });

  type Row = { purpose: string | null; purpose_from_directory: boolean };
  const rowOf = async (id: string): Promise<Row> =>
    (await sql<Row[]>`SELECT purpose, purpose_from_directory FROM deliveries WHERE id = ${id}`)[0]!;
  /** Upsert без признака — как у планшета (или «Сохранить» портала без выбора). */
  const upsert = (
    id: string,
    body: {
      siteId: string;
      contractorId?: string;
      statusCode?: string;
      comment?: string;
      purpose?: string;
    },
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/deliveries',
      payload: {
        id,
        statusCode: 'filled',
        items: [],
        sourceDocumentIds: [],
        ...body,
      },
    });
  const patch = (id: string, suffix: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/api/v1/deliveries/${id}${suffix}`, payload });
  const getDto = async (id: string) =>
    (await app.inject({ method: 'GET', url: `/api/v1/deliveries/${id}` })).json();
  async function onecHash(id: string): Promise<string> {
    const bundle = (await loadDeliveryBundles(db, [id])).get(id)!;
    return computeContentHash(buildDeliveryBody(bundle, '2026-11-26T00:00:00.000Z'));
  }
  async function onecBody(id: string) {
    const bundle = (await loadDeliveryBundles(db, [id])).get(id)!;
    return buildDeliveryBody(bundle, '2026-11-26T00:00:00.000Z');
  }

  it('создание как планшет: признак по справочнику, флаг и подсказка в DTO', async () => {
    const id = randomUUID();
    const res = await upsert(id, { siteId: S1, contractorId: opA });
    expect(res.statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: 'tolling_act', purpose_from_directory: true });
    expect(await getDto(id)).toMatchObject({
      purpose: 'tolling_act',
      purposeFromDirectory: true,
      purposeHint: { kind: 'tolling_act', manual: false, siteCode: `PD1${tag}` },
    });
  });

  it('явный признак в upsert главнее справочника', async () => {
    const id = randomUUID();
    expect(
      (await upsert(id, { siteId: S1, contractorId: opA, purpose: 'realization' })).statusCode,
    ).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: 'realization', purpose_from_directory: false });
  });

  it('сохранение комментария и повторная синхронизация оставляют старый NULL; хеш 1С прежний', async () => {
    const id = randomUUID();
    // Старая приёмка: создана, когда пары в справочнике ещё не было.
    await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id, purpose, version)
      VALUES (${id}, ${S1}, ${filledStatusId}, ${opA}, NULL, 1)`;
    const before = await onecHash(id);
    expect((await upsert(id, { siteId: S1, contractorId: opA })).statusCode).toBe(200);
    expect(
      (await upsert(id, { siteId: S1, contractorId: opA, comment: 'Примечание: тест' })).statusCode,
    ).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: null, purpose_from_directory: false });
    expect(await onecHash(id)).toBe(before);
    // Подсказка в карточке при этом есть — выбор в один клик.
    expect(await getDto(id)).toMatchObject({ purpose: null, purposeHint: { kind: 'tolling_act' } });
  });

  it('первое подтверждение заполняет пустой признак; повторное — нет', async () => {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id, purpose, version)
      VALUES (${id}, ${S1}, ${filledStatusId}, ${opA}, NULL, 1)`;
    expect(
      (await upsert(id, { siteId: S1, contractorId: opA, statusCode: 'confirmed_mol' })).statusCode,
    ).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: 'tolling_act', purpose_from_directory: true });

    // Подтверждённую очищаем вручную (как будто признак сняли) — повторное
    // подтверждение событием не является.
    await sql`UPDATE deliveries SET purpose = NULL, purpose_from_directory = false WHERE id = ${id}`;
    expect(
      (await upsert(id, { siteId: S1, contractorId: opA, statusCode: 'confirmed_mol' })).statusCode,
    ).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: null, purpose_from_directory: false });
  });

  it('ручной выбор, равный справочнику, переживает смену объекта', async () => {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, status_id, contractor_id, purpose, version)
      VALUES (${id}, ${S1}, ${filledStatusId}, ${opA}, NULL, 1)`;
    expect((await patch(id, '/purpose', { purpose: 'tolling_act' })).statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: 'tolling_act', purpose_from_directory: false });
    expect((await upsert(id, { siteId: S3, contractorId: opA })).statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: 'tolling_act', purpose_from_directory: false });
  });

  it('подставленный следует за объектом; «оба вида» — сброс', async () => {
    const id = randomUUID();
    await upsert(id, { siteId: S1, contractorId: opA });
    expect(await rowOf(id)).toEqual({ purpose: 'tolling_act', purpose_from_directory: true });
    await upsert(id, { siteId: S3, contractorId: opA });
    expect(await rowOf(id)).toEqual({
      purpose: 'contractor_materials',
      purpose_from_directory: true,
    });
    expect(await getDto(id)).toMatchObject({
      purposeHint: { kind: 'contractor_materials', manual: true },
    });
    await upsert(id, { siteId: S2, contractorId: opA });
    expect(await rowOf(id)).toEqual({ purpose: null, purpose_from_directory: false });
    expect(await getDto(id)).toMatchObject({ purposeHint: { kind: 'realization_tolling' } });
  });

  it('PATCH /recipient: подставленный следует за подрядчиком; ручной PATCH /purpose снимает флаг', async () => {
    const id = randomUUID();
    await upsert(id, { siteId: S1, contractorId: opA });
    expect((await patch(id, '/recipient', { contractorId: opB })).statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: 'realization', purpose_from_directory: true });
    expect((await patch(id, '/purpose', { purpose: 'contractor_materials' })).statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({
      purpose: 'contractor_materials',
      purpose_from_directory: false,
    });
    expect((await patch(id, '/recipient', { contractorId: opA })).statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({
      purpose: 'contractor_materials',
      purpose_from_directory: false,
    });
  });

  it('none у точного совпадения по ИНН не подменяется видом тёзки без ИНН', async () => {
    const id = randomUUID();
    await upsert(id, { siteId: S1, contractorId: opHidden });
    expect(await rowOf(id)).toEqual({ purpose: null, purpose_from_directory: false });
    expect(await getDto(id)).toMatchObject({ purposeHint: null });
  });

  it('по имени — только при одном совпадении среди записей без ИНН', async () => {
    const one = randomUUID();
    await upsert(one, { siteId: S1, contractorId: opNoInn });
    expect(await rowOf(one)).toEqual({ purpose: 'tolling_act', purpose_from_directory: true });
    expect(await getDto(one)).toMatchObject({ purposeHint: { kind: 'tolling_act', manual: true } });

    const two = randomUUID();
    await upsert(two, { siteId: S1, contractorId: opAmb });
    expect(await rowOf(two)).toEqual({ purpose: null, purpose_from_directory: false });
  });

  it('УПД с другим получателем не получает в выгрузке вид подрядчика шапки (скан и ЭДО)', async () => {
    const id = randomUUID();
    await upsert(id, { siteId: S1, contractorId: opA });
    expect(await rowOf(id)).toEqual({ purpose: 'tolling_act', purpose_from_directory: true });
    for (const docId of docIds) {
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${id}, ${docId})`;
    }
    const edoDoc = randomUUID();
    edoDocIds.push(edoDoc);
    await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number, doc_date)
      VALUES (${edoDoc}, 'upd', 'inbound', 'parsed', 'edo_diadoc', ${S1}, ${`ЭДО-${tag}`}, '2026-11-26')`;
    const [m] = await sql<{ id: string }[]>`
      INSERT INTO delivery_edo_matches (delivery_id, source_document_id, section_document_id, linked_by_user_id)
      VALUES (${id}, ${edoDoc}, NULL, ${managerId}) RETURNING id::text AS id`;
    expect((await patch(id, '/recipient-mode', { perDocument: true })).statusCode).toBe(200);

    // Скан 0 и УПД из ЭДО — подрядчику Б; скан 1 наследует шапку.
    expect(
      (await patch(id, `/sources/${docIds[0]}/recipient`, { contractorId: opB })).statusCode,
    ).toBe(200);
    expect(
      (await patch(id, `/edo-matches/${m!.id}/recipient`, { contractorId: opB })).statusCode,
    ).toBe(200);

    const body = await onecBody(id);
    const group = (docId: string) => body.groups.find((g) => g.document?.id === docId)!;
    expect(group(docIds[0]!).document!.purpose).toBeNull();
    expect(group(docIds[1]!).document!.purpose).toBe('tolling_act');
    expect(body.edo).toHaveLength(1);
    expect(body.edo[0]!.purpose).toBeNull();

    // Режим включён: смена подрядчика шапки подстановку не делает, прежняя сбрасывается.
    expect((await patch(id, '/recipient', { contractorId: opB })).statusCode).toBe(200);
    expect(await rowOf(id)).toEqual({ purpose: null, purpose_from_directory: false });
  });
});
