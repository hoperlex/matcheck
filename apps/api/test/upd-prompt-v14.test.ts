/**
 * Тест-замок на УПД-промпт v14 (миграция 0118) — самопроверка граф.
 *
 * Чем эта версия отличается от предыдущих и что здесь на самом деле охраняется.
 * Запреты «qty — это не код ОКЕИ» и «price только из графы 4» есть уже в v13,
 * и модель их нарушает: за 30 дней на бою 39 строк в 23 документах, где в
 * количестве стоит код единицы этой же строки. Значит ценность v14 не в
 * очередном запрете, а в ПРИЗНАКЕ, по которому ошибку видно в собственном
 * ответе: количество совпало с кодом СВОЕЙ единицы. Если этот признак из
 * текста уйдёт, останется дубль v13 — тест это и ловит.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0118_upd_prompt_v14_columns.sql'), 'utf8');
const down = readFileSync(join(migrationsDir, '0118_down.sql'), 'utf8');

describe('0118_upd_prompt_v14_columns', () => {
  it('дословно расширяет v13', () => {
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v13'/i);
    expect(sql).toContain("'default v14'");
    expect(sql).toMatch(/position\(v13\.content in v14\.content\) = 1/);
  });

  it('даёт признак съехавших колонок, а не ещё один запрет', () => {
    // Признак работает только в паре «количество ↔ единица ТОЙ ЖЕ строки»:
    // просто «796 — это код ОКЕИ» в v13 уже написано и не помогает.
    expect(sql).toContain('кодом единицы ЭТОЙ ЖЕ строки');
    expect(sql).toContain('qty 796 при unit «шт»');
    expect(sql).toContain('настоящее количество почти всегда оказывается в графе цены');
  });

  it('разбирает число с единицей внутри ячейки количества', () => {
    // Боевой случай № 6583: «52,000 м²» прочитано как цена 52000, а в
    // количество попала единица. Числа при этом самосогласованы, поэтому
    // никакая арифметическая проверка на нашей стороне такое не видит.
    expect(sql).toContain('52,000 м²');
    expect(sql).toContain('количество равно 52');
    expect(sql).toContain('Это НЕ 52000');
  });

  it('запрещает заполнять пустые денежные графы', () => {
    expect(sql).toContain('Пустая графа остаётся пустой');
    expect(sql).toContain('price: null');
    expect(sql).toContain('sum: null');
    // Документ без цен обязан оставаться законным: иначе модель начнёт
    // «спасать» его выдуманными числами, а инспектор примет груз по ним.
    expect(sql).toContain('законный и обычный документ');
  });

  it('фиксирует дату документа и сырую графу 4', () => {
    expect(sql).toContain('Год не додумывай');
    expect(sql).toContain('Счёт-фактура № … от …');
    expect(sql).toContain('consigneeRaw');
    expect(sql).toContain('«он же»');
  });

  it('просит «Всего наименований» только напечатанное', () => {
    // Иначе itemsCount станет длиной массива items, и проверка полноты списка
    // будет сверять ответ модели сам с собой.
    expect(sql).toContain('itemsCount');
    expect(sql).toContain('Не подставляй сюда длину собственного массива');
    expect(sql).toContain('itemsCount: null');
  });

  it('не активирует новую версию и не трогает активную', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO'), sql.indexOf('FROM "prompts"'));
    expect(insert).toMatch(/\bfalse\b/);
    expect(sql).not.toMatch(/UPDATE\s+"?prompts"?/i);
    expect(sql).toMatch(/Ожидался ровно один активный промпт «upd»/);
    expect(sql).toMatch(/default v14 не должен становиться активным/);
  });

  it('зарегистрирован и имеет безопасный down', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 118, tag: '0118_upd_prompt_v14_columns' }),
    );
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });
});
