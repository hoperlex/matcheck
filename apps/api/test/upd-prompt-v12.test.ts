/**
 * Тест-замок на УПД-промпт v12 (миграция 0113).
 *
 * Фиксирует свойства, ради которых версия заводится, и — отдельно — те
 * формулировки, которых в ней быть НЕ должно: «у цены максимум два знака»
 * превратило бы подсказку в правило, по которому модель начала бы менять
 * местами колонки у документов с законной ценой вида 65.4918
 * (price хранится как numeric(18,4)).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0113_upd_prompt_v12_columns.sql'), 'utf8');
const down = readFileSync(join(migrationsDir, '0113_down.sql'), 'utf8');

describe('0113_upd_prompt_v12_columns', () => {
  it('дословно расширяет v11, а не переписывает текст', () => {
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v11'/i);
    expect(sql).toContain("'default v12'");
    expect(sql).toMatch(/position\(v11\.content in v12\.content\) = 1/);
  });

  it('несёт все три правила чтения таблицы', () => {
    expect(sql).toContain('является разметкой заголовка');
    expect(sql).toContain('пока в графе 1 не появился новый номер');
    expect(sql).toContain('qty читается из графы 3, price — из графы 4');
    expect(sql).toContain('Всего наименований');
  });

  it('не запрещает цене иметь больше двух знаков после запятой', () => {
    expect(sql).toContain('цена может иметь более двух знаков');
    expect(sql).not.toMatch(/максимум два знака/i);
    // Служебная строка опознаётся по положению и последовательности номеров;
    // отдельные значения 3 и 4 в товарной строке законны.
    expect(sql).toContain('Отдельные значения 3 или 4 в товарной строке допустимы');
  });

  it('не активирует новую версию и не трогает активную', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO'), sql.indexOf('FROM "prompts"'));
    expect(insert).toMatch(/\bfalse\b/);
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
    // Имя активной версии не фиксируем: её включают вручную, и на стендах она
    // разная. Инвариант — активный ровно один и это не v12.
    expect(sql).toMatch(/Ожидался ровно один активный промпт «upd»/);
    expect(sql).toMatch(/default v12 не должен становиться активным/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('зарегистрирован и имеет безопасный down', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 113, tag: '0113_upd_prompt_v12_columns' }),
    );
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });
});
