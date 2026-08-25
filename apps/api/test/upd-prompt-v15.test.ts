/**
 * Тест-замок на УПД-промпт v15 (миграция 0119) — дробное количество и цена.
 *
 * Что здесь охраняется. A/B v13 против v14 показал, что главный класс ошибок
 * версия не вылечила, а сместила: на скане 1697.pdf (количество 76,032 м³,
 * цена 6 846,72, стоимость без налога 520 569,92) v13 вернула ценой 76032 —
 * количество, прочитанное как целое, — а v14 вернула 520569.92, то есть графу
 * 5. Цену не прочитала ни одна.
 *
 * Отсюда пара правил, и работают они только вместе: прочитав количество в
 * тысячу раз больше, модель обязана куда-то деть настоящую цену — и кладёт
 * туда стоимость строки. Уберите одно — вернётся второй симптом.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0119_upd_prompt_v15_decimal_qty.sql'), 'utf8');
const down = readFileSync(join(migrationsDir, '0119_down.sql'), 'utf8');

describe('0119_upd_prompt_v15_decimal_qty', () => {
  it('дословно расширяет v14', () => {
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v14'/i);
    expect(sql).toContain("'default v15'");
    expect(sql).toMatch(/position\(v14\.content in v15\.content\) = 1/);
  });

  it('запятая в количестве объявлена дробной частью, а не тысячами', () => {
    expect(sql).toContain('76,032 м³» — это 76.032');
    expect(sql).toContain('Разделителем тысяч в российском бланке служит ПРОБЕЛ');
    // Боевой случай № 6583 — тот же почерк на другом бланке.
    expect(sql).toContain('«52,000 м²» — это 52');
  });

  it('цена, равная стоимости строки, названа признаком не той колонки', () => {
    expect(sql).toContain('совпадает со значением графы 5');
    expect(sql).toContain('графы 9');
    // Оговорка про количество = 1 обязательна: без неё правило запрещало бы
    // законный случай, когда цена и стоимость действительно совпадают.
    expect(sql).toContain('количество равно единице');
  });

  it('арифметическая самопроверка сформулирована как действие', () => {
    // Соотношение qty × price ≈ графа 5 упомянуто ещё в v13 как справочное —
    // и не работает. Здесь от модели требуется перечитать графы, а не «учесть».
    expect(sql).toContain('qty × price должно сойтись с графой 5');
    expect(sql).toContain('Перечитай обе');
    expect(sql).toContain('НЕ подгоняй числа');
  });

  it('не активирует новую версию и не трогает активную', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO'), sql.indexOf('FROM "prompts"'));
    expect(insert).toMatch(/\bfalse\b/);
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
    expect(sql).toMatch(/Ожидался ровно один активный промпт «upd»/);
    expect(sql).toMatch(/default v15 не должен становиться активным/);
  });

  it('зарегистрирован и имеет безопасный down', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 119, tag: '0119_upd_prompt_v15_decimal_qty' }),
    );
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });
});
