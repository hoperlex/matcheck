/**
 * Тест-замок на промпт накладных v4 (миграция 0112).
 *
 * По образцу waybill-1t-prompt.test.ts: читает SQL миграции, БД не нужна.
 * Фиксирует ровно те свойства правки, ради которых она делается, и то, что
 * она не отняла у первого прохода уже работающее поведение:
 *
 *   1. v4 заводится ВЫКЛЮЧЕННЫМ и активным остаётся v3 — выкат миграции не
 *      меняет распознавание, включают v4 кнопкой после сверки на корпусе;
 *   2. в тексте есть запрет брать номер из таблицы «Коды» (ОКУД/ОКПО) —
 *      именно он чинит «№ 51160834» вместо «№ 8462»;
 *   3. форма 1-Т названа чужой: её разбирает прицельный промпт 0110;
 *   4. форма 2116 и обёртка {"documents": [...]} на месте — иначе первый
 *      проход перестал бы находить то, что находит сегодня;
 *   5. в миграции есть DO $$-гейт, а рядом лежит откат.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0112_waybill_prompt_v4_codes.sql'), 'utf-8');
const down = readFileSync(join(migrationsDir, '0112_down.sql'), 'utf-8');

describe('0112_waybill_prompt_v4_codes — номер накладной не из таблицы «Коды»', () => {
  it('заводит v4 выключенным и не трогает активный v3', () => {
    expect(sql).toMatch(/INSERT INTO "prompts"/i);
    expect(sql).toContain("'default v4'");
    // Активность нового промпта — последний аргумент INSERT.
    const insertBlock = sql.slice(sql.indexOf('INSERT INTO "prompts"'), sql.indexOf('DO $$'));
    expect(insertBlock).toMatch(/\bfalse\)/);
    expect(insertBlock).not.toMatch(/\btrue\)/);
    // Ни одного UPDATE по прежнему промпту: v3 остаётся ровно таким, как был.
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
  });

  it('гейт требует, чтобы активным остался v3, а v4 был выключен', () => {
    expect(sql).toMatch(/Активным промптом накладных должен остаться «default v3»/);
    expect(sql).toMatch(/«default v4» должен быть выключен/);
  });

  it('запрещает брать номер из ОКУД/ОКПО и разрешает пустой номер', () => {
    expect(sql).toMatch(/НИКОГДА не бери номер из таблицы «Коды»/);
    expect(sql).toMatch(/по ОКПО/);
    expect(sql).toMatch(/Форма по ОКУД/);
    expect(sql).toMatch(/docNumber: null/);
    expect(sql).toMatch(/Догадываться по соседним кодам запрещено/);
  });

  it('называет форму 1-Т чужой, с её признаками', () => {
    expect(sql).toMatch(/1-Т/);
    expect(sql).toContain('0345009');
    expect(sql).toMatch(/ТОВАРНЫЙ РАЗДЕЛ/);
    expect(sql).toMatch(/НЕ выдавай документ как форму 2116/);
  });

  it('сохраняет прежнее поведение первого прохода', () => {
    expect(sql).toContain('"tn_2116"');
    expect(sql).toContain('"os2"');
    // Обёртка ответа — то, ради чего заводилась v3 (миграция 0042).
    expect(sql).toContain('{ "documents": [...] }');
    expect(sql).toContain('ОКУД 0306032');
  });

  it('имеет DO $$-гейт на суть промпта', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/is_active = true/);
  });

  it('откат возвращает активность v3 до удаления v4', () => {
    const activateV3 = down.indexOf("'default v3'");
    const deleteV4 = down.search(/DELETE FROM "prompts"/i);
    expect(activateV3).toBeGreaterThan(-1);
    expect(deleteV4).toBeGreaterThan(activateV3);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
    // Возврат активности v3 — только если активного промпта не осталось:
    // иначе откат при уже включённом v4 дал бы два активных.
    expect(down).toMatch(/p2\."is_active" = true/);
  });

  it('зарегистрирована в журнале миграций', () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf-8'),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((e) => e.tag === '0112_waybill_prompt_v4_codes');
    expect(entry).toBeDefined();
    expect(entry!.idx).toBe(112);
  });
});
