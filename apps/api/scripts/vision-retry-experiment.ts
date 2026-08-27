/**
 * Эксперимент: помогает ли ПОВТОР картинки картинкой (vision → vision).
 *
 * Зачем. Механизм второго прохода существует и работает, но включён только для
 * текстового PDF (SECOND_PASS_MODES = {'text'}), то есть все накопленные
 * измерения — про переход text → vision. Про повтор vision → vision данных нет
 * ВООБЩЕ, а именно он предлагается для фотографий, где сидит основной брак:
 * у image_vision 35 % partial_parse против 2,8 % у текстового PDF.
 *
 * Статистику существующих повторов на этот вопрос переносить нельзя ещё и
 * потому, что она смещена: `parse_mode = 'second_pass_vision'` проставляется
 * ТОЛЬКО победителям, а при kept_baseline и vision_failed режим остаётся
 * прежним. То есть «у документов с этим режимом нет дефектов» — свойство
 * выборки, а не меры эффективности.
 *
 * Что делает. Берёт боевые документы с заранее зафиксированным списком id,
 * скачивает исходный файл, повторяет parseUpdVision и складывает в отчёт всё,
 * что нужно человеку для вердикта: строки и заявленное количество до/после,
 * проваленные проверки до/после, номер и итог до/после, решение нынешнего
 * comparator и ПУСТОЕ поле verdict — его заполняет человек, сверяясь с
 * оригиналом.
 *
 * Чего НЕ делает:
 *   * не пишет в source_documents и source_document_items — ни строки;
 *   * не ставит заданий и не трогает статусы;
 *   * не считает решение chooseBetterUpdResult доказательством улучшения —
 *     проверяется как раз корректность этого выбора, поэтому оно лишь колонка
 *     отчёта наравне с остальными.
 *
 * Записи в llm_calls появятся — их пишет сам парсер на каждую попытку. Чтобы
 * экспериментальные вызовы не смешались с историей боевых документов, ctx
 * передаётся с sourceDocumentId: null.
 *
 * Запуск на сервере (локально нет ни БД, ни ключа провайдера):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/retry-reports:/reports \
 *     matcheck-api node_modules/.bin/tsx scripts/vision-retry-experiment.ts \
 *     --offset 0 --limit 5 --delay 5000 --out /reports/retry-00.json
 *
 * Окнами и с паузой — по тем же причинам, что корпусная сверка: квота
 * провайдера общая с боевым распознаванием, и она уже однажды исчерпалась.
 *
 * Каталог отчётов — ВНЕ репозитория. Сборка образа падает на грязном рабочем
 * дереве (apps/api/Dockerfile), и каталог, созданный внутри /srv/matcheck/app,
 * останавливал деплой как неотслеживаемый. В .gitignore на этот случай стоит
 * страховка, но держать артефакты вне дерева исходников правильнее.
 */
import { writeReportSafely } from './prompt-ab-lib.js';
import { eq } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';
import { chooseBetterUpdResult } from '../src/domain/edo/upd-result-compare.js';
import { parseUpdVision } from '../src/domain/edo/upd-vision.parser.js';
import { getObject } from '../src/domain/storage/s3.signer.js';
import { db } from '../src/db/client.js';
import {
  sourceDocumentAttachments,
  sourceDocumentItems,
  sourceDocuments,
} from '../src/db/schema.js';

/**
 * Выборка зафиксирована ЗАРАНЕЕ и детерминированно.
 *
 * Отбор: parse_mode ∈ {image_vision, vision_pdf}, документ за последние 30 дней,
 * есть файл в хранилище, и подтверждён ровно один класс дефекта. Внутри каждой
 * пары «режим × класс» взяты первые по возрастанию id — то есть список
 * воспроизводим и не подстроен под результат.
 *
 * Классы:
 *   no_items   — позиции не извлечены вовсе;
 *   sum_total  — сумма строк расходится с итогом документа более чем на 5 %;
 *   row_arith  — построчная арифметика не сходится (qty × price ≠ sum − vatSum).
 */
const SAMPLE: Array<{ id: string; mode: string; klass: string }> = [
  { id: '000e0c9e-23eb-4237-8e3a-7025be745805', mode: 'image_vision', klass: 'no_items' },
  { id: '038c9c40-8ec2-499d-9ca8-d69156383fb9', mode: 'image_vision', klass: 'no_items' },
  { id: '17cdf4a3-5544-4f5c-81f7-2b09a6bab7ad', mode: 'image_vision', klass: 'no_items' },
  { id: '2a83b497-c99e-486b-a899-3f234abb4a5c', mode: 'image_vision', klass: 'no_items' },
  { id: '2c920bb9-9a3a-4abe-bfed-ec9dc7d73c8b', mode: 'image_vision', klass: 'no_items' },
  { id: '3827762a-38f9-4808-9ab7-dded943e00f4', mode: 'image_vision', klass: 'no_items' },
  { id: '0368d7a0-791e-48e5-9b47-009babf8f931', mode: 'image_vision', klass: 'row_arith' },
  { id: '10ecf873-bf3d-42b4-b79e-dc7e65a85059', mode: 'image_vision', klass: 'row_arith' },
  { id: '1263aa14-3313-4b41-9a1b-42dd25a98286', mode: 'image_vision', klass: 'row_arith' },
  { id: '597647b8-a387-443c-8ff7-ac1abaf1771b', mode: 'image_vision', klass: 'row_arith' },
  { id: '203c907d-0179-4f19-9e59-0845ee8d38bf', mode: 'image_vision', klass: 'sum_total' },
  { id: '2096acc2-4f7c-41ba-95aa-28f07e7d9b3c', mode: 'image_vision', klass: 'sum_total' },
  { id: '244ee738-9ff2-4e20-a6ff-ee6781308aa3', mode: 'image_vision', klass: 'sum_total' },
  { id: '3d15b5ec-86f3-4dbb-a4ce-31d3e0172e88', mode: 'image_vision', klass: 'sum_total' },
  { id: '04b13ca4-4f6e-4cb3-9be8-fe7ab29594a3', mode: 'vision_pdf', klass: 'no_items' },
  { id: '28515612-2b57-4082-8e09-0383ee9c0491', mode: 'vision_pdf', klass: 'no_items' },
  { id: '504b1f6f-52f3-4c82-9837-8e8a420dc9b1', mode: 'vision_pdf', klass: 'no_items' },
  { id: '5b48b389-08f1-4d02-b347-ed3c88401e6a', mode: 'vision_pdf', klass: 'no_items' },
  { id: '48569791-a684-40f1-9ef1-0e149f61eb16', mode: 'vision_pdf', klass: 'row_arith' },
  { id: '5b5a538c-5f09-4079-949b-cccadbcd180f', mode: 'vision_pdf', klass: 'sum_total' },
  { id: '8e407d5a-661b-422f-bcc3-03ac4a6be670', mode: 'vision_pdf', klass: 'sum_total' },
];

/**
 * Порог, установленный ДО запуска.
 *
 * Смысл не в том, чтобы «набрать процент», а в том, чтобы решение принималось
 * по заранее объявленному правилу, а не подгонялось под полученную картинку.
 * Двадцать одного документа хватает на вопрос «жизнеспособна ли идея вообще»;
 * доказательством устойчивой эффективности такой объём не является.
 */
const THRESHOLD = {
  /** Доля улучшений по РУЧНОМУ вердикту, ниже которой включать нечего. */
  minBetterShare: 0.3,
  /** Доля ухудшений, выше которой включать нельзя даже при хорошем среднем. */
  maxWorseShare: 0.1,
};

function argValue(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function argNumber(flag: string, fallback: number): number {
  const raw = argValue(flag);
  if (raw == null) return fallback;
  if (raw.trim() === '') throw new Error(`${flag}: ожидается целое число ≥ 0`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag}: ожидается целое число ≥ 0, получено «${raw}»`);
  return n;
}

/**
 * Покрытие проверок: сколько каждого типа ПРИМЕНИМО к разбору.
 *
 * Без этого числа вывод «стало лучше» недоказуем. Валидатор засчитывает
 * отсутствующее значение успешно пропущенной проверкой: строка без цены не даёт
 * провала `row_qty_price`, пустой итог — провала `sum_total`. Значит разбор,
 * потерявший данные, выглядит в отчёте чище того, что данные сохранил.
 */
function checkCoverage(parsed: UpdPdfParsed): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of validation(parsed).checks) {
    if (c.skipReason != null) continue;
    out[c.name] = (out[c.name] ?? 0) + 1;
  }
  return out;
}

/**
 * Похоже ли, что в документе вообще нет товарной таблицы.
 *
 * В поток УПД попадают сертификаты соответствия и паспорта качества — модель
 * честно не находит в них позиций, и повторять такой документ бессмысленно.
 * Без пометки эти случаи считались бы неудачей повтора наравне с настоящими
 * сбоями распознавания.
 */
function looksWithoutItemsTable(parsed: UpdPdfParsed): boolean {
  return parsed.items.length === 0 && parsed.totalSum == null && parsed.vatSum == null;
}

/** Проваленные проверки — по именам, чтобы отчёт читался без расшифровки. */
function validation(parsed: UpdPdfParsed) {
  return validateUpdTotals({
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    items: parsed.items.map((i) => ({
      rowNo: i.rowNo ?? null,
      qty: i.qty ?? null,
      unit: i.unit ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
    })),
  });
}

function failedChecks(parsed: UpdPdfParsed): string[] {
  return validation(parsed)
    .checks.filter((c) => !c.ok && c.skipReason == null)
    .map((c) => c.name);
}

/**
 * Снимок сохранённого разбора.
 *
 * Заявленное количество позиций (`itemsCount`) в source_documents НЕ хранится:
 * оно оседает в parse_error_details.itemsExpected и только у документов,
 * ушедших в partial_parse. Достаём оттуда — без него нельзя ответить на главный
 * вопрос эксперимента: вернул ли повтор ПОТЕРЯННЫЕ строки или лишь занизил
 * ожидаемое число.
 */
async function loadBaseline(id: string): Promise<{ parsed: UpdPdfParsed; s3Key: string; mime: string } | null> {
  const [doc] = await db.select().from(sourceDocuments).where(eq(sourceDocuments.id, id)).limit(1);
  if (!doc) return null;
  const items = await db
    .select()
    .from(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, id))
    .orderBy(sourceDocumentItems.lineNo);
  const [att] = await db
    .select()
    .from(sourceDocumentAttachments)
    .where(eq(sourceDocumentAttachments.sourceDocumentId, id))
    .limit(1);
  if (!att?.s3Key) return null;

  const num = (v: string | null): number | null => (v == null ? null : Number(v));
  const details = doc.parseErrorDetails as { itemsExpected?: number | null } | null;

  return {
    s3Key: att.s3Key,
    mime: att.mimeType ?? 'application/pdf',
    parsed: {
      docNumber: doc.docNumber,
      docDate: doc.docDate ? doc.docDate.toISOString().slice(0, 10) : null,
      totalSum: num(doc.totalSum),
      vatSum: num(doc.vatSum),
      itemsCount: details?.itemsExpected ?? null,
      confidence: num(doc.llmConfidence),
      supplier: null,
      recipient: null,
      consignee: null,
      items: items.map((i) => ({
        // Номер из ГРАФЫ 1 бланка, а не наш порядковый: колонка row_no для
        // этого и заведена. Подстановка lineNo скрывала потерянные и
        // задвоенные номера — проверка items_sequence работала не на тех
        // данных.
        rowNo: i.rowNo ?? null,
        nameRaw: i.nameRaw,
        qty: num(i.qty),
        unit: i.unit,
        price: num(i.price),
        sum: num(i.sum),
        vatRate: num(i.vatRate),
        vatSum: num(i.vatSum),
        volumeM3: num(i.volumeM3),
        massKg: num(i.massKg),
        volumeConfidence: i.volumeConfidence,
        groupName: i.groupName,
      })),
    } as UpdPdfParsed,
  };
}

async function main(): Promise<void> {
  const offset = argNumber('--offset', 0);
  const limit = argNumber('--limit', SAMPLE.length);
  const delayMs = argNumber('--delay', 0);
  const outPath = argValue('--out');

  const window = SAMPLE.slice(offset, offset + limit);
  if (window.length === 0) {
    console.log(`[retry] окно пусто: всего ${SAMPLE.length} документов, --offset ${offset}`);
    return;
  }
  console.log(`[retry] окно: ${window.length} док. (offset ${offset}), пауза ${delayMs} мс`);
  console.log('[retry] в source_documents НЕ пишем; llm_calls — с sourceDocumentId: null');

  const rows: unknown[] = [];
  for (const [idx, entry] of window.entries()) {
    const base = await loadBaseline(entry.id);
    if (!base) {
      console.log(`  ${offset + idx}: ${entry.id.slice(0, 8)} — нет документа или вложения, пропуск`);
      continue;
    }

    if (delayMs > 0 && idx > 0) await new Promise((r) => setTimeout(r, delayMs));

    let candidate: UpdPdfParsed | null = null;
    let error: string | null = null;
    try {
      const buffer = await getObject(base.s3Key);
      // sourceDocumentId: null — вызовы не должны попасть в историю документа.
      const r = await parseUpdVision(
        { buffer, mimeType: base.mime, filename: base.s3Key },
        { sourceDocumentId: null },
      );
      candidate = r.parsed;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const decision = candidate ? chooseBetterUpdResult(base.parsed, candidate) : null;
    const row = {
      id: entry.id,
      mode: entry.mode,
      klass: entry.klass,
      error,
      before: {
        items: base.parsed.items.length,
        itemsCount: base.parsed.itemsCount,
        docNumber: base.parsed.docNumber,
        totalSum: base.parsed.totalSum,
        failedChecks: failedChecks(base.parsed),
        coverage: checkCoverage(base.parsed),
        looksWithoutItemsTable: looksWithoutItemsTable(base.parsed),
      },
      after: candidate
        ? {
            items: candidate.items.length,
            itemsCount: candidate.itemsCount,
            docNumber: candidate.docNumber,
            totalSum: candidate.totalSum,
            failedChecks: failedChecks(candidate),
            coverage: checkCoverage(candidate),
            looksWithoutItemsTable: looksWithoutItemsTable(candidate),
          }
        : null,
      // Решение НЫНЕШНЕГО comparator — колонка отчёта, а не эталон качества:
      // корректность самого правила и проверяется этим экспериментом.
      comparator: decision ? { winner: decision.winner, reasons: decision.reasons } : null,
      // Заполняет ЧЕЛОВЕК, сверяясь с оригиналом документа.
      verdict: '' as '' | 'better' | 'same' | 'worse' | 'uncertain',
    };
    rows.push(row);

    const a = row.after;
    console.log(
      `  ${offset + idx}: ${entry.id.slice(0, 8)} [${entry.mode}/${entry.klass}] ` +
        (error
          ? `ОШИБКА: ${error}`
          : `строк ${row.before.items}→${a?.items}, itemsCount ${row.before.itemsCount ?? '∅'}→${a?.itemsCount ?? '∅'}, ` +
            `провалено ${row.before.failedChecks.length}→${a?.failedChecks.length}, comparator: ${row.comparator?.winner}`),
    );
  }

  const report = {
    formatVersion: 1 as const,
    startedAt: new Date().toISOString(),
    window: { offset, limit, taken: window.length, sampleTotal: SAMPLE.length },
    threshold: THRESHOLD,
    note:
      'Поле verdict заполняется человеком по оригиналу документа. Решение comparator — ' +
      'справочная колонка: корректность самого правила проверяется этим же экспериментом.',
    rows,
  };

  if (outPath) {
    // Не голый writeFile: прогон уже падал с EACCES ПОСЛЕ того, как все вызовы
    // к модели были потрачены — каталог принадлежал другому пользователю.
    // writeReportSafely уводит отчёт во временный файл и объясняет, что чинить.
    await writeReportSafely(outPath, report, (line) => console.log(`\n[retry] ${line}`));
  }
  const next = offset + window.length;
  if (next < SAMPLE.length) console.log(`[retry] следующее окно: --offset ${next}`);
  else console.log('[retry] выборка пройдена целиком');
  console.log('[retry] дальше: проставить verdict вручную и свести отчёты частей');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
