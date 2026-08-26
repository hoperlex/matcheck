/**
 * Тест-замок на УПД-промпт v16 (миграция 0120) — цена из графы 4.
 *
 * Что здесь охраняется, кроме текста правила. v16 наследует v13, а НЕ v15, и
 * это главное утверждение файла. Предыдущая попытка провалилась именно на
 * наследовании: v15 добавила правило про запятую в количестве, хотя в v13 оно
 * уже было и работало —
 *     «Числа без пробелов как разделителей тысяч (12500 вместо „12 500“)»
 *     «Запятая в числах = десятичный разделитель (2,5 → 2.5)»
 * Порядок здесь и решает: сначала убрать пробел, потом читать запятую. Второе
 * указание про ту же графу сломало разбор: на боевом фото УПД № 328
 * «1 140,000» стало количеством 1, а 1 140 000 уехало в цену, при том что v13
 * читала 1140 × 1120 верно и стабильно дважды подряд.
 *
 * Поэтому тест проверяет не только присутствие нужного, но и ОТСУТСТВИЕ
 * лишнего: в добавленной части не должно быть ни слова про формат чисел.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0120_upd_prompt_v16_price_column.sql'), 'utf8');
const down = readFileSync(join(migrationsDir, '0120_down.sql'), 'utf8');

/** Текст, который миграция добавляет к унаследованному промпту. */
const addedText = sql.slice(sql.indexOf("'# Цена берётся"), sql.indexOf('  false\nFROM'));

describe('0120_upd_prompt_v16_price_column', () => {
  it('наследует ИМЕННО v13, а не v14 или v15', () => {
    // Соберись v16 поверх v15 — вместе с ней вернулось бы правило про запятую,
    // на котором разбор и сломался.
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v13'/i);
    expect(sql).toContain("'default v16'");
    expect(sql).toMatch(/position\(v13\.content in v16\.content\) = 1/);
    expect(addedText).not.toContain('default v14');
    expect(addedText).not.toContain('default v15');
  });

  it('правило названо через проверяемый признак, а не через подозрение', () => {
    // «Сверь и перечитай ту же клетку» вместо «подозревай»: у модели должен
    // быть конкретный критерий, иначе она начнёт править верно прочитанное.
    expect(addedText).toContain('умножь количество на цену');
    expect(addedText).toContain('графы 5');
    expect(addedText).toContain('графы 9');
    expect(addedText).toContain('вернись к графе 4');
  });

  it('вычислять цену запрещено явно', () => {
    // Вычисленная цена выглядит достоверно и потому опаснее пустого поля:
    // подогнанное число уже не отличить от прочитанного.
    expect(addedText).toContain('НЕ вычисляй цену делением');
    expect(addedText).toContain('price: null');
  });

  it('в добавленной части НЕТ правил про формат чисел', () => {
    // Ровно то, что сломало v15. Правило живёт в v13 и работает; второе
    // указание про ту же графу конфликтует с первым.
    expect(addedText).not.toContain('76,032');
    expect(addedText).not.toContain('разделител');
    expect(addedText).not.toMatch(/запята/i);
    expect(addedText).not.toContain('дробн');
  });

  it('не содержит формулировки, ломавшей количество, равное единице', () => {
    // «Цена, равная стоимости, — признак не той колонки» ломает законный
    // случай qty = 1: там цена совпадает со стоимостью БЕЗ налога, и это
    // верно. В корпусе таких позиций 17.
    expect(addedText).not.toContain('совпадает со значением графы 5');
    expect(addedText).not.toContain('количество равно единице');
  });

  it('миграция сама себя проверяет и не активирует версию', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO'), sql.indexOf('FROM "prompts"'));
    expect(insert).toMatch(/\bfalse\b/);
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
    expect(sql).toMatch(/не является дословным расширением default v13/);
    expect(sql).toMatch(/именно оно сломало v15/);
    expect(sql).toMatch(/Ожидался ровно один активный промпт «upd»/);
    expect(sql).toMatch(/default v16 не должен становиться активным/);
  });

  it('зарегистрирован и имеет безопасный откат', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 120, tag: '0120_upd_prompt_v16_price_column' }),
    );
    // Откат не трогает активную или уже использованную версию: иначе исчезла
    // бы связь llm_calls с текстом, которым разбирали документы.
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });
});
