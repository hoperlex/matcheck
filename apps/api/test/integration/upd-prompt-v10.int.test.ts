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

// Соединение одно на файл, поэтому и закрывается один раз: у каждого suite
// свой afterAll закрыл бы его после первого набора, и второй падал бы с
// CONNECTION_ENDED.
afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

suite('миграция 0101: промпт upd v10 (реальный PostgreSQL)', () => {
  const db = sql!;

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

/**
 * Миграция 0102 на настоящем PostgreSQL: дополнение текста v10.
 *
 * Здесь проверяется то, чего не увидеть чтением SQL: что правка применяется к
 * реальной записи и что защитные условия (неактивен, нет ссылок из llm_calls)
 * действительно останавливают её, когда промпт уже использовали.
 */
suite('миграция 0102: правило об адресе в v10 (реальный PostgreSQL)', () => {
  const db = sql!;

  const ADDRESS_RULE = 'адрес, индекс, город, улицу и дом НЕ включай';
  /** Полный текст правила — им же откатываем 0102 перед проверкой. */
  const ADDRESS_RULE_FULL =
    'В name пиши ТОЛЬКО наименование организации, как в ЕГРЮЛ: адрес, индекс, город, улицу и дом НЕ включай, даже если в графе они напечатаны следом через запятую в той же строке.';

  async function migration102(): Promise<string> {
    return readFile(
      new URL('../../src/db/migrations/0102_upd_prompt_v10_address.sql', import.meta.url),
      'utf8',
    );
  }

  /** Транзакция с принудительным откатом; v10 приводится к редакции 0101. */
  async function inTx<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    let result!: T;
    try {
      await db.begin(async (tx) => {
        // Тестовая БД поднимается прогоном миграций, поэтому 0102 уже применена
        // — откатываем её эффект, чтобы проверять именно применение.
        await tx`UPDATE prompts
                    SET content = replace(content, ${' ' + ADDRESS_RULE_FULL}, '')
                  WHERE doc_kind = 'upd' AND name = 'default v10'`;
        result = await fn(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return result;
  }

  it('добавляет правило об адресе, сохраняя правило о реквизитах', async () => {
    const migration = await migration102();

    const content = await inTx(async (tx) => {
      const [before] = await tx<{ content: string }[]>`
        SELECT content FROM prompts WHERE doc_kind = 'upd' AND name = 'default v10'`;
      expect(before!.content).not.toContain(ADDRESS_RULE);

      await tx.unsafe(migration);

      const [after] = await tx<{ content: string; is_active: boolean }[]>`
        SELECT content, is_active FROM prompts WHERE doc_kind = 'upd' AND name = 'default v10'`;
      return { before: before!.content, after: after!.content, active: after!.is_active };
    });

    expect(content.after).toContain(ADDRESS_RULE);
    // Правило из 0101 на месте — миграция правит ту же строку.
    expect(content.after).toContain('ТОЛЬКО если они напечатаны в самой графе 4');
    // Промпт не активируется правкой текста.
    expect(content.active).toBe(false);
    // Изменилась ровно одна строка.
    const beforeLines = content.before.split('\n');
    const afterLines = content.after.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    expect(afterLines.filter((l, i) => l !== beforeLines[i])).toHaveLength(1);
  });

  it('не трогает промпт, которым уже что-то разобрано', async () => {
    const migration = await migration102();

    // Ошибка Postgres обрывает транзакцию целиком, поэтому проверяем не
    // «состояние после», а сам факт падения: при исключении внутри begin
    // postgres.js откатывает всё, и текст промпта по определению остаётся
    // прежним. Заодно это ближе к бою — там миграция тоже идёт транзакцией.
    await expect(
      db.begin(async (tx) => {
        await tx`UPDATE prompts
                    SET content = replace(content, ${' ' + ADDRESS_RULE_FULL}, '')
                  WHERE doc_kind = 'upd' AND name = 'default v10'`;
        const [v10] = await tx<{ id: string }[]>`
          SELECT id FROM prompts WHERE doc_kind = 'upd' AND name = 'default v10'`;
        // Имитируем «промптом уже разбирали»: одна запись в журнале вызовов.
        // provider_id nullable, заводить провайдера ради этого не нужно —
        // миграцию интересует сам факт ссылки на prompt_id.
        await tx`INSERT INTO llm_calls (prompt_id, doc_kind, model, request_messages, latency_ms)
                 VALUES (${v10!.id}, 'upd', 'test-model', '[]'::jsonb, 1)`;
        await tx.unsafe(migration);
      }),
    ).rejects.toThrow(/уже разобрано/i);

    // Контроль, что откат действительно произошёл: подсунутой записи в журнале
    // нет, а правило об адресе на месте (0102 применена к тестовой БД).
    const [{ content }] = await db<{ content: string }[]>`
      SELECT content FROM prompts WHERE doc_kind = 'upd' AND name = 'default v10'`;
    expect(content).toContain(ADDRESS_RULE);
    const [{ n }] = await db<{ n: string }[]>`
      SELECT count(*)::text AS n FROM llm_calls WHERE model = 'test-model'`;
    expect(Number(n)).toBe(0);
  });
});
