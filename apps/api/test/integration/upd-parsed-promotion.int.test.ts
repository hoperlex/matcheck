/**
 * Документ с номером и списком материалов доходит до статуса «обработано».
 *
 * Проверяется то, что раньше было физически невозможно: ограничение
 * `source_upd_required` требовало при `parsed` номер, дату И сумму, поэтому
 * УПД с распознанным списком, но без шапочной суммы, до инспектора не доезжал
 * никогда — запись просто падала бы на constraint.
 *
 * Здесь же проверяется обратная сторона: неполный список (12 наименований по
 * шапке против 3 распознанных) в `parsed` НЕ проходит — иначе инспектор принял
 * бы поставку как полную.
 *
 * Запуск: см. заголовок sync-consignee.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveUpdParseOutcome } from '../../src/domain/edo/upd-outcome.js';
import { validateUpdTotals } from '../../src/domain/edo/upd-validation.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

suite('перевод УПД в «обработано» (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  const siteId = randomUUID();

  type Item = { qty: number; price: number | null; sum: number | null; vatRate: number | null };

  /** Записывает документ ровно так, как это делает воркер после разбора. */
  async function insertParsed(opts: {
    docNumber: string | null;
    docDate: string | null;
    totalSum: number | null;
    status: 'parsed' | 'needs_resolution';
  }): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO source_documents
        (id, kind, is_technical, direction, origin, status, site_id, parsed_at,
         doc_number, doc_date, total_sum, expected_date)
      VALUES (${id}, 'upd', false, 'inbound', 'manual_pdf', ${opts.status}, ${siteId}, now(),
              ${opts.docNumber}, ${opts.docDate}, ${opts.totalSum}, now())`;
    return id;
  }

  function outcomeFor(items: Item[], docNumber: string | null, totalSum: number | null) {
    const validation = validateUpdTotals({
      totalSum,
      vatSum: null,
      itemsCount: null,
      items,
    });
    return deriveUpdParseOutcome({ items, docNumber, totalSum, confidence: 0.9 }, validation);
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    await sql`INSERT INTO sites (id, code, name)
              VALUES (${siteId}, ${`PRM${Date.now() % 10000}`}, 'Продвижение УПД')`;
    // drizzle тут не нужен — проверяем поведение БД, а не выборок.
    drizzle(sql);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM source_documents WHERE site_id = ${siteId}`;
    await sql`DELETE FROM sites WHERE id = ${siteId}`;
    await sql.end({ timeout: 5 });
  });

  it('«обработано» без суммы и без даты записывается — ограничение пропускает', async () => {
    // До миграции 0107 эта вставка падала бы на source_upd_required.
    const id = await insertParsed({
      docNumber: 'УТ-100',
      docDate: null,
      totalSum: null,
      status: 'parsed',
    });

    const [row] = await sql<{ status: string; doc_date: Date | null; total_sum: string | null }[]>`
      SELECT status, doc_date, total_sum FROM source_documents WHERE id = ${id}`;
    expect(row!.status).toBe('parsed');
    expect(row!.doc_date).toBeNull();
    expect(row!.total_sum).toBeNull();
  });

  it('«обработано» без номера по-прежнему запрещено базой', async () => {
    // Номер — единственный реквизит, без которого документ не опознать; его
    // ограничение стережёт и после ослабления.
    await expect(
      insertParsed({ docNumber: null, docDate: '2026-08-17', totalSum: 100, status: 'parsed' }),
    ).rejects.toThrow(/source_upd_required/);
  });

  it('правило: номер и позиции без суммы → готов, сумма посчитана', () => {
    const out = outcomeFor(
      [
        { qty: 2, price: 100, sum: 240, vatRate: 20 },
        { qty: 1, price: 50, sum: 60, vatRate: 20 },
      ],
      'УТ-101',
      null,
    );

    expect(out.status).toBe('parsed');
    expect(out.totalSum).toBe(300);
    expect(out.totalSumSynthesized).toBe(true);
  });

  it('правило: неполный список не пускается даже с полной шапкой', () => {
    const items: Item[] = [
      { qty: 1, price: 100, sum: 120, vatRate: 20 },
      { qty: 1, price: 100, sum: 120, vatRate: 20 },
      { qty: 1, price: 100, sum: 120, vatRate: 20 },
    ];
    const validation = validateUpdTotals({
      totalSum: 360,
      vatSum: null,
      itemsCount: 12,
      items,
    });
    const out = deriveUpdParseOutcome(
      { items, docNumber: 'УТ-102', totalSum: 360, itemsCount: 12, confidence: 0.95 },
      validation,
    );

    expect(out.status).toBe('needs_resolution');
    expect(out.parseErrorCode).toBe('partial_parse');
  });

  it('документ, переведённый в «обработано», сохраняет пометку о суммах', async () => {
    const out = outcomeFor([{ qty: 1, price: 100, sum: 120, vatRate: 20 }], 'УТ-103', 999);
    expect(out.status).toBe('parsed');
    expect(out.parseErrorCode).toBe('validation_mismatch');

    // И такая пара статуса с кодом ложится в базу: ограничение смотрит только
    // на номер.
    const id = await insertParsed({
      docNumber: 'УТ-103',
      docDate: null,
      totalSum: 999,
      status: 'parsed',
    });
    await sql`UPDATE source_documents SET parse_error_code = 'validation_mismatch' WHERE id = ${id}`;

    const [row] = await sql<{ status: string; parse_error_code: string }[]>`
      SELECT status, parse_error_code FROM source_documents WHERE id = ${id}`;
    expect(row).toMatchObject({ status: 'parsed', parse_error_code: 'validation_mismatch' });
  });
});
