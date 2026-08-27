/**
 * Фиксация замены распознанного содержимого документа:
 * `markSourceDocumentContentChanged`.
 *
 * Зачем набор. Повторное распознавание переписывает шапку и позиции, но версию
 * документа не двигало: общий путь звал `bumpGroupRevision`, а тот для пакета,
 * машиной НЕ являющегося, вырождается в no-op целиком (пустой CTE обнуляет и
 * финальный UPDATE); путь накладной не звал бампа вовсе. Дельта `/sync` отбирает
 * по `updated_at` и потому исправление привозила, а сверка сравнивает строго
 * `version > clientVersion` — и планшет, пропустивший дельту, оставался с пустой
 * карточкой НАВСЕГДА. На бою 27.08 так осталось 52 документа из 72 повторов.
 *
 * Что здесь ловится и не ловится больше нигде:
 *   * одиночный документ бампается, хотя машины у него нет, — ровно та ветка,
 *     которой не было;
 *   * документ машины и его соседи получают РОВНО ПО ОДНОМУ инкременту. Два
 *     отдельных запроса («изменённому +1» и «всей машине +1») дали бы ему +2,
 *     и это не поймать ничем, кроме сверки чисел до и после;
 *   * `bumpGroupRevision` на одиночном документе остаётся no-op — регрессия на
 *     причину дефекта: если однажды его «почините», два helper'а начнут
 *     дублировать друг друга;
 *   * устаревшее поколение до бампа не доходит.
 *
 * Запуск: TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5444/matcheck_test
 * Без него набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syncRoutes } from '../../src/routes/sync.js';
import { sourceDocuments } from '../../src/db/schema.js';
import {
  bumpGroupRevision,
  markSourceDocumentContentChanged,
} from '../../src/domain/sourceDocuments/document-group.js';
import type { AuthUser } from '../../src/plugins/auth.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('фиксация замены содержимого документа (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let app: FastifyInstance;
  let currentUser: AuthUser;

  const siteId = randomUUID();
  const inspectorId = randomUUID();

  // Машина: корневой пакет logical_v1 + опубликован → machineRootSql истинно
  // при выключенном GROUPS_ROLLOUT. Дочерний пакет несёт накладную — так их и
  // раскладывает router.
  const rootBundleId = randomUUID();
  const childBundleId = randomUUID();
  const machineUpdId = randomUUID();
  const machineSiblingId = randomUUID();
  const machineWaybillId = randomUUID();

  // Не машина: legacy-пакет. Ровно тот случай, где прежний бамп молчал.
  const soloBundleId = randomUUID();
  const soloUpdId = randomUUID();
  const soloWaybillId = randomUUID();

  // Документ ВООБЩЕ без пакета — путь EDO/почты.
  const looseDocId = randomUUID();

  const GROUP_REVISION = 5;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);
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
    await app.register(syncRoutes);
    await app.ready();

    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`MCC${Date.now() % 10000}`}, 'Замена содержимого')`;
    await sql`INSERT INTO users (id, email, password_hash, role, site_id)
              VALUES (${inspectorId}, ${`mcc-${inspectorId}@test`}, 'x', 'inspector_kpp', ${siteId})`;

    const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, published_generation, group_revision)
      VALUES (${rootBundleId}, ${hash('mccroot')}, 'inbound', ${siteId}, 'parsed', 3, 'mixed',
              'logical_v1', 0, ${GROUP_REVISION})`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, parent_bundle_id, group_revision)
      VALUES (${childBundleId}, ${hash('mccchild')}, 'inbound', ${siteId}, 'parsed', 1, 'waybill',
              'legacy', ${rootBundleId}, 1)`;
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, doc_count, kind,
         assembly_version, group_revision)
      VALUES (${soloBundleId}, ${hash('mccsolo')}, 'inbound', ${siteId}, 'parsed', 2, 'mixed',
              'legacy', 0)`;

    const doc = (id: string, num: string, kind: string, bundleId: string | null) => sql`
      INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, expected_date, total_sum, bundle_id, version, dispatch_generation)
      VALUES (${id}, ${kind}, false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              ${num}, now(), now(), 100, ${bundleId}, 1, 0)`;

    await doc(machineUpdId, 'МСС-1', 'upd', rootBundleId);
    await doc(machineSiblingId, 'МСС-2', 'upd', rootBundleId);
    await doc(machineWaybillId, 'МСС-192', 'transport_waybill', childBundleId);
    await doc(soloUpdId, 'МСС-S1', 'upd', soloBundleId);
    await doc(soloWaybillId, 'МСС-S2', 'transport_waybill', soloBundleId);
    await doc(looseDocId, 'МСС-EDO', 'upd', null);

    currentUser = {
      id: inspectorId,
      role: 'inspector_kpp',
      siteId,
      contractorCustomerId: null,
      sessionId: randomUUID(),
    } as unknown as AuthUser;
  });

  afterAll(async () => {
    await app?.close();
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE parent_bundle_id = ${rootBundleId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${inspectorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  async function versionOf(id: string): Promise<number> {
    const [row] = await sql<{ version: number }[]>`
      SELECT version FROM source_documents WHERE id = ${id}`;
    return Number(row!.version);
  }

  async function groupRevisionOf(bundleId: string): Promise<number> {
    const [row] = await sql<{ group_revision: number }[]>`
      SELECT group_revision FROM source_bundles WHERE id = ${bundleId}`;
    return Number(row!.group_revision);
  }

  it('одиночный УПД: версия растёт, хотя машины у документа нет', async () => {
    const before = await versionOf(soloUpdId);
    await markSourceDocumentContentChanged(db, soloUpdId);
    expect(await versionOf(soloUpdId)).toBe(before + 1);
  });

  it('одиночная накладная: версия растёт — путь waybill_single бампа не звал вовсе', async () => {
    const before = await versionOf(soloWaybillId);
    await markSourceDocumentContentChanged(db, soloWaybillId);
    expect(await versionOf(soloWaybillId)).toBe(before + 1);
  });

  it('соседа по НЕ-машине не трогаем: legacy-пакет машиной не является', async () => {
    const neighbourBefore = await versionOf(soloWaybillId);
    await markSourceDocumentContentChanged(db, soloUpdId);
    expect(await versionOf(soloWaybillId)).toBe(neighbourBefore);
  });

  it('документ машины: он и соседи получают РОВНО ПО ОДНОМУ инкременту', async () => {
    const changedBefore = await versionOf(machineUpdId);
    const siblingBefore = await versionOf(machineSiblingId);
    const waybillBefore = await versionOf(machineWaybillId);
    const revisionBefore = await groupRevisionOf(rootBundleId);

    await markSourceDocumentContentChanged(db, machineUpdId);

    // Ключевая проверка: у изменённого документа +1, а не +2. Два отдельных
    // запроса («изменённому» и «всей машине») дали бы двойной инкремент.
    expect(await versionOf(machineUpdId)).toBe(changedBefore + 1);
    expect(await versionOf(machineSiblingId)).toBe(siblingBefore + 1);
    // Документ дочернего пакета — часть той же машины.
    expect(await versionOf(machineWaybillId)).toBe(waybillBefore + 1);
    expect(await groupRevisionOf(rootBundleId)).toBe(revisionBefore + 1);
  });

  it('документ без пакета (EDO/почта) тоже бампается', async () => {
    // Соседи ищутся через EXISTS, а не FROM-джойном по source_bundles: у этого
    // документа bundle_id равен NULL, и джойн выбросил бы его из UPDATE
    // молча — то есть повторил бы исходный дефект на другом пути.
    const before = await versionOf(looseDocId);
    await markSourceDocumentContentChanged(db, looseDocId);
    expect(await versionOf(looseDocId)).toBe(before + 1);
  });

  it('bumpGroupRevision на одиночном документе по-прежнему no-op — это и есть причина дефекта', async () => {
    const before = await versionOf(soloUpdId);
    await bumpGroupRevision(db, soloUpdId);
    expect(await versionOf(soloUpdId)).toBe(before);
  });

  it('устаревшее поколение до бампа не доходит: запись не находит строку', async () => {
    const before = await versionOf(soloUpdId);
    // Ровно та защита, что стоит в обеих транзакциях распознавания: воркер
    // пишет под generationScoped и бросает StaleGenerationError, если строка не
    // совпала. Helper вызывается ПОСЛЕ неё, поэтому устаревший результат не
    // может добавить свой инкремент поверх уже актуальной версии.
    const saved = await db
      .update(sourceDocuments)
      .set({ docNumber: 'устаревший результат' })
      .where(and(eq(sourceDocuments.id, soloUpdId), eq(sourceDocuments.dispatchGeneration, 999)))
      .returning({ id: sourceDocuments.id });

    expect(saved).toHaveLength(0);
    expect(await versionOf(soloUpdId)).toBe(before);
  });

  it('/sync/reconcile: после бампа документ приходит в staleOnClient', async () => {
    const clientVersion = await versionOf(soloUpdId);

    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/reconcile',
      payload: { sourceDocuments: [{ id: soloUpdId, version: clientVersion }] },
    });
    expect(before.statusCode).toBe(200);
    expect(
      (before.json() as { sourceDocuments: { staleOnClient: { id: string }[] } }).sourceDocuments
        .staleOnClient,
    ).toHaveLength(0);

    await markSourceDocumentContentChanged(db, soloUpdId);

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/sync/reconcile',
      payload: { sourceDocuments: [{ id: soloUpdId, version: clientVersion }] },
    });
    expect(after.statusCode).toBe(200);
    const stale = (
      after.json() as { sourceDocuments: { staleOnClient: { id: string; serverVersion: number }[] } }
    ).sourceDocuments.staleOnClient;
    expect(stale).toHaveLength(1);
    expect(stale[0]!.id).toBe(soloUpdId);
    expect(stale[0]!.serverVersion).toBe(clientVersion + 1);
  });
});
