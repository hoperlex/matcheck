/**
 * Канонический состав машины.
 *
 * Проверяется то, из-за чего состав нельзя было описать «на словах». Первая
 * версия правила звучала как «все нетехнические неудалённые документы пакета»,
 * и она неверна: `archived` не блокирует готовность группы, но и на планшет не
 * уезжает. Сервер потребовал бы от клиента документ, которого тот никогда не
 * видел, и валидная машина отклонялась бы как неполная — молча и всегда.
 *
 * Второе, что здесь ловится: подмножество и посторонний документ должны
 * различаться в ответе. Инспектору нужно объяснить, что произошло, а «состав не
 * совпал» не объясняет ничего.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import {
  compareWithComposition,
  resolveGroupComposition,
} from '../../src/domain/sourceDocuments/group-composition.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('канонический состав группы (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;

  const siteId = randomUUID();
  const contractorId = randomUUID();
  const contractorInn = `79${String(Date.now()).slice(-8)}`;

  /** Машина из двух готовых УПД плюс архивный сосед. */
  const rootId = randomUUID();
  const docA = randomUUID();
  const docB = randomUUID();
  const docArchived = randomUUID();

  /** Вторая машина — для проверки «документы из разных групп». */
  const otherRootId = randomUUID();
  const otherDoc = randomUUID();

  /** Документ вне сборки: группы у него нет вовсе. */
  const loneBundleId = randomUUID();
  const loneDoc = randomUUID();

  async function insertBundle(id: string, assembly: 'logical_v1' | 'legacy'): Promise<void> {
    await sql`INSERT INTO source_bundles
        (id, kind, direction, site_id, status, bundle_hash, assembly_version,
         group_revision, published_generation, active_upload_generation)
      VALUES (${id}, 'mixed', 'inbound', ${siteId}, 'parsed', ${`gc-${id}`}, ${assembly},
              1, 0, 0)`;
  }

  async function insertDoc(
    id: string,
    bundleId: string,
    status: 'parsed' | 'archived' | 'needs_resolution',
    docNumber: string,
  ): Promise<void> {
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, expected_date, contractor_id, bundle_id)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', ${status}, ${siteId}, now(),
              ${docNumber}, now(), 100, now(), ${contractorId}, ${bundleId})`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`GC${Date.now() % 100000}`}, 'Состав группы')`;
    await sql`INSERT INTO counterparties (id, inn, kpp, name)
              VALUES (${contractorId}, ${contractorInn}, NULL, 'ООО «Состав»')`;

    await insertBundle(rootId, 'logical_v1');
    await insertDoc(docA, rootId, 'parsed', 'GC-A');
    await insertDoc(docB, rootId, 'parsed', 'GC-B');
    // Архивный сосед: осознанно исключённый дубль. Готовность машины он не
    // держит, но и в состав входить не должен.
    await insertDoc(docArchived, rootId, 'archived', 'GC-ARCH');

    await insertBundle(otherRootId, 'logical_v1');
    await insertDoc(otherDoc, otherRootId, 'parsed', 'GC-OTHER');

    // legacy-сборка: «файл = документ», группы нет.
    await insertBundle(loneBundleId, 'legacy');
    await insertDoc(loneDoc, loneBundleId, 'parsed', 'GC-LONE');
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql.end({ timeout: 5 });
  });

  async function compositionOf(ids: string[]) {
    const res = await resolveGroupComposition(db, {
      documentIds: ids,
      siteId,
      direction: 'inbound',
    });
    return res;
  }

  it('состав машины — только то, что доехало до планшета: архивный сосед исключён', async () => {
    const res = await compositionOf([docA]);
    expect('composition' in res).toBe(true);
    const { composition } = res as { composition: { groupId: string; documentIds: string[] } };
    expect(composition.groupId).toBe(rootId);
    expect(composition.documentIds.sort()).toEqual([docA, docB].sort());
    expect(composition.documentIds).not.toContain(docArchived);
  });

  it('ревизия состава приходит вместе с составом', async () => {
    const res = await compositionOf([docA]);
    const { composition } = res as { composition: { groupRevision: number | null } };
    expect(composition.groupRevision).toBe(1);
  });

  it('дубль в списке — отказ до запроса: иначе связи упали бы по первичному ключу', async () => {
    const res = await compositionOf([docA, docA]);
    expect('error' in res).toBe(true);
    const { error } = res as { error: { kind: string; documentIds: string[] } };
    expect(error.kind).toBe('duplicate_documents');
    expect(error.documentIds).toEqual([docA]);
  });

  it('документы из разных машин вместе не принимаются', async () => {
    const res = await compositionOf([docA, otherDoc]);
    expect('error' in res).toBe(true);
    const { error } = res as { error: { kind: string; groupIds: string[] } };
    expect(error.kind).toBe('multiple_groups');
    expect(error.groupIds.sort()).toEqual([rootId, otherRootId].sort());
  });

  it('legacy-документ группы не образует — прежний путь без claim', async () => {
    const res = await compositionOf([loneDoc]);
    const { composition } = res as { composition: { groupId: string | null } };
    expect(composition.groupId).toBeNull();
  });

  it('пустой список документов — ручная приёмка, группы нет', async () => {
    const res = await compositionOf([]);
    const { composition } = res as { composition: { groupId: string | null } };
    expect(composition.groupId).toBeNull();
  });

  it('подмножество и посторонний документ различаются в ответе', async () => {
    const res = await compositionOf([docA]);
    const { composition } = res as {
      composition: { groupId: string; groupRevision: number | null; documentIds: string[] };
    };

    // Прислали половину машины.
    const partial = compareWithComposition([docA], composition);
    expect(partial?.kind).toBe('incomplete_group');
    expect((partial as { missing: string[] }).missing).toEqual([docB]);
    expect((partial as { extra: string[] }).extra).toEqual([]);

    // Прислали всё плюс чужое — это другая ошибка, и клиент обязан их различать.
    const withExtra = compareWithComposition([docA, docB, otherDoc], composition);
    expect(withExtra?.kind).toBe('incomplete_group');
    expect((withExtra as { extra: string[] }).extra).toEqual([otherDoc]);
    expect((withExtra as { missing: string[] }).missing).toEqual([]);

    // Полный состав принимается.
    expect(compareWithComposition([docB, docA], composition)).toBeNull();
  });

  it('неготовый сосед закрывает машину целиком: состав пуст, операции быть не может', async () => {
    // Пока хоть один документ машины не обработан, на планшет не уезжает ни
    // один — значит и принимать нечего. Ровно это и означает пустой состав.
    const brokenRootId = randomUUID();
    const brokenReady = randomUUID();
    const brokenPending = randomUUID();
    await insertBundle(brokenRootId, 'logical_v1');
    await insertDoc(brokenReady, brokenRootId, 'parsed', 'GC-BROKEN-OK');
    await insertDoc(brokenPending, brokenRootId, 'needs_resolution', 'GC-BROKEN-NR');

    const res = await resolveGroupComposition(db, {
      documentIds: [brokenReady],
      siteId,
      direction: 'inbound',
    });
    const { composition } = res as { composition: { documentIds: string[] } };
    expect(composition.documentIds).toEqual([]);
  });
});
