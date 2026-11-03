/**
 * Одна УПД из ЭДО — несколько приёмок одного объекта. Проверка на настоящем
 * PostgreSQL.
 *
 * Обещания (план 02.11 «одна УПД — несколько рейсов»):
 *   - групповая привязка — всё или ничего: любая помеха (другой объект,
 *     пометка на удаление, приёмка из отгрузки, отвязанный блок, УПД на другом
 *     объекте, импортированная копия) — ни одной связи;
 *   - цель, где УПД уже стоит (копией другого оператора или документом
 *     приёмки), — «уже была», остальные привязываются;
 *   - одновременные пачки и одиночные привязки — без 40P01, ровно одна связь
 *     на приёмку; встречная привязка к другому объекту видна пачке;
 *   - подсказка — тот же номер, без документа рядом по времени, отмеченные и
 *     найденные; чужой объект, удаляемые и далёкие — нет;
 *   - факт других приёмок — по области связи (блок или вся приёмка).
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без переменной набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as drSql } from 'drizzle-orm';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import type * as EventsModule from '../../src/routes/events.js';

const published = vi.hoisted(() => [] as { type: string; entityId: string; siteId?: string }[]);

vi.mock('../../src/routes/events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EventsModule>();
  return {
    ...actual,
    publishEvent: (_app: unknown, event: { type: string; entityId: string; siteId?: string }) => {
      published.push(event);
    },
  };
});

const { deliveryRoutes } = await import('../../src/routes/deliveries.js');
const { lockEdoDocGroup } = await import('../../src/domain/edo/export-twins.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** ИНН юрлица с верной контрольной цифрой. */
function inn10(prefix9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const digits = [...prefix9].map(Number);
  return prefix9 + String((weights.reduce((acc, w, i) => acc + w * digits[i]!, 0) % 11) % 10);
}

const RUN = String(Date.now()).slice(-6);
const SUPPLIER_INN = inn10(`44${RUN}1`);
const DAY = '2031-07-20';
const key = (tag: string) => `${tag}${RUN}`.padEnd(64, '0');
/** Номер по метке — только цифры после префикса (поиск сравнивает цифры). */
const tagNumbers = new Map<string, number>();
const num = (tag: string) => {
  if (!tagNumbers.has(tag)) tagNumbers.set(tag, 10 + tagNumbers.size);
  return `РС-${RUN}${tagNumbers.get(tag)}`;
};
const shift = (days: number, hour = 7) =>
  new Date(
    Date.parse(`${DAY}T${String(hour).padStart(2, '0')}:00:00Z`) + days * 86_400_000,
  ).toISOString();

suite('одна УПД — несколько приёмок объекта (реальный PostgreSQL)', { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let statusId: string;
  let currentUser: AuthUser;

  const siteA = randomUUID();
  const siteB = randomUUID();
  /** Объект только для подсказки: «без документа» берёт ближайшие, соседи из других тестов мешали бы. */
  const siteC = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const diadocAcc = randomUUID();
  const sbisAcc = randomUUID();
  const documents: string[] = [];

  /** Отгрузка-источник для приёмки «из отгрузки»: вид не важен, нужна только ссылка. */
  async function shipment(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO shipments (id, status_id, kind, site_id)
              SELECT ${id}, s.id, 'writeoff', ${siteB} FROM statuses s
               WHERE s.entity_type = 'shipment' AND s.code = 'draft' LIMIT 1`;
    return id;
  }

  async function delivery(
    o: { site?: string; at?: string; pending?: boolean; shipment?: boolean } = {},
  ) {
    const id = randomUUID();
    const shipmentId = o.shipment ? await shipment() : null;
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version,
                                      pending_deletion_at, pending_deletion_by_user_id, source_shipment_id)
              VALUES (${id}, ${o.site ?? siteA}, ${managerId}, ${statusId}, ${o.at ?? shift(0)}, 1,
                      ${o.pending ? shift(1) : null}, ${o.pending ? managerId : null},
                      ${shipmentId})`;
    return id;
  }

  const displayIdOf = async (id: string) =>
    Number(
      (await sql<{ display_id: string }[]>`SELECT display_id FROM deliveries WHERE id = ${id}`)[0]!
        .display_id,
    );

  async function exportDoc(o: {
    tag: string;
    account?: string;
    sha?: string;
    date?: string;
  }): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         size_bytes, received_at)
      VALUES (${id}, ${o.account ?? diadocAcc}, ${`m-${id}`}, ${`e-${id}`}, 'UniversalTransferDocument',
              ${num(o.tag)}, ${o.date ?? DAY}, ${SUPPLIER_INN}, 'ООО «Рейсы»', 1000.00, 'materials',
              'stored', ${`edo-export/test/${id}.xml`}, ${o.sha ?? key(`x${id.slice(0, 8)}`)}, 2048,
              ${`${DAY}T09:00:00Z`})`;
    return id;
  }

  /** Бумажный документ приёмки — блок материалов. */
  async function paper(
    deliveryId: string,
    tag: string,
    inn: string | null = SUPPLIER_INN,
  ): Promise<string> {
    const id = randomUUID();
    documents.push(id);
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, supplier_inn_raw)
              VALUES (${id}, 'upd', 'inbound', 'parsed', 'manual_pdf',
                      (SELECT site_id FROM deliveries WHERE id = ${deliveryId}),
                      ${num(tag)}, ${DAY}, 1000.00, ${inn})`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${deliveryId}, ${id})`;
    return id;
  }

  /** Импортированная карточка Диадока для строки реестра. */
  async function cardFor(exportId: string, site: string = siteA): Promise<string> {
    const id = randomUUID();
    documents.push(id);
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                 edo_account_id, provider_message_id, provider_entity_id)
              SELECT ${id}, 'upd', 'inbound', 'parsed', 'edo_diadoc', ${site}, e.document_number,
                     e.document_date, e.total_sum, e.edo_account_id, e.message_id, e.entity_id
                FROM edo_export_documents e WHERE e.id = ${exportId}`;
    return id;
  }

  let lineNo = 0;
  async function item(deliveryId: string, o: { doc?: string | null; qty: number; price: number }) {
    lineNo += 1;
    await sql`INSERT INTO delivery_items (delivery_id, name_raw, line_no, qty_actual, price, source_document_id)
              VALUES (${deliveryId}, ${`Материал ${lineNo}`}, ${lineNo}, ${o.qty}, ${o.price}, ${o.doc ?? null})`;
  }

  type Target = { deliveryId: string; sectionDocumentId: string | null };
  const batch = (
    anchor: string,
    documentId: string,
    targets: Target[],
    source: 'export' | 'import' = 'export',
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${anchor}/edo-matches/batch`,
      payload: { documentId, source, targets },
    });
  const whole = (...ids: string[]): Target[] =>
    ids.map((deliveryId) => ({ deliveryId, sectionDocumentId: null }));
  const single = (deliveryId: string, documentId: string, source: 'export' | 'import' = 'export') =>
    app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${deliveryId}/edo-matches`,
      payload: { documentId, source },
    });

  /** Связи документа (любой копии из списка): приёмка → блок. */
  async function linksOf(...documentIds: string[]) {
    const rows = await sql<{ delivery_id: string; section_document_id: string | null }[]>`
      SELECT delivery_id, section_document_id FROM delivery_edo_matches
       WHERE export_document_id IN ${sql(documentIds)} OR source_document_id IN ${sql(documentIds)}`;
    return rows;
  }

  async function candidates(anchor: string, documentId: string, query = '') {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/deliveries/${anchor}/edo-share-candidates?source=export&documentId=${documentId}${query}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      items: {
        deliveryId: string;
        state: string;
        reasons: string[];
        level: string;
        defaultSectionId: string | null;
        documents: { id: string }[];
      }[];
    };
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 10 });
    db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
    app = Fastify({ logger: false });
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteA}, ${`SHA${RUN}`}, 'Рейсы А'),
                                                       (${siteB}, ${`SHB${RUN}`}, 'Рейсы Б'),
                                                       (${siteC}, ${`SHC${RUN}`}, 'Рейсы В')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`share-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})`;
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    } as unknown as AuthUser;
    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, box_id)
              VALUES (${diadocAcc}, ${`Диадок ${RUN}`}, '{}', ${`box-share-${RUN}`})`;
    await sql`INSERT INTO edo_accounts (id, name, provider, auth_mode, credentials_encrypted, box_id, org_inn)
              VALUES (${sbisAcc}, ${`СБИС ${RUN}`}, 'sbis', 'sbis_service_key', '{}',
                      ${`legal:share:${RUN}:`}, '7736255508')`;
    statusId = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`
    )[0]!.id;
  });

  beforeEach(() => {
    published.length = 0;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    const accounts = [diadocAcc, sbisAcc];
    const sites = [siteA, siteB, siteC];
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id IN ${sql(sites)})`;
    await sql`DELETE FROM delivery_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id IN ${sql(sites)})`;
    await sql`DELETE FROM delivery_sources WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id IN ${sql(sites)})`;
    await sql`DELETE FROM deliveries WHERE site_id IN ${sql(sites)}`;
    await sql`DELETE FROM shipments WHERE site_id IN ${sql(sites)}`;
    if (documents.length) await sql`DELETE FROM source_documents WHERE id IN ${sql(documents)}`;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id IN ${sql(accounts)}`;
    await sql`DELETE FROM edo_accounts WHERE id IN ${sql(accounts)}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id IN ${sql(sites)}`;
    await sql.end({ timeout: 5 });
  });

  describe('групповая привязка', () => {
    it('одна УПД на три приёмки: блоки целей, «ещё в приёмках», событие по каждой', async () => {
      const doc = await exportDoc({ tag: 'A1' });
      const [d1, d2, d3] = [await delivery(), await delivery(), await delivery()];
      const p1 = await paper(d1, 'A1');
      const p2 = await paper(d2, 'A1');

      const res = await batch(d1, doc, [
        { deliveryId: d1, sectionDocumentId: p1 },
        { deliveryId: d2, sectionDocumentId: p2 },
        { deliveryId: d3, sectionDocumentId: null },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      expect(
        res
          .json()
          .linked.map((d: { deliveryId: string }) => d.deliveryId)
          .sort(),
      ).toEqual([d1, d2, d3].sort());
      expect(res.json().alreadyLinked).toEqual([]);

      const links = await linksOf(doc);
      expect(new Map(links.map((l) => [l.delivery_id, l.section_document_id]))).toEqual(
        new Map([
          [d1, p1],
          [d2, p2],
          [d3, null],
        ]),
      );
      const linked = await app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${d2}/edo-matches`,
      });
      expect(linked.json().items[0]).toMatchObject({ alsoInCount: 2 });
      expect(published.map((e) => e.entityId).sort()).toEqual([d1, d2, d3].sort());
      expect(published.every((e) => e.type === 'delivery_updated' && e.siteId === siteA)).toBe(
        true,
      );

      // Версия приёмки не меняется — как у одиночной привязки.
      const versions = await sql<
        { version: number }[]
      >`SELECT version FROM deliveries WHERE id IN ${sql([d1, d2, d3])}`;
      expect(versions.every((v) => Number(v.version) === 1)).toBe(true);
    });

    it('всё или ничего: другой объект, пометка на удаление, приёмка из отгрузки', async () => {
      const cases: [Parameters<typeof delivery>[0], string][] = [
        [{ site: siteB }, 'other_site'],
        [{ pending: true }, 'pending_deletion'],
        [{ shipment: true }, 'from_shipment'],
      ];
      for (const [opts, error] of cases) {
        const doc = await exportDoc({ tag: `B${error}` });
        const good = await delivery();
        const bad = await delivery(opts);
        const res = await batch(good, doc, whole(good, bad));
        expect(res.statusCode, error).toBe(409);
        expect(res.json()).toMatchObject({
          error,
          deliveries: [{ deliveryId: bad, displayId: await displayIdOf(bad) }],
        });
        expect(res.json().message).toContain('Ничего не привязано');
        expect(await linksOf(doc)).toEqual([]);
      }
      expect(published).toEqual([]);
    });

    it('блок цели: отвязанный документ — section_not_linked; карточка как свой блок — invalid_section', async () => {
      const doc = await exportDoc({ tag: 'C1' });
      const d1 = await delivery();
      const d2 = await delivery();
      const stranger = await paper(await delivery(), 'C1'); // документ другой приёмки
      const res = await batch(d1, doc, [
        { deliveryId: d1, sectionDocumentId: null },
        { deliveryId: d2, sectionDocumentId: stranger },
      ]);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: 'section_not_linked',
        deliveries: [{ deliveryId: d2 }],
      });
      expect(await linksOf(doc)).toEqual([]);

      const exported = await exportDoc({ tag: 'C2' });
      const card = await cardFor(exported);
      const d3 = await delivery();
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${d3}, ${card})`;
      const own = await batch(d1, card, [{ deliveryId: d3, sectionDocumentId: card }], 'import');
      // Карточка уже документ приёмки d3 — связь есть, но свой блок проверяется раньше.
      expect(own.statusCode).toBe(409);
      expect(own.json()).toMatchObject({ error: 'invalid_section' });
    });

    it('УПД на другом объекте — foreign_site с номером приёмки; импортированная копия — imported_available', async () => {
      const doc = await exportDoc({ tag: 'D1' });
      const foreign = await delivery({ site: siteB });
      expect((await single(foreign, doc)).statusCode).toBe(200);
      const d1 = await delivery();
      const res = await batch(d1, doc, whole(d1));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        error: 'foreign_site',
        deliveries: [{ deliveryId: foreign, displayId: await displayIdOf(foreign) }],
      });

      const imported = await exportDoc({ tag: 'D2' });
      await cardFor(imported);
      const second = await batch(d1, imported, whole(d1));
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: 'imported_available' });
    });

    it('уже стоит копией другого оператора или документом приёмки — «уже была», остальные привязаны', async () => {
      const diadoc = await exportDoc({ tag: 'E1', sha: key('E1') });
      const sbis = await exportDoc({ tag: 'E1', account: sbisAcc, sha: key('E1') });
      const [dX, dY] = [await delivery(), await delivery()];
      expect((await single(dX, sbis)).statusCode).toBe(200);
      published.length = 0;
      const res = await batch(dY, diadoc, whole(dX, dY));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        linked: [{ deliveryId: dY }],
        alreadyLinked: [{ deliveryId: dX }],
      });
      expect(published.map((e) => e.entityId)).toEqual([dY]);

      const exported = await exportDoc({ tag: 'E2' });
      const card = await cardFor(exported);
      const [dZ, dW] = [await delivery(), await delivery()];
      await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${dZ}, ${card})`;
      const viaSource = await batch(dZ, card, whole(dZ, dW), 'import');
      expect(viaSource.statusCode, viaSource.body).toBe(200);
      expect(viaSource.json()).toMatchObject({
        linked: [{ deliveryId: dW }],
        alreadyLinked: [{ deliveryId: dZ }],
      });
    });

    it('повтор приёмки в теле — 400', async () => {
      const doc = await exportDoc({ tag: 'F1' });
      const d1 = await delivery();
      const res = await batch(d1, doc, whole(d1, d1));
      expect(res.statusCode).toBe(400);
    });
  });

  describe('одновременно', () => {
    it('две пачки и одиночная привязка с общими приёмками — без 40P01, одна связь на приёмку', async () => {
      for (let round = 0; round < 10; round += 1) {
        const twin = round % 2 === 1;
        const diadoc = await exportDoc({ tag: `G${round}`, sha: key(`G${round}`) });
        const sbis = twin
          ? await exportDoc({ tag: `G${round}`, account: sbisAcc, sha: key(`G${round}`) })
          : diadoc;
        const [d1, d2, d3] = [await delivery(), await delivery(), await delivery()];
        const results = await Promise.all([
          batch(d1, diadoc, whole(d1, d2)),
          single(d2, sbis),
          batch(d3, diadoc, whole(d2, d3)),
        ]);
        const codes = results.map((r) => r.statusCode);
        expect(
          codes.every((code) => code === 200 || code === 409),
          JSON.stringify(results.map((r) => r.json())),
        ).toBe(true);
        expect(results[0]!.statusCode).toBe(200);
        expect(results[2]!.statusCode).toBe(200);
        if (results[1]!.statusCode === 409)
          expect(results[1]!.json()).toMatchObject({ error: 'already_linked' });
        const links = await linksOf(diadoc, sbis);
        const perDelivery = new Map<string, number>();
        for (const link of links)
          perDelivery.set(link.delivery_id, (perDelivery.get(link.delivery_id) ?? 0) + 1);
        expect(perDelivery, `раунд ${round}`).toEqual(
          new Map([
            [d1, 1],
            [d2, 1],
            [d3, 1],
          ]),
        );
      }
    });

    it('встречная привязка к другому объекту: пачка ждёт блокировку группы и получает foreign_site', async () => {
      const doc = await exportDoc({ tag: 'H1' });
      const foreign = await delivery({ site: siteB });
      const [d1, d2] = [await delivery(), await delivery()];
      let settledEarly = false;
      let pending!: ReturnType<typeof batch>;
      await db.transaction(async (tx) => {
        await lockEdoDocGroup(tx, { exportIds: [doc] });
        await tx.execute(drSql`insert into delivery_edo_matches (delivery_id, export_document_id)
                               values (${foreign}, ${doc})`);
        pending = batch(d1, doc, whole(d1, d2));
        void pending.then(() => {
          settledEarly = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settledEarly, 'пачка прошла мимо блокировки группы').toBe(false);
      });
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'foreign_site' });
      expect((await linksOf(doc)).map((l) => l.delivery_id)).toEqual([foreign]);
    });
  });

  describe('подсказка', () => {
    it('тот же номер, без документа рядом, отмеченные и найденные; чужие, удаляемые и далёкие — нет', async () => {
      const doc = await exportDoc({ tag: 'K1' });
      const at = (o: Parameters<typeof delivery>[0] = {}) => delivery({ site: siteC, ...o });
      const anchor = await at();
      await paper(anchor, 'K1');
      expect((await single(anchor, doc)).statusCode).toBe(200);

      const same = await at({ at: shift(0, 11) });
      const samePaper = await paper(same, 'K1');
      await paper(same, 'K9', null); // второй документ приёмки — не блок по умолчанию
      const noDoc = await at({ at: shift(1) });
      const farNoDoc = await at({ at: shift(20) });
      const otherSite = await delivery({ site: siteB });
      await paper(otherSite, 'K1');
      const removed = await at({ pending: true });
      await paper(removed, 'K1');
      const fromShipment = await at({ shipment: true });
      const picked = await at({ at: shift(60) });
      const searched = await at({ at: shift(-90) });

      const result = await candidates(anchor, doc, `&include=${picked}`);
      const byId = new Map(result.items.map((row) => [row.deliveryId, row]));
      expect(byId.get(anchor)).toMatchObject({ state: 'linked' });
      expect(byId.get(same)).toMatchObject({
        state: 'available',
        reasons: ['match'],
        level: 'high',
        defaultSectionId: samePaper,
      });
      expect(byId.get(same)!.documents).toHaveLength(2);
      expect(byId.get(noDoc)).toMatchObject({
        state: 'available',
        reasons: ['no_document'],
        defaultSectionId: null,
      });
      expect(byId.get(picked)).toMatchObject({ reasons: ['selected'] });
      for (const absent of [farNoDoc, otherSite, removed, fromShipment, searched]) {
        expect(byId.has(absent), absent).toBe(false);
      }
      // Уже привязанная — в конце, совпадение — первым.
      expect(result.items[0]!.deliveryId).toBe(same);
      expect(result.items[result.items.length - 1]!.deliveryId).toBe(anchor);

      const found = await candidates(anchor, doc, `&q=${await displayIdOf(searched)}`);
      expect(found.items.find((row) => row.deliveryId === searched)).toMatchObject({
        reasons: ['search'],
      });
    });

    it('неверный список отмеченных — 400; нет УПД — 404', async () => {
      const anchor = await delivery();
      const doc = await exportDoc({ tag: 'K2' });
      const bad = await app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${anchor}/edo-share-candidates?source=export&documentId=${doc}&include=nope`,
      });
      expect(bad.statusCode).toBe(400);
      const missing = await app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${anchor}/edo-share-candidates?source=export&documentId=${randomUUID()}`,
      });
      expect(missing.statusCode).toBe(404);
    });
  });

  describe('факт других приёмок', () => {
    it('по области связи: блок — его позиции, вся приёмка — все; удаляемые соседи не считаются', async () => {
      const doc = await exportDoc({ tag: 'M1' });
      const other = await exportDoc({ tag: 'M2' });
      const [d1, d2, d3] = [await delivery(), await delivery(), await delivery()];
      const p1 = await paper(d1, 'M1');
      await item(d1, { doc: p1, qty: 2, price: 100 });
      await item(d1, { doc: p1, qty: 1, price: 50 });
      await item(d1, { doc: null, qty: 7, price: 7 }); // вне блока
      await item(d2, { qty: 3, price: 10 });
      await item(d2, { qty: 4, price: 10 });

      const res = await batch(d1, doc, [
        { deliveryId: d1, sectionDocumentId: p1 },
        { deliveryId: d2, sectionDocumentId: null },
        { deliveryId: d3, sectionDocumentId: null },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      expect((await single(d2, other)).statusCode).toBe(200); // вторая УПД в той же области у d2
      await sql`UPDATE deliveries SET pending_deletion_at = now(), pending_deletion_by_user_id = ${managerId} WHERE id = ${d3}`;

      const fromD1 = await app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${d1}/edo-matches/shared`,
      });
      expect(fromD1.statusCode, fromD1.body).toBe(200);
      const [shared] = fromD1.json().items;
      expect(shared).toMatchObject({ count: 1 });
      expect(shared.deliveries).toEqual([
        expect.objectContaining({ deliveryId: d2, scope: 'delivery', otherEdoInScope: true }),
      ]);
      expect(
        shared.deliveries[0].rows.map((r: { qtyActual: string }) => Number(r.qtyActual)).sort(),
      ).toEqual([3, 4]);

      const fromD2 = await app.inject({
        method: 'GET',
        url: `/api/v1/deliveries/${d2}/edo-matches/shared`,
      });
      const d2Items = fromD2.json().items as {
        deliveries: { deliveryId: string; scope: string; rows: unknown[] }[];
      }[];
      // У d2 две привязки; общая только одна.
      expect(d2Items).toHaveLength(1);
      expect(d2Items[0]!.deliveries).toEqual([
        expect.objectContaining({ deliveryId: d1, scope: 'section', otherEdoInScope: false }),
      ]);
      expect(d2Items[0]!.deliveries[0]!.rows).toHaveLength(2);
    });
  });
});
