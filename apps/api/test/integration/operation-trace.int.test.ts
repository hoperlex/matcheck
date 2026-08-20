/**
 * Когда состав документа нельзя править машиной.
 *
 * Скрипт починки раздутых УПД (scripts/repair-merged-upd.ts) удаляет
 * задвоенные строки. Если по документу уже провели приёмку, делать этого
 * нельзя — и одной проверки `delivery_sources` для этого мало. Привязка
 * документа и происхождение позиций живут в разных местах:
 * `POST /deliveries/:id/unlink-source` снимает привязку и намеренно НЕ трогает
 * `delivery_items.source_document_item_id`. А у той колонки ON DELETE SET NULL:
 * удаление строки документа не упрётся в БД, а молча обнулит происхождение
 * позиции в проведённой приёмке.
 *
 * Запуск: см. шапку foreign-site.int.test.ts (тот же TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operationTrace } from '../../src/domain/sourceDocuments/operation-trace.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('след документа в операциях (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  const siteId = randomUUID();
  const userId = randomUUID();
  let statusId: string;

  /** Документ с одной позицией — заготовка под каждый сценарий. */
  async function seedDocument(): Promise<{ docId: string; itemId: string }> {
    const docId = randomUUID();
    await sql`INSERT INTO source_documents (id, kind, direction, status, origin, site_id, doc_number)
      VALUES (${docId}, 'upd', 'inbound', 'parsed', 'manual_pdf', ${siteId}, ${'ТР-' + docId.slice(0, 6)})`;
    const [item] = await sql<{ id: string }[]>`
      INSERT INTO source_document_items (source_document_id, name_raw, qty, unit, line_no)
      VALUES (${docId}, 'Кабель ВВГнг 3х1,5', 100, 'м', 1)
      RETURNING id`;
    return { docId, itemId: item!.id };
  }

  async function seedDelivery(): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO deliveries (id, site_id, inspector_id, status_id, version)
      VALUES (${id}, ${siteId}, ${userId}, ${statusId}, 1)`;
    return id;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql);
    await sql`INSERT INTO sites (id, code, name) VALUES (${siteId}, ${'TRC'}, 'Trace test')
      ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO users (id, email, password_hash, role)
      VALUES (${userId}, ${`trace-${userId}@test`}, 'x', 'manager') ON CONFLICT DO NOTHING`;
    const [s] = await sql<{ id: string }[]>`
      SELECT id FROM statuses WHERE entity_type = 'delivery' AND code = 'filled' LIMIT 1`;
    statusId = s!.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM delivery_items WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM delivery_sources WHERE delivery_id IN (SELECT id FROM deliveries WHERE site_id = ${siteId})`;
    await sql`DELETE FROM deliveries WHERE site_id = ${siteId}`;
    await sql`DELETE FROM source_document_items WHERE source_document_id IN (SELECT id FROM source_documents WHERE site_id = ${siteId})`;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM users WHERE id = ${userId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('свободный документ следа не оставил — править можно', async () => {
    const { docId, itemId } = await seedDocument();
    expect(await operationTrace(db as never, docId, [itemId])).toBeNull();
  });

  it('привязка к приёмке видна и называет её номер', async () => {
    const { docId, itemId } = await seedDocument();
    const deliveryId = await seedDelivery();
    await sql`INSERT INTO delivery_sources (delivery_id, source_document_id)
      VALUES (${deliveryId}, ${docId})`;
    const [d] = await sql<{ display_id: number }[]>`
      SELECT display_id FROM deliveries WHERE id = ${deliveryId}`;

    const trace = await operationTrace(db as never, docId, [itemId]);
    expect(trace).toBe(`документ привязан к приёмке #${d!.display_id}`);
  });

  it('строки, перенесённые в приёмку, видны даже без привязки документа', async () => {
    // Ровно состояние после unlink-source: delivery_sources пуст, а позиция
    // приёмки по-прежнему помнит строку документа. Прежняя проверка сочла бы
    // документ свободным и удалила строку, обнулив происхождение позиции.
    const { docId, itemId } = await seedDocument();
    const deliveryId = await seedDelivery();
    await sql`INSERT INTO delivery_items
        (delivery_id, name_raw, qty_actual, unit, line_no, source_document_id, source_document_item_id)
      VALUES (${deliveryId}, 'Кабель ВВГнг 3х1,5', 100, 'м', 1, NULL, ${itemId})`;
    const [d] = await sql<{ display_id: number }[]>`
      SELECT display_id FROM deliveries WHERE id = ${deliveryId}`;

    const trace = await operationTrace(db as never, docId, [itemId]);
    expect(trace).toBe(`строки документа уже перенесены в приёмку #${d!.display_id}`);
  });

  it('позиция, помнящая только документ, тоже держит его', async () => {
    // Обратный случай: строку документа менеджер удалил вручную (SET NULL),
    // но позиция приёмки помнит, из какого документа она пришла.
    const { docId, itemId } = await seedDocument();
    const deliveryId = await seedDelivery();
    await sql`INSERT INTO delivery_items
        (delivery_id, name_raw, qty_actual, unit, line_no, source_document_id, source_document_item_id)
      VALUES (${deliveryId}, 'Кабель ВВГнг 3х1,5', 100, 'м', 1, ${docId}, NULL)`;

    expect(await operationTrace(db as never, docId, [itemId])).toContain('перенесены в приёмку');
  });
});
