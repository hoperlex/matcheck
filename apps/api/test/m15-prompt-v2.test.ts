/**
 * Тест-замок на промпт М-15 v2 (миграция 0098).
 *
 * По образцу upd-prompt-v8.test.ts: фиксирует ключевые свойства SQL-миграции,
 * чтобы случайная правка не превратила аддитивную вставку в переписывание
 * промпта.
 *
 * Проверяется ровно то, от чего зависит утверждение «уже распознаваемое не
 * изменится»:
 *   1. текст берётся из v1 через replace() — а не набирается заново;
 *   2. промпт заводится НЕактивным (переключение — отдельное решение);
 *   3. в миграции есть DO $$-гейт, который валит транзакцию при несовпадении
 *      якоря;
 *   4. добавленная строка описывает именно графу «Кому» и запрещает «Через
 *      кого» — иначе в справочник поедут водители.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);

const sql = readFileSync(join(migrationsDir, '0098_m15_prompt_v2.sql'), 'utf-8');
const v1Sql = readFileSync(join(migrationsDir, '0068_m15_prompt.sql'), 'utf-8');

describe('0098_m15_prompt_v2 — миграция промпта накладных', () => {
  it('вставляет новую версию, копируя текст из «default v1» через replace()', () => {
    expect(sql).toMatch(/INSERT INTO "prompts"/i);
    expect(sql).toMatch(/replace\(/i);
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'm15' AND "name" = 'default v1'/i);
    expect(sql).toContain("'default v2'");
  });

  it('промпт заводится НЕактивным', () => {
    // Между INSERT и FROM должен стоять false — это значение is_active.
    const insertBlock = sql.slice(sql.indexOf('INSERT INTO "prompts"'), sql.indexOf('FROM "prompts"'));
    expect(insertBlock).toMatch(/\bfalse\b/);
  });

  it('якорь совпадает со строкой из миграции 0068 дословно', () => {
    // Самая хрупкая часть: если якорь разойдётся с текстом v1 хоть пробелом,
    // replace() ничего не заменит и v2 станет копией v1.
    const anchor = '- recipient:  { inn, kpp, name } — «Кому» / организация-получатель.';
    expect(v1Sql).toContain(anchor);
    expect(sql).toContain(anchor);
  });

  it('содержит DO $$-гейт с проверками количества, consignee и неактивности', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/content LIKE '%consignee%'/);
    expect(sql).toMatch(/is_active = true/);
  });

  it('добавленная строка описывает графу «Кому» и запрещает «Через кого»', () => {
    expect(sql).toContain('- consignee:');
    expect(sql).toContain('«Кому»');
    expect(sql).toContain('НЕ бери «Через кого»');
    // ИНН в М-15 не печатают — модель не должна его выдумывать.
    expect(sql).toMatch(/inn: null/);
  });

  it('добавляется РОВНО одна строка', () => {
    // chr(10) ровно один раз: якорь + перевод строки + новая строка.
    expect(sql.match(/chr\(10\)/g) ?? []).toHaveLength(1);
  });

  it('зарегистрирована в журнале миграций', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf-8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.tag === '0098_m15_prompt_v2');
    expect(entry).toBeTruthy();
    expect(entry!.idx).toBe(98);
  });

  it('есть откат, и он удаляет только неактивный промпт', () => {
    const down = readFileSync(join(migrationsDir, '0098_down.sql'), 'utf-8');
    expect(down).toMatch(/DELETE FROM "prompts"/i);
    expect(down).toContain("'default v2'");
    expect(down).toMatch(/"is_active" = false/);
  });
});
