/**
 * Прогон миграции 0098 на настоящем PostgreSQL.
 *
 * Тест-замок (m15-prompt-v2.test.ts) читает SQL как текст и ловит правки в
 * структуре миграции. Здесь проверяется то, что текстом не проверить: какой
 * контент реально получится в БД после replace() и сработает ли DO $$-гейт,
 * если якорь разойдётся с промптом v1.
 *
 * Всё выполняется внутри транзакции с принудительным откатом — БД остаётся в
 * прежнем состоянии.
 *
 * Запуск: см. заголовок test/integration/upload-documents-characterization.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;
const sql = TEST_DATABASE_URL ? postgres(TEST_DATABASE_URL, { max: 2 }) : null;

const ANCHOR = '- recipient:  { inn, kpp, name } — «Кому» / организация-получатель.';

/** Сигнал принудительного отката: транзакция обязана откатиться всегда. */
class Rollback extends Error {}

suite('миграция 0098: промпт m15 v2 (реальный PostgreSQL)', () => {
  const db = sql!;

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  async function migrationSql(): Promise<string> {
    const raw = await readFile(
      new URL('../../src/db/migrations/0098_m15_prompt_v2.sql', import.meta.url),
      'utf8',
    );
    // Drizzle исполняет части, разделённые маркером, по отдельности.
    return raw;
  }

  /**
   * Выполняет тело внутри транзакции и откатывает её.
   *
   * Перед прогоном удаляет уже существующий «m15 / default v2»: тестовая БД
   * поднимается прогоном миграций, то есть 0098 к этому моменту УЖЕ применена.
   * Без удаления гейт увидел бы две версии и упал бы на ровном месте — не
   * потому, что миграция плохая.
   */
  async function inRolledBackTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let result!: T;
    try {
      await db.begin(async (tx) => {
        await tx`DELETE FROM prompts WHERE doc_kind = 'm15' AND name = 'default v2'`;
        result = await fn(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return result;
  }

  it('v2 = v1 с одной вставленной строкой сразу после якоря', async () => {
    const migration = await migrationSql();

    const content = await inRolledBackTx(async (tx) => {
      const [v1] = await tx<{ content: string }[]>`
        SELECT content FROM prompts WHERE doc_kind = 'm15' AND name = 'default v1'`;
      expect(v1).toBeTruthy();

      await tx.unsafe(migration);

      const [v2] = await tx<{ content: string; is_active: boolean }[]>`
        SELECT content, is_active FROM prompts WHERE doc_kind = 'm15' AND name = 'default v2'`;
      expect(v2).toBeTruthy();
      expect(v2!.is_active).toBe(false);

      // v1 остаётся активным: миграция ничего не переключает.
      const [active] = await tx<{ name: string }[]>`
        SELECT name FROM prompts WHERE doc_kind = 'm15' AND is_active = true`;
      expect(active!.name).toBe('default v1');

      return { v1: v1!.content, v2: v2!.content };
    });

    // Ключевая проверка. Строка вставляется СРАЗУ ЗА ЯКОРЕМ, а не в конец
    // текста, поэтому ожидание — replace(), а не конкатенация: v1 + '\n' + line
    // дало бы совсем другой документ.
    const inserted = content.v2.slice(
      content.v2.indexOf(ANCHOR) + ANCHOR.length,
      content.v2.indexOf('\n', content.v2.indexOf(ANCHOR) + ANCHOR.length + 1),
    );
    expect(content.v2).toBe(content.v1.replace(ANCHOR, `${ANCHOR}\n${inserted.trim()}`));
    expect(inserted).toContain('- consignee:');
    // Ровно одна лишняя строка — остальной промпт бит-в-бит тот же.
    expect(content.v2.split('\n').length).toBe(content.v1.split('\n').length + 1);
  });

  it('гейт валит миграцию, если якорная строка не совпала', async () => {
    const migration = await migrationSql();

    await expect(
      inRolledBackTx(async (tx) => {
        // Портим якорь у v1 — ровно то, что случится, если промпт поправят
        // руками через админку, а миграцию выкатят следом.
        await tx`UPDATE prompts
                    SET content = replace(content, ${ANCHOR}, '- recipient: организация-получатель.')
                  WHERE doc_kind = 'm15' AND name = 'default v1'`;
        await tx.unsafe(migration);
      }),
    ).rejects.toThrow(/consignee|default v2/i);
  });

  it('гейт валит миграцию, если промпта v1 нет вовсе', async () => {
    const migration = await migrationSql();

    await expect(
      inRolledBackTx(async (tx) => {
        // FK на prompts нет, но llm_calls ссылается на prompt_id — чистим и их.
        await tx`DELETE FROM llm_calls WHERE prompt_id IN (
                   SELECT id FROM prompts WHERE doc_kind = 'm15')`;
        await tx`DELETE FROM prompts WHERE doc_kind = 'm15'`;
        await tx.unsafe(migration);
      }),
    ).rejects.toThrow(/default v2|найдено 0/i);
  });
});
