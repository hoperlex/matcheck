/**
 * Тест-замок на промпт формы 1-Т (миграция 0110).
 *
 * По образцу m15-prompt-v2.test.ts: фиксирует свойства миграции, от которых
 * зависит утверждение «первый проход накладных не меняется».
 *
 * Проверяется ровно то, что делает правку безопасной:
 *   1. промпт заводится ОТДЕЛЬНЫМ видом transport_waybill_1t — текст
 *      действующего transport_waybill не читается и не переписывается;
 *   2. он активен: у нового вида нет прежнего поведения, а resolvePrompt без
 *      активной записи бросает ошибку;
 *   3. в миграции есть DO $$-гейт, который валит транзакцию, если промпт
 *      потерял свою суть;
 *   4. промпт требует форму tn_1t и обязан возвращать пустой список для чужих
 *      форм — иначе второй проход начал бы подменять первый.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0110_waybill_1t_prompt.sql'), 'utf-8');
const down = readFileSync(join(migrationsDir, '0110_down.sql'), 'utf-8');

describe('0110_waybill_1t_prompt — промпт товарно-транспортной накладной 1-Т', () => {
  it('заводит ОТДЕЛЬНЫЙ вид промпта, не трогая transport_waybill', () => {
    expect(sql).toMatch(/INSERT INTO "prompts"/i);
    expect(sql).toContain("'transport_waybill_1t'");
    // Ни UPDATE, ни SELECT по действующему промпту: его текст не участвует.
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
    expect(sql).not.toMatch(/FROM\s+"?prompts"?\s+WHERE\s+"?doc_kind"?\s*=\s*'transport_waybill'/i);
  });

  it('промпт заводится активным', () => {
    const insertBlock = sql.slice(
      sql.indexOf('INSERT INTO "prompts"'),
      sql.indexOf('--> statement-breakpoint'),
    );
    expect(insertBlock).toMatch(/\btrue\b/);
  });

  it('требует форму tn_1t и пустой список для чужих документов', () => {
    expect(sql).toContain('"tn_1t"');
    expect(sql).toContain('{"documents": []}');
    expect(sql).toMatch(/счёт на оплату/i);
    expect(sql).toMatch(/сертификат/i);
  });

  it('называет признаки формы 1-Т, а не общие слова про накладную', () => {
    expect(sql).toMatch(/1-Т/);
    expect(sql).toMatch(/0345009/);
    expect(sql).toMatch(/Госкомстата России от 28\.11\.97/);
  });

  it('имеет DO $$-гейт на суть промпта', () => {
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/is_active = true/);
  });

  it('откат удаляет только промпт, которым ещё ничего не разобрано', () => {
    expect(down).toMatch(/DELETE FROM "prompts"/i);
    expect(down).toContain("'transport_waybill_1t'");
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });

  it('зарегистрирована в журнале миграций', () => {
    const journal = JSON.parse(
      readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf-8'),
    ) as { entries: { idx: number; tag: string }[] };
    const entry = journal.entries.find((e) => e.tag === '0110_waybill_1t_prompt');
    expect(entry).toBeDefined();
    expect(entry!.idx).toBe(110);
  });
});
