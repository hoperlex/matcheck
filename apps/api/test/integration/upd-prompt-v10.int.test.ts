/**
 * Прогон миграции 0101 на настоящем PostgreSQL.
 *
 * Тест-замок (upd-prompt-v10.test.ts) читает SQL как текст. Здесь проверяется
 * то, что текстом не проверить: какой контент реально получится после
 * replace() и — главное — сработает ли гейт, если якорь разойдётся с промптом
 * v9. Именно этот случай прежняя схема гейта (`LIKE '%consignee%'`) пропускала
 * бы молча: слово есть уже в v9, и точная копия прошла бы как успех.
 *
 * Всё выполняется внутри транзакции с принудительным откатом.
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

const ANCHOR =
  '- consignee:  { inn, kpp, name } — грузополучатель (графа 4). ИНН там обычно не печатают — тогда inn: null, а name заполни. Если написано «он же» — это ПОКУПАТЕЛЬ, повтори recipient.';

/** Сигнал принудительного отката: транзакция обязана откатиться всегда. */
class Rollback extends Error {}

suite('миграция 0101: промпт upd v10 (реальный PostgreSQL)', () => {
  const db = sql!;

  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  async function migrationSql(): Promise<string> {
    return readFile(
      new URL('../../src/db/migrations/0101_upd_prompt_v10.sql', import.meta.url),
      'utf8',
    );
  }

  /**
   * Выполняет тело в транзакции и откатывает её.
   *
   * Существующий «upd / default v10» удаляется заранее: тестовая БД поднимается
   * прогоном миграций, то есть 0101 к этому моменту уже применена, и гейт
   * увидел бы две версии — упав не потому, что миграция плохая.
   */
  async function inRolledBackTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let result!: T;
    try {
      await db.begin(async (tx) => {
        await tx`DELETE FROM llm_calls WHERE prompt_id IN (
                   SELECT id FROM prompts WHERE doc_kind = 'upd' AND name = 'default v10')`;
        await tx`DELETE FROM prompts WHERE doc_kind = 'upd' AND name = 'default v10'`;
        result = await fn(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return result;
  }

  it('v10 = v9 с заменённой строкой про графу 4, активным остаётся прежний промпт', async () => {
    const migration = await migrationSql();

    const content = await inRolledBackTx(async (tx) => {
      const [v9] = await tx<{ content: string }[]>`
        SELECT content FROM prompts WHERE doc_kind = 'upd' AND name = 'default v9'`;
      expect(v9).toBeTruthy();

      await tx.unsafe(migration);

      const [v10] = await tx<{ content: string; is_active: boolean }[]>`
        SELECT content, is_active FROM prompts WHERE doc_kind = 'upd' AND name = 'default v10'`;
      expect(v10).toBeTruthy();
      expect(v10!.is_active).toBe(false);

      // Миграция ничего не переключает: активной остаётся та версия, что была.
      const [active] = await tx<{ name: string }[]>`
        SELECT name FROM prompts WHERE doc_kind = 'upd' AND is_active = true`;
      expect(active!.name).not.toBe('default v10');

      return { v9: v9!.content, v10: v10!.content };
    });

    // Заменена ровно одна строка — на её месте, а не в конце текста.
    expect(content.v10).not.toBe(content.v9);
    expect(content.v9).toContain(ANCHOR);
    expect(content.v10).not.toContain(ANCHOR);
    expect(content.v10).toContain('ТОЛЬКО если они напечатаны в самой графе 4');
    expect(content.v10).toContain('Единственное исключение — буквальное «он же»');
    // Число строк не изменилось: строка заменена, а не добавлена.
    expect(content.v10.split('\n').length).toBe(content.v9.split('\n').length);
    // Всё, кроме этой строки, совпадает дословно.
    const v9Lines = content.v9.split('\n');
    const v10Lines = content.v10.split('\n');
    const diff = v9Lines.filter((line, i) => line !== v10Lines[i]);
    expect(diff).toHaveLength(1);
  });

  it('гейт валит миграцию, если якорная строка не совпала', async () => {
    const migration = await migrationSql();

    await expect(
      inRolledBackTx(async (tx) => {
        // Ровно то, что случится, если промпт v9 поправят руками через админку,
        // а миграцию выкатят следом. Прежняя схема гейта этого не заметила бы:
        // слово consignee в тексте осталось, и копия прошла бы как успех.
        await tx`UPDATE prompts
                    SET content = replace(content, ${ANCHOR}, '- consignee: грузополучатель.')
                  WHERE doc_kind = 'upd' AND name = 'default v9'`;
        await tx.unsafe(migration);
      }),
    ).rejects.toThrow(/совпал с «default v9»|default v10/i);
  });

  it('гейт валит миграцию, если промпта v9 нет вовсе', async () => {
    const migration = await migrationSql();

    await expect(
      inRolledBackTx(async (tx) => {
        await tx`DELETE FROM llm_calls WHERE prompt_id IN (
                   SELECT id FROM prompts WHERE doc_kind = 'upd' AND name = 'default v9')`;
        await tx`DELETE FROM prompts WHERE doc_kind = 'upd' AND name = 'default v9'`;
        await tx.unsafe(migration);
      }),
    ).rejects.toThrow(/default v10|найдено 0/i);
  });
});
