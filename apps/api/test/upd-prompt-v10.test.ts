/**
 * Тест-замок на УПД-промпт v10 (миграция 0101).
 *
 * Отличие от замка на m15 v2 — в гейте. Там исходник (v1) слова `consignee` не
 * содержал, поэтому его появление доказывало, что replace() сработал. Здесь
 * исходник — сам v9, где это слово уже есть: проверка `LIKE '%consignee%'`
 * прошла бы и на точной копии v9. Поэтому тест следит, чтобы в миграции
 * остались обе настоящие проверки — различие текстов и наличие нового правила.
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

const sql = readFileSync(join(migrationsDir, '0101_upd_prompt_v10.sql'), 'utf-8');
const v9Sql = readFileSync(join(migrationsDir, '0084_upd_prompt_v9.sql'), 'utf-8');

describe('0101_upd_prompt_v10 — миграция промпта УПД', () => {
  it('вставляет новую версию, копируя текст из «default v9» через replace()', () => {
    expect(sql).toMatch(/INSERT INTO "prompts"/i);
    expect(sql).toMatch(/replace\(/i);
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v9'/i);
    expect(sql).toContain("'default v10'");
  });

  it('промпт заводится НЕактивным', () => {
    const insertBlock = sql.slice(sql.indexOf('INSERT INTO "prompts"'), sql.indexOf('FROM "prompts"'));
    expect(insertBlock).toMatch(/\bfalse\b/);
  });

  it('якорь дословно совпадает со строкой, которую добавила миграция 0084', () => {
    // Самое хрупкое место: разойдись якорь с текстом v9 хоть пробелом —
    // replace() ничего не заменит, и v10 станет копией v9.
    const anchor =
      '- consignee:  { inn, kpp, name } — грузополучатель (графа 4). ИНН там обычно не печатают — тогда inn: null, а name заполни. Если написано «он же» — это ПОКУПАТЕЛЬ, повтори recipient.';
    expect(v9Sql).toContain(anchor);
    expect(sql).toContain(anchor);
  });

  it('гейт сравнивает ТЕКСТЫ версий, а не ищет слово consignee', () => {
    // Ключевая проверка этого файла: `LIKE '%consignee%'` здесь ничего не
    // доказывает, потому что слово есть уже в v9.
    expect(sql).toMatch(/v10\.content <> v9\.content/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('гейт проверяет наличие нового правила и неактивность', () => {
    expect(sql).toContain('ТОЛЬКО если они напечатаны в самой графе 4');
    expect(sql).toMatch(/is_active = true/);
  });

  it('новая строка запрещает перенос реквизитов и явно называет исключение «он же»', () => {
    // Без явного исключения новое правило противоречило бы прежнему поведению
    // при «он же», где повтор реквизитов покупателя как раз верен.
    expect(sql).toContain('НЕ переноси реквизиты покупателя или продавца');
    expect(sql).toContain('Единственное исключение — буквальное «он же»');
    expect(sql).toMatch(/inn: null, kpp: null/);
  });

  it('добавляется РОВНО одна строка (правило целиком, без переносов)', () => {
    // chr(10) в этой миграции не нужен вовсе: строка заменяется на строку.
    expect(sql.match(/chr\(10\)/g) ?? []).toHaveLength(0);
  });

  it('зарегистрирована в журнале миграций', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf-8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.tag === '0101_upd_prompt_v10');
    expect(entry).toBeTruthy();
    expect(entry!.idx).toBe(101);
  });

  it('есть откат, и он удаляет только неактивный промпт', () => {
    const down = readFileSync(join(migrationsDir, '0101_down.sql'), 'utf-8');
    expect(down).toMatch(/DELETE FROM "prompts"/i);
    expect(down).toContain("'default v10'");
    expect(down).toMatch(/"is_active" = false/);
  });
});

/**
 * Миграция 0102 — дополнение того же промпта правилом об адресе.
 *
 * Она правит СУЩЕСТВУЮЩУЮ строку, а не заводит новую версию, и это допустимо
 * ровно при двух условиях: промпт неактивен и им ничего не разобрано. Оба
 * условия обязаны проверяться в самой миграции, иначе текст промпта разойдётся
 * с тем, чем реально распознавались документы.
 */
describe('0102_upd_prompt_v10_address — правило об адресе', () => {
  const sql102 = readFileSync(join(migrationsDir, '0102_upd_prompt_v10_address.sql'), 'utf-8');

  it('правит существующий v10, а не создаёт новую версию', () => {
    expect(sql102).toMatch(/UPDATE "prompts"/i);
    expect(sql102).not.toMatch(/INSERT INTO "prompts"/i);
    expect(sql102).toContain("'default v10'");
  });

  it('условие безопасности: промпт неактивен и на него нет ссылок из llm_calls', () => {
    // Без проверки llm_calls мы бы задним числом переписали текст промпта,
    // которым уже что-то распознано, — записи журнала перестали бы
    // соответствовать своему содержимому.
    expect(sql102).toMatch(/"is_active" = false/);
    expect(sql102).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
    expect(sql102).toMatch(/RAISE EXCEPTION/);
  });

  it('гейт требует ОБА правила: и про реквизиты, и про адрес', () => {
    // Миграция переписывает ту же строку, что и 0101, — потерять первое правило
    // при неаккуратной правке легко.
    expect(sql102).toContain('ТОЛЬКО если они напечатаны в самой графе 4');
    expect(sql102).toContain('адрес, индекс, город, улицу и дом НЕ включай');
  });

  it('есть откат, возвращающий текст к редакции 0101', () => {
    const down = readFileSync(join(migrationsDir, '0102_down.sql'), 'utf-8');
    expect(down).toMatch(/UPDATE "prompts"/i);
    expect(down).toMatch(/replace\(/i);
    // Откат тоже не трогает активный или уже использованный промпт.
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });

  it('зарегистрирована в журнале миграций', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf-8')) as {
      entries: { idx: number; tag: string }[];
    };
    const entry = journal.entries.find((e) => e.tag === '0102_upd_prompt_v10_address');
    expect(entry).toBeTruthy();
    expect(entry!.idx).toBe(102);
  });
});
