/**
 * Одна УПД у двух операторов ЭДО (Диадок и СБИС) — один документ. Проверка на
 * настоящем PostgreSQL.
 *
 * Обещания (план этапа Р, выпуск Р2; решение 22.10 «по составу»):
 *   - копия — тот же файл, тот же ИдФайл или тот же состав; одни реквизиты
 *     шапки — не копия (две строки);
 *   - в подборе одна строка — Диадока, с пометкой «есть и в СБИС»;
 *   - повторы внутри Диадока не склеиваются (решение 13.10);
 *   - выключатель EDO_SBIS_ENABLED убирает строки СБИС из подбора, «нет в
 *     реестре» и состояния реестра, но не правила привязки;
 *   - привязанная копия исключает из подбора и копию другого оператора, к
 *     другому объекту копию не привязать, к другой приёмке объекта — можно;
 *   - все пути привязки (окно ЭДО: строка реестра и импорт; «привязать
 *     документ»; создание приёмки) ждут встречную привязку копии и видят её,
 *     а не проходят мимо;
 *   - две привязки одной УПД к одной приёмке разными путями — без 40P01.
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';
import type { AuthUser } from '../../src/plugins/auth.js';
import type * as EnvModule from '../../src/lib/env.js';

const envState = vi.hoisted(() => ({ sbis: true }));

vi.mock('../../src/lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EnvModule>();
  return {
    ...actual,
    loadEnv: () => ({ ...actual.loadEnv(), EDO_SBIS_ENABLED: envState.sbis }),
  };
});

const { deliveryRoutes } = await import('../../src/routes/deliveries.js');
const { findEdoCandidates } = await import('../../src/domain/operations/edo-candidates.js');
const { edoDocumentUsage, edoUsageKey } = await import('../../src/domain/operations/edo-usage.js');
const { edoDocGroup, lockEdoDocGroup } = await import('../../src/domain/edo/export-twins.js');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

/** ИНН юрлица с верной контрольной цифрой. */
function inn10(prefix9: string): string {
  const weights = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const digits = [...prefix9].map(Number);
  return prefix9 + String((weights.reduce((acc, w, i) => acc + w * digits[i]!, 0) % 11) % 10);
}

const RUN = String(Date.now()).slice(-6);
const SUPPLIER_INN = inn10(`33${RUN}1`);
const SBIS_ONLY_INN = inn10(`33${RUN}2`);
const DAY = '2031-05-14';
/** Ключ тождества длиной sha256 — отличим по префиксу. */
const key = (tag: string) => `${tag}${RUN}`.padEnd(64, '0');
/**
 * Номер УПД по метке. Только цифры после префикса: поиск сравнивает номера по
 * цифрам, и «ДВ-…-C1» нашёл бы заодно «ДВ-…-G1».
 */
const tagNumbers = new Map<string, number>();
const num = (tag: string) => {
  if (!tagNumbers.has(tag)) tagNumbers.set(tag, 10 + tagNumbers.size);
  return `ДВ-${RUN}${tagNumbers.get(tag)}`;
};

suite('двойники УПД Диадок ↔ СБИС (реальный PostgreSQL)', { timeout: 120_000 }, () => {
  let app: FastifyInstance;
  let sql: ReturnType<typeof postgres>;
  let db: Db;

  const siteA = randomUUID();
  const siteB = randomUUID();
  const managerId = randomUUID();
  const sessionId = randomUUID();
  const diadocAcc = randomUUID();
  const diadocAcc2 = randomUUID();
  const sbisAcc = randomUUID();
  const dA1 = randomUUID();
  const dA2 = randomUUID();
  const dA3 = randomUUID();
  const dB = randomUUID();
  const dRef = randomUUID(); // бумажная УПД поставщика, который есть только в СБИС
  const paperId = randomUUID();
  const cards: string[] = [];

  let currentUser: AuthUser;

  async function exportDoc(o: {
    account: string;
    tag: string;
    sha: string;
    fileId?: string | null;
    contentKey?: string | null;
    inn?: string;
  }): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO edo_export_documents
        (id, edo_account_id, message_id, entity_id, document_type, document_number, document_date,
         supplier_inn, supplier_name, total_sum, content_category, status, s3_key, content_sha256,
         file_id, content_key, size_bytes, received_at)
      VALUES (${id}, ${o.account}, ${`m-${id}`}, ${`e-${id}`}, 'UniversalTransferDocument',
              ${num(o.tag)}, ${DAY}, ${o.inn ?? SUPPLIER_INN}, 'ООО «Двойник»', 1000.00, 'materials',
              'stored', ${`edo-export/test/${id}.xml`}, ${o.sha}, ${o.fileId ?? null},
              ${o.contentKey ?? null}, 2048, ${`${DAY}T09:00:00Z`})`;
    return id;
  }

  /** Пара копий: Диадок и СБИС, общий признак — `by` ('header' — только реквизиты шапки). */
  async function pair(tag: string, by: 'sha' | 'file' | 'content' | 'header') {
    const diadoc = await exportDoc({
      account: diadocAcc,
      tag,
      sha: key(`d${tag}`),
      fileId: by === 'file' ? `ON_NSCHFDOPPR_${tag}_${RUN}` : `ON_D_${tag}_${RUN}`,
      contentKey: by === 'content' ? key(`c${tag}`) : key(`cd${tag}`),
    });
    const sbis = await exportDoc({
      account: sbisAcc,
      tag,
      sha: by === 'sha' ? key(`d${tag}`) : key(`s${tag}`),
      fileId: by === 'file' ? `ON_NSCHFDOPPR_${tag}_${RUN}` : `ON_S_${tag}_${RUN}`,
      contentKey: by === 'content' ? key(`c${tag}`) : key(`cs${tag}`),
    });
    return { diadoc, sbis };
  }

  /** Импортированная карточка Диадока для строки реестра. */
  async function cardFor(exportId: string): Promise<string> {
    const id = randomUUID();
    cards.push(id);
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum,
                 edo_account_id, provider_message_id, provider_entity_id)
              SELECT ${id}, 'upd', 'inbound', 'parsed', 'edo_diadoc', ${siteA}, e.document_number,
                     e.document_date, e.total_sum, e.edo_account_id, e.message_id, e.entity_id
                FROM edo_export_documents e WHERE e.id = ${exportId}`;
    return id;
  }

  const ids = async (deliveryId: string, q: string) =>
    (await findEdoCandidates(db, deliveryId, { q }))!.items.map((item) => item.id);

  const linkExport = (deliveryId: string, documentId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/deliveries/${deliveryId}/edo-matches`,
      payload: { documentId, source: 'export' },
    });

  /**
   * Встречная привязка копии к приёмке другого объекта: держит транзакцию с
   * блокировками группы, пока запрос `start()` не встанет в ожидание, и
   * фиксирует её. Запрос обязан дождаться и увидеть эту привязку.
   */
  async function raceAgainstForeignLink(
    copyExportId: string,
    start: () => Promise<Awaited<ReturnType<typeof linkExport>>>,
  ) {
    let settledEarly = false;
    let pending!: Promise<Awaited<ReturnType<typeof linkExport>>>;
    await db.transaction(async (tx) => {
      await lockEdoDocGroup(tx, { exportIds: [copyExportId] });
      await tx.execute(drSql`insert into delivery_edo_matches (delivery_id, export_document_id)
                             values (${dB}, ${copyExportId})`);
      pending = start();
      void pending.then(() => {
        settledEarly = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settledEarly, 'запрос прошёл мимо блокировки группы').toBe(false);
    });
    return pending;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 8 });
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

    await sql`INSERT INTO sites (id, code, name) VALUES (${siteA}, ${`TWA${RUN}`}, 'Двойники А'),
                                                       (${siteB}, ${`TWB${RUN}`}, 'Двойники Б')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${managerId}, ${`twins-${managerId}@test`}, 'x', 'manager', NULL)`;
    await sql`INSERT INTO sessions (id, user_id) VALUES (${sessionId}, ${managerId})`;
    currentUser = {
      id: managerId,
      role: 'manager',
      siteId: null,
      contractorCustomerId: null,
      sessionId,
    } as unknown as AuthUser;

    await sql`INSERT INTO edo_accounts (id, name, credentials_encrypted, box_id)
              VALUES (${diadocAcc}, ${`Диадок ${RUN}`}, '{}', ${`box-${RUN}`}),
                     (${diadocAcc2}, ${`Диадок-2 ${RUN}`}, '{}', ${`box2-${RUN}`})`;
    await sql`INSERT INTO edo_accounts (id, name, provider, auth_mode, credentials_encrypted, box_id, org_inn)
              VALUES (${sbisAcc}, ${`СБИС ${RUN}`}, 'sbis', 'sbis_service_key', '{}',
                      'legal:7736255508:774550001:', '7736255508')`;

    const statusId = (
      await sql<{ id: string }[]>`
        SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`
    )[0]!.id;
    for (const [id, site] of [
      [dA1, siteA],
      [dA2, siteA],
      [dA3, siteA],
      [dB, siteB],
      [dRef, siteA],
    ] as const) {
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
                VALUES (${id}, ${site}, ${managerId}, ${statusId}, ${`${DAY}T07:00:00Z`}, 1)`;
    }
    await sql`INSERT INTO source_documents
                (id, kind, direction, status, origin, site_id, doc_number, doc_date, total_sum, supplier_inn_raw)
              VALUES (${paperId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteA},
                      ${num('S')}, ${DAY}, 1000.00, ${SBIS_ONLY_INN})`;
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id) VALUES (${dRef}, ${paperId})`;
  });

  afterAll(async () => {
    if (!sql) return;
    await app.close();
    const accounts = [diadocAcc, diadocAcc2, sbisAcc];
    await sql`DELETE FROM delivery_edo_matches WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id IN (${siteA}, ${siteB}))`;
    await sql`DELETE FROM delivery_sources WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id IN (${siteA}, ${siteB}))`;
    await sql`DELETE FROM deliveries WHERE site_id IN (${siteA}, ${siteB})`;
    await sql`DELETE FROM source_documents WHERE id IN ${sql([paperId, ...cards])}`;
    await sql`DELETE FROM edo_export_documents WHERE edo_account_id IN ${sql(accounts)}`;
    await sql`DELETE FROM edo_accounts WHERE id IN ${sql(accounts)}`;
    await sql`DELETE FROM sessions WHERE user_id = ${managerId}`;
    await sql`DELETE FROM users WHERE id = ${managerId}`;
    await sql`DELETE FROM sites WHERE id IN (${siteA}, ${siteB})`;
    await sql.end({ timeout: 5 });
  });

  it('группа: копия по файлу, ИдФайл и составу; реквизиты шапки и повторы внутри Диадока — нет', async () => {
    const bySha = await pair('G1', 'sha');
    const byFile = await pair('G2', 'file');
    const byContent = await pair('G3', 'content');
    const header = await pair('G4', 'header'); // общие только реквизиты шапки
    const card = await cardFor(bySha.diadoc);

    const fromSbis = await edoDocGroup(db, { exportIds: [bySha.sbis] });
    expect(new Set(fromSbis.exportIds)).toEqual(new Set([bySha.sbis, bySha.diadoc]));
    expect(fromSbis.sourceIds).toEqual([card]);
    // С карточки — та же группа.
    const fromCard = await edoDocGroup(db, { sourceIds: [card] });
    expect(new Set(fromCard.exportIds)).toEqual(new Set([bySha.sbis, bySha.diadoc]));

    for (const p of [byFile, byContent]) {
      expect(new Set((await edoDocGroup(db, { exportIds: [p.diadoc] })).exportIds)).toEqual(
        new Set([p.diadoc, p.sbis]),
      );
    }
    expect((await edoDocGroup(db, { exportIds: [header.diadoc] })).exportIds).toEqual([header.diadoc]);

    // Тот же файл у двух учёток Диадока — не группа.
    const twinA = await exportDoc({ account: diadocAcc, tag: 'G5', sha: key('dG5') });
    const twinB = await exportDoc({ account: diadocAcc2, tag: 'G5', sha: key('dG5') });
    expect((await edoDocGroup(db, { exportIds: [twinA] })).exportIds).toEqual([twinA]);
    expect((await edoDocGroup(db, { exportIds: [twinB] })).exportIds).toEqual([twinB]);
  });

  it('подбор: одна строка Диадока с пометкой «есть и в СБИС»; по шапке — две строки; Диадок с Диадоком — две', async () => {
    envState.sbis = true;
    const bySha = await pair('C1', 'sha');
    const byContent = await pair('C2', 'content');
    const header = await pair('C3', 'header');
    const dupA = await exportDoc({ account: diadocAcc, tag: 'C4', sha: key('dC4') });
    const dupB = await exportDoc({ account: diadocAcc2, tag: 'C4', sha: key('dC4') });

    for (const p of [bySha, byContent]) {
      const result = (await findEdoCandidates(db, dA3, { q: num(p === bySha ? 'C1' : 'C2') }))!;
      expect(result.items.map((item) => item.id)).toEqual([p.diadoc]);
      expect(result.items[0]).toMatchObject({ operator: 'diadoc', alsoInOperators: ['sbis'] });
    }
    const headerItems = (await findEdoCandidates(db, dA3, { q: num('C3') }))!.items;
    expect(new Set(headerItems.map((item) => item.id))).toEqual(new Set([header.diadoc, header.sbis]));
    expect(headerItems.find((item) => item.id === header.sbis)).toMatchObject({
      operator: 'sbis',
      alsoInOperators: [],
    });
    expect(new Set(await ids(dA3, num('C4')))).toEqual(new Set([dupA, dupB]));
  });

  it('выключатель СБИС: строк СБИС нет в подборе, «нет в реестре» и состоянии реестра; пометки нет', async () => {
    const pairOn = await pair('F1', 'sha');
    const header = await pair('F2', 'header');
    const sbisOnly = await exportDoc({ account: sbisAcc, tag: 'S', sha: key('sS'), inn: SBIS_ONLY_INN });
    try {
      envState.sbis = false;
      const result = (await findEdoCandidates(db, dA3, { q: num('F1') }))!;
      expect(result.items.map((item) => item.id)).toEqual([pairOn.diadoc]);
      expect(result.items[0]).toMatchObject({ alsoInOperators: [] });
      expect(await ids(dA3, num('F2'))).toEqual([header.diadoc]);
      const ref = (await findEdoCandidates(db, dRef))!;
      expect(ref.items.map((item) => item.id)).not.toContain(sbisOnly);
      expect(ref.diagnostics.innsAbsentInRegistry).toContain(SBIS_ONLY_INN);
      expect(ref.diagnostics.registry.map((account) => account.accountId)).not.toContain(sbisAcc);

      envState.sbis = true;
      const on = (await findEdoCandidates(db, dRef))!;
      expect(on.items.map((item) => item.id)).toContain(sbisOnly);
      expect(on.diagnostics.innsAbsentInRegistry).not.toContain(SBIS_ONLY_INN);
      expect(on.diagnostics.registry.find((account) => account.accountId === sbisAcc)).toMatchObject({
        provider: 'sbis',
      });
    } finally {
      envState.sbis = true;
    }
  });

  it('привязка: копия в этой приёмке — 409 и не в подборе; другой объект — 409; соседняя приёмка — можно, «ещё в приёмках»', async () => {
    const p = await pair('L1', 'content');
    expect((await linkExport(dA1, p.sbis)).statusCode).toBe(200);

    // Копия Диадока в той же приёмке — уже привязана, в подборе её нет.
    expect(await ids(dA1, num('L1'))).toEqual([]);
    const again = await linkExport(dA1, p.diadoc);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'already_linked' });

    // Другой объект — нельзя, и в его подборе копии нет.
    const foreign = await linkExport(dB, p.diadoc);
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json()).toMatchObject({ error: 'foreign_site' });
    expect(await ids(dB, num('L1'))).toEqual([]);

    // Соседняя приёмка того же объекта — можно, с подсказкой «уже в приёмке».
    const neighbour = (await findEdoCandidates(db, dA2, { q: num('L1') }))!.items;
    expect(neighbour.map((item) => item.id)).toEqual([p.diadoc]);
    expect(neighbour[0]).toMatchObject({ usedElsewhere: 1, usedIn: [expect.objectContaining({ deliveryId: dA1 })] });
    expect((await linkExport(dA2, p.diadoc)).statusCode).toBe(200);
    const usage = await edoDocumentUsage(db, [{ source: 'export', id: p.diadoc }], dA2);
    expect(usage.get(edoUsageKey({ source: 'export', id: p.diadoc }))).toMatchObject({
      count: 1,
      deliveries: [expect.objectContaining({ deliveryId: dA1 })],
    });

    const linked = await app.inject({ method: 'GET', url: `/api/v1/deliveries/${dA1}/edo-matches` });
    expect(linked.json()).toMatchObject({ items: [{ documentId: p.sbis, operator: 'sbis' }] });
  });

  it('копия СБИС при импортированной карточке Диадока — 409 imported_available', async () => {
    const p = await pair('I1', 'sha');
    await cardFor(p.diadoc);
    const res = await linkExport(dA3, p.sbis);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'imported_available' });
  });

  describe('встречная привязка копии к другому объекту', () => {
    it('окно ЭДО, строка реестра: ждёт и получает foreign_site', async () => {
      const p = await pair('R1', 'content');
      const res = await raceAgainstForeignLink(p.diadoc, () => linkExport(dA1, p.sbis));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'foreign_site' });
    });

    it('окно ЭДО, импортированная карточка: ждёт и получает foreign_site', async () => {
      const p = await pair('R2', 'sha');
      const card = await cardFor(p.diadoc);
      const res = await raceAgainstForeignLink(p.sbis, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/deliveries/${dA1}/edo-matches`,
          payload: { documentId: card, source: 'import' },
        }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'foreign_site' });
    });

    it('«привязать документ»: ждёт и получает source_document_foreign_site', async () => {
      const p = await pair('R3', 'file');
      const card = await cardFor(p.diadoc);
      const res = await raceAgainstForeignLink(p.sbis, () =>
        app.inject({
          method: 'POST',
          url: `/api/v1/deliveries/${dA1}/link-source`,
          payload: { sourceDocumentId: card },
        }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'source_document_foreign_site' });
    });

    it('создание приёмки с документом: ждёт и получает source_document_foreign_site', async () => {
      const p = await pair('R4', 'content');
      const card = await cardFor(p.diadoc);
      const res = await raceAgainstForeignLink(p.sbis, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/deliveries',
          payload: { statusCode: 'filled', siteId: siteA, items: [], sourceDocumentIds: [card] },
        }),
      );
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'source_document_foreign_site' });
    });
  });

  it('одна УПД в одну приёмку двумя путями одновременно — одна связь, без 40P01', async () => {
    for (const tag of ['X1', 'X2', 'X3']) {
      const p = await pair(tag, 'sha');
      const card = await cardFor(p.diadoc);
      const delivery = randomUUID();
      const statusId = (
        await sql<{ id: string }[]>`
          SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`
      )[0]!.id;
      await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, arrived_at, version)
                VALUES (${delivery}, ${siteA}, ${managerId}, ${statusId}, ${`${DAY}T07:00:00Z`}, 1)`;
      const results = await Promise.all([
        linkExport(delivery, p.sbis),
        app.inject({
          method: 'POST',
          url: `/api/v1/deliveries/${delivery}/link-source`,
          payload: { sourceDocumentId: card },
        }),
        app.inject({
          method: 'POST',
          url: `/api/v1/deliveries/${delivery}/edo-matches`,
          payload: { documentId: card, source: 'import' },
        }),
      ]);
      const codes = results.map((res) => res.statusCode);
      expect(codes.filter((code) => code === 200), JSON.stringify(results.map((r) => r.json()))).toHaveLength(1);
      expect(codes.filter((code) => code === 409)).toHaveLength(2);
    }
  });
});
