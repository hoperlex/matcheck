/**
 * Журнал переходов видимости: как планшет узнаёт, что документ ПРОПАЛ.
 *
 * Дельта /sync отбирает по `updated_at`, а скрытие часто происходит без правки
 * самого документа: сосед по машине ушёл на переразбор, в пачку добавился ещё
 * не разобранный файл. Планшет такого не заметит и продолжит показывать машину,
 * которой больше нет.
 *
 * Что здесь ловится и не ловится больше нигде:
 *   * СХЛОПЫВАНИЕ hide→show. Между двумя синхронизациями документ мог скрыться
 *     и появиться снова. Без схлопывания клиент получил бы id и в документах, и
 *     в удалениях, а порядок применения («сначала записать, потом удалить»)
 *     означал бы, что документ будет стёрт сразу после записи;
 *   * СОБЫТИЕ ТОЛЬКО НА ПЕРЕХОД. Повторный вызов на неизменившемся документе
 *     ничего не добавляет — иначе журнал рос бы на каждый разбор, а клиент
 *     получал бы поток холостых удалений;
 *   * ПЕРВОЕ СОБЫТИЕ ТОЛЬКО ДЛЯ СКРЫТИЯ. «Появился» — это обычная дельта по
 *     updated_at, отдельная запись ей ничего не добавляет;
 *   * ГРУППОВОЕ СКРЫТИЕ. Когда машина уходит в промежуточное состояние, событие
 *     обязано появиться у КАЖДОГО ранее видимого документа, иначе на планшете
 *     останется половина машины.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  recordVisibilityTransitions,
  selectVisibilityTombstones,
} from '../../src/domain/sourceDocuments/visibility-events.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('журнал переходов видимости (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  const siteId = randomUUID();
  const contractorId = randomUUID();

  const hash = (s: string) => `${s}${randomUUID().replace(/-/g, '')}`.slice(0, 64);

  async function bundle(id: string) {
    await sql`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, assembly_version,
         published_generation, active_upload_generation)
      VALUES (${id}, ${hash('ve')}, 'inbound', ${siteId}, 'parsed', 'mixed',
              'logical_v1', 0, 0)`;
  }

  async function doc(id: string, bundleId: string | null, status = 'parsed') {
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date, contractor_id)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', ${status}, ${siteId}, now(),
              'СОБ-1', now(), 100, ${bundleId}, now(), ${contractorId})`;
  }

  const events = (id: string) =>
    sql<{ visibility: string }[]>`SELECT visibility FROM source_document_visibility_events
                                   WHERE source_document_id = ${id}
                                   ORDER BY created_at, id`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);
    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`VEV${Date.now() % 10000}`}, 'События видимости')`;
    await sql`INSERT INTO counterparties (id, inn, name, is_contractor)
              VALUES (${contractorId}, ${`78${Date.now() % 100000000}`}, 'Подрядчик событий', true)`;
  });

  afterEach(async () => {
    await sql`DELETE FROM source_document_visibility_events WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_bundles WHERE site_id = ${siteId}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM counterparties WHERE id = ${contractorId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end();
  });

  it('видимый документ не порождает события: «появился» — это обычная дельта', async () => {
    const id = randomUUID();
    await doc(id, null);
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'разбор' });
    expect(await events(id)).toHaveLength(0);
  });

  it('скрытие пишет событие, повтор — нет', async () => {
    const id = randomUUID();
    await doc(id, null, 'processing');

    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'ушёл в разбор' });
    expect((await events(id)).map((e) => e.visibility)).toEqual(['hidden']);

    // Ничего не изменилось — журнал не растёт.
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'повтор' });
    expect((await events(id)).map((e) => e.visibility)).toEqual(['hidden']);
  });

  it('возврат видимости пишет обратный переход', async () => {
    const id = randomUUID();
    await doc(id, null, 'processing');
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'ушёл в разбор' });

    await sql`UPDATE source_documents SET status = 'parsed' WHERE id = ${id}`;
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'разобран' });

    expect((await events(id)).map((e) => e.visibility)).toEqual(['hidden', 'visible']);
  });

  it('hide→show между синхронизациями: в удаления документ не попадает', async () => {
    const id = randomUUID();
    const since = new Date(Date.now() - 60_000);
    await doc(id, null, 'processing');
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'ушёл в разбор' });
    await sql`UPDATE source_documents SET status = 'parsed' WHERE id = ${id}`;
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'разобран' });

    // Клиент должен увидеть только конечное состояние — документ снова виден.
    const tombstones = await selectVisibilityTombstones(db, { since, siteId });
    expect(tombstones).not.toContain(id);
  });

  it('show→hide между синхронизациями: документ попадает в удаления', async () => {
    const id = randomUUID();
    const since = new Date(Date.now() - 60_000);
    await doc(id, null, 'processing');
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'ушёл в разбор' });
    await sql`UPDATE source_documents SET status = 'parsed' WHERE id = ${id}`;
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'разобран' });
    await sql`UPDATE source_documents SET status = 'needs_resolution' WHERE id = ${id}`;
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'расхождение сумм' });

    const tombstones = await selectVisibilityTombstones(db, { since, siteId });
    expect(tombstones).toContain(id);
  });

  it('скрытие машины помечает КАЖДЫЙ её ранее видимый документ', async () => {
    const root = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    await bundle(root);
    await doc(a, root);
    await doc(b, root);

    // Оба видны — событий нет.
    await recordVisibilityTransitions(db, { groupId: root, reason: 'опубликовано' });
    expect(await events(a)).toHaveLength(0);
    expect(await events(b)).toHaveLength(0);

    // Один документ ушёл на переразбор — по предикату скрывается ВСЯ машина.
    await sql`UPDATE source_documents SET status = 'queued' WHERE id = ${b}`;
    await recordVisibilityTransitions(db, { groupId: root, reason: 'переразбор документа машины' });

    // Событие обязано появиться у обоих, иначе на планшете останется половина.
    expect((await events(a)).map((e) => e.visibility)).toEqual(['hidden']);
    expect((await events(b)).map((e) => e.visibility)).toEqual(['hidden']);
  });

  it('событие переживает удаление документа', async () => {
    const id = randomUUID();
    const since = new Date(Date.now() - 60_000);
    await doc(id, null, 'processing');
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'ушёл в разбор' });

    await sql`DELETE FROM source_documents WHERE id = ${id}`;

    // Планшет, вернувшийся из офлайна, обязан узнать об исчезновении.
    const tombstones = await selectVisibilityTombstones(db, { since, siteId });
    expect(tombstones).toContain(id);
  });

  it('чужой объект в выдачу инспектора не попадает', async () => {
    const id = randomUUID();
    const since = new Date(Date.now() - 60_000);
    await doc(id, null, 'processing');
    await recordVisibilityTransitions(db, { documentIds: [id], reason: 'ушёл в разбор' });

    const foreign = await selectVisibilityTombstones(db, { since, siteId: randomUUID() });
    expect(foreign).not.toContain(id);
  });
});
