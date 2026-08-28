/**
 * Метка «документ помечен ТЕКУЩИМ выкатом» — основа обратимости выката групп.
 *
 * Зачем набор интеграционный. Правило целиком построено на сравнении времён
 * событий и на `coalesce(..., '-infinity')` для документа, который не
 * откатывали ни разу. Юнит-тест проверял бы форму строки, а не поведение
 * NULL-семантики у настоящей БД.
 *
 * Что защищаем. Выкат ставит метку скрытия, откат возвращает видимость, а
 * второй выкат обязан пометить документ ЗАНОВО. Наивная проверка «событие с
 * таким reason когда-либо было» на втором круге промолчала бы: планшеты не
 * получили бы меток удаления и остались бы с документами, которых по новому
 * правилу видеть не должны.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceDocuments } from '../../src/db/schema.js';
import {
  ROLLBACK_MARKER,
  ROLLOUT_MARKER,
  markedByCurrentRolloutSql,
} from '../../src/domain/sourceDocuments/rollout-markers.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('метка текущего выката (реальный PostgreSQL)', () => {
  let sql_: ReturnType<typeof postgres>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  const siteId = randomUUID();
  const bundleId = randomUUID();

  /** Событие видимости с явным временем: порядок здесь и есть предмет проверки. */
  async function event(docId: string, reason: string, minutesAgo: number, visibility = 'hidden') {
    await sql_`INSERT INTO source_document_visibility_events
        (source_document_id, visibility, site_id, reason, created_at)
      VALUES (${docId}, ${visibility}, ${siteId}, ${reason},
              ${new Date(Date.now() - minutesAgo * 60_000).toISOString()}::timestamptz)`;
  }

  async function doc(id: string) {
    await sql_`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, bundle_id, expected_date)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', 'parsed', ${siteId}, now(),
              'МЕТКА-1', now(), 100, ${bundleId}, now())`;
  }

  async function marked(id: string): Promise<boolean> {
    const [row] = await db
      .select({ v: sql<boolean>`${markedByCurrentRolloutSql()}` })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, id));
    return row.v;
  }

  beforeAll(async () => {
    sql_ = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql_);
    await sql_`INSERT INTO sites (id, code, name)
               VALUES (${siteId}, ${`RBK${Date.now() % 10000}`}, 'Откат меток')`;
    await sql_`INSERT INTO source_bundles
        (id, bundle_hash, direction, site_id, status, kind, assembly_version, active_upload_generation)
      VALUES (${bundleId}, ${randomUUID().replace(/-/g, '')}, 'inbound', ${siteId},
              'parsed', 'mixed', 'legacy', 0)`;
  });

  afterAll(async () => {
    if (!sql_) return;
    await sql_`DELETE FROM source_document_visibility_events WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql_`DELETE FROM source_bundles WHERE id = ${bundleId}`;
    await sql_`DELETE FROM sites WHERE id = ${siteId}`;
    await sql_.end();
  });

  it('без событий документ не помечен', async () => {
    const id = randomUUID();
    await doc(id);
    expect(await marked(id)).toBe(false);
  });

  it('ПОЛНЫЙ ЦИКЛ: выкат → откат → выкат помечает документ снова', async () => {
    // Ровно тот случай, ради которого правило и написано. Проверка «событие
    // когда-либо было» дала бы на третьем шаге false, и планшет не узнал бы,
    // что документ снова скрыт.
    const id = randomUUID();
    await doc(id);

    await event(id, ROLLOUT_MARKER, 30);
    expect(await marked(id)).toBe(true);

    await event(id, ROLLBACK_MARKER, 20, 'visible');
    expect(await marked(id)).toBe(false);

    await event(id, ROLLOUT_MARKER, 10);
    expect(await marked(id)).toBe(true);
  });

  it('откат без последующего выката оставляет документ непомеченным', async () => {
    const id = randomUUID();
    await doc(id);
    await event(id, ROLLOUT_MARKER, 30);
    await event(id, ROLLBACK_MARKER, 5, 'visible');
    expect(await marked(id)).toBe(false);
  });

  it('метка выката СТАРШЕ отката не считается: значим только порядок, не факт', async () => {
    const id = randomUUID();
    await doc(id);
    await event(id, ROLLBACK_MARKER, 10, 'visible');
    await event(id, ROLLOUT_MARKER, 40);
    expect(await marked(id)).toBe(false);
  });

  it('чужие события видимости на метку не влияют', async () => {
    // Обычные переходы пишет recordVisibilityTransitions со своими причинами;
    // спутать их с выкатом нельзя, иначе откат вернул бы на планшет документы,
    // скрытые по совсем другому поводу.
    const id = randomUUID();
    await doc(id);
    await event(id, 'объект документа изменён', 5);
    expect(await marked(id)).toBe(false);
  });

  it('откат соседнего документа не снимает метку с нашего', async () => {
    const mine = randomUUID();
    const other = randomUUID();
    await doc(mine);
    await doc(other);
    await event(mine, ROLLOUT_MARKER, 30);
    await event(other, ROLLBACK_MARKER, 10, 'visible');
    expect(await marked(mine)).toBe(true);
    expect(await marked(other)).toBe(false);
  });
});
