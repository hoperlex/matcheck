/**
 * Тест-замок на УПД-промпт v13 (миграция 0114) — поле rowNo.
 *
 * Держит главное: номер берётся НАПЕЧАТАННЫЙ, а самостоятельная нумерация
 * запрещена. Без этого запрета проверка целостности списка выродится — свои
 * номера модель всегда проставит подряд, и пропавшая строка снова станет
 * невидимой.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0114_upd_prompt_v13_row_numbers.sql'), 'utf8');
const down = readFileSync(join(migrationsDir, '0114_down.sql'), 'utf8');

describe('0114_upd_prompt_v13_row_numbers', () => {
  it('дословно расширяет v12', () => {
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v12'/i);
    expect(sql).toContain("'default v13'");
    expect(sql).toMatch(/position\(v12\.content in v13\.content\) = 1/);
  });

  it('требует напечатанный номер и запрещает нумеровать заново', () => {
    expect(sql).toContain('rowNo');
    expect(sql).toContain('НАПЕЧАТАННЫЙ в графе 1');
    expect(sql).toContain('Не нумеруй строки заново');
    expect(sql).toContain('rowNo: null');
  });

  it('не активирует новую версию и не трогает активную', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO'), sql.indexOf('FROM "prompts"'));
    expect(insert).toMatch(/\bfalse\b/);
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
    expect(sql).toMatch(/Ожидался ровно один активный промпт «upd»/);
    expect(sql).toMatch(/default v13 не должен становиться активным/);
  });

  it('зарегистрирован и имеет безопасный down', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 114, tag: '0114_upd_prompt_v13_row_numbers' }),
    );
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });
});
