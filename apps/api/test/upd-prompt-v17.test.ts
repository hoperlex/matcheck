/**
 * Тест-замок на УПД-промпт v17 (миграция 0121) — цена из графы 4 БЕЗ арифметики.
 *
 * Здесь охраняется не формулировка, а чистота эксперимента. v17 отличается от
 * v16 РОВНО ОДНИМ: из правила убрано требование перемножить количество на цену
 * и сверить результат. Всё остальное — тот же адрес графы, то же наследование
 * от v13.
 *
 * Почему так. На боевом фото УПД № 328 счёт по прогонам сложился недвусмысленно:
 * v13 читает 1140 x 1120 верно 6 раз из 6, v15 ошибается 1 раз из 1, v16 — 2 из
 * 2. Обе сломанные версии портят ровно те два поля, что названы в инструкции
 * «умножь количество на цену», хотя стоимость и НДС читают верно. Правила про
 * запятую в v16 нет вовсе — значит виновата самопроверка, а не формат чисел.
 *
 * Если добавить сюда хоть слово про умножение, эксперимент перестанет отвечать
 * на свой вопрос, а дефект вернётся незамеченным.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0121_upd_prompt_v17_price_no_arithmetic.sql'), 'utf8');
const down = readFileSync(join(migrationsDir, '0121_down.sql'), 'utf8');

/** Текст, который миграция добавляет к унаследованному промпту. */
const addedText = sql.slice(sql.indexOf("'# Цена — это графа 4"), sql.indexOf('  false\nFROM'));

describe('0121_upd_prompt_v17_price_no_arithmetic', () => {
  it('наследует v13 напрямую', () => {
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v13'/i);
    expect(sql).toContain("'default v17'");
    expect(sql).toMatch(/position\(v13\.content in v17\.content\) = 1/);
  });

  it('называет графу 4 и запрещает подставлять графу 9', () => {
    expect(addedText).toContain('ТОЛЬКО из графы 4');
    expect(addedText).toContain('Графа 9');
    expect(addedText).toContain('price: null');
  });

  it('НЕ содержит арифметической самопроверки — в этом весь смысл версии', () => {
    // Единственное отличие от v16. Вернётся сюда «умножь» — вернётся и дефект.
    expect(addedText).not.toMatch(/умнож/i);
    expect(addedText).not.toMatch(/сверь/i);
    expect(addedText).not.toMatch(/сойтись|совпасть/i);
    expect(addedText).not.toContain('Проверь себя');
  });

  it('НЕ содержит правил про формат чисел — этим сломалась v15', () => {
    expect(addedText).not.toContain('76,032');
    expect(addedText).not.toMatch(/запят/i);
    expect(addedText).not.toContain('разделител');
  });

  it('миграция стережёт оба запрета сама', () => {
    // Проверки живут и в SQL: тест защищает файл, а DO-блок — базу, в которую
    // миграцию могли накатить из другой ветки.
    expect(sql).toMatch(/появилась арифметическая самопроверка/);
    expect(sql).toMatch(/появилось правило про формат чисел/);
  });

  it('не активирует версию', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO'), sql.indexOf('FROM "prompts"'));
    expect(insert).toMatch(/\bfalse\b/);
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
    expect(sql).toMatch(/default v17 не должен становиться активным/);
  });

  it('зарегистрирован и имеет безопасный откат', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 121, tag: '0121_upd_prompt_v17_price_no_arithmetic' }),
    );
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });
});
