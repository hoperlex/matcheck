/**
 * Эксперимент: помогает ли распознать фото ДРУГИМ путём — на ОДНОМ и том же файле.
 *
 * Зачем. Измерение, из которого вырос вывод «сегментный путь лучше одиночного
 * 68:0», сравнивало РАЗНЫЕ загрузки одного бланка: фото-одиночку с фото в
 * составе пакета. Такое сравнение смешивает путь разбора с качеством снимка, и
 * строить на нём лестницу повторов нельзя. Здесь один и тот же байтовый файл
 * прогоняется обоими путями подряд.
 *
 * Чем пути отличаются НА САМОМ ДЕЛЕ (проверено по коду, не по названиям):
 *   * A `image_vision` — parseUpdVision отправляет исходный JPEG как есть;
 *   * B `segment_vision` — imageToVisionPage ужимает длинную сторону до
 *     TARGET_LONG_EDGE_PX и перекодирует кадр в PNG, а к промпту добавляется
 *     хвост «верни ровно один JSON-объект».
 * Модель, температура и текст промпта у обоих одни и те же. То есть проверяется
 * гипотеза «нормализация кадра помогает», а не «другая модель читает лучше».
 *
 * Что делает. Берёт боевые документы с заранее зафиксированным списком id,
 * скачивает файл и складывает в отчёт всё, что нужно человеку для вердикта:
 * позиции, итог, сходимость строк с итогом и построчную арифметику по каждому
 * пути, плюс то, что получилось в бою, и ПУСТОЕ поле verdict.
 *
 * Чего НЕ делает:
 *   * не пишет в source_documents и source_document_items — ни строки;
 *   * не ставит заданий и не трогает статусы;
 *   * не решает, кто победил: метрика в отчёте своя, независимая от
 *     chooseBetterUpdResult, — иначе эксперимент проверял бы сам себя.
 *
 * Записи в llm_calls появятся: их пишут сами парсеры. Чтобы вызовы не смешались
 * с историей боевых документов, sourceDocumentId передаётся null, а сегментный
 * путь помечен bundle=path-ab.
 *
 * Запуск на сервере (локально нет ни БД, ни ключа провайдера):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/retry-reports:/reports \
 *     matcheck-api node_modules/.bin/tsx scripts/path-ab-experiment.ts \
 *     --offset 0 --limit 5 --delay 5000 --out /reports/path-ab-00.json
 *
 * Окнами по 5 и с паузой: квота провайдера общая с боевым распознаванием и
 * однажды уже исчерпалась. Каждый документ — ДВА вызова модели, то есть окно
 * из пяти документов стоит десяти вызовов.
 */
import { writeReportSafely } from './prompt-ab-lib.js';
import { eq } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { parseUpdVision } from '../src/domain/edo/upd-vision.parser.js';
import { extractUpdSegment } from '../src/domain/edo/upd-segment-extract.js';
import { imageToVisionPage } from '../src/domain/edo/page-render.js';
import { imageMimeOfKey } from '../src/lib/image-kind.js';
import { getObject } from '../src/domain/storage/s3.signer.js';
import { db } from '../src/db/client.js';
import { sourceDocumentItems, sourceDocuments } from '../src/db/schema.js';

/**
 * Выборка зафиксирована ЗАРАНЕЕ и детерминированно.
 *
 * Отбор: parse_mode = 'image_vision', документ за последние 30 дней, есть файл
 * в хранилище. Внутри класса взяты первые по возрастанию id — список
 * воспроизводим и не подстроен под результат.
 *
 * Классы получены не по коду ошибки, а по тому, ЧТО модель ответила в
 * llm_calls.response_raw: «нет позиций» оказалось не одним дефектом, а тремя
 * разными случаями (30 документов за месяц).
 *
 *   empty        — ответ пуст целиком, все поля null (18 за месяц);
 *   header_only  — реквизиты прочитаны, позиций нет (8);
 *   sum_mismatch — позиции есть, но их сумма расходится с итогом (14).
 *
 * Четвёртый класс — «модель объяснила, что это не УПД» (4 за месяц: карточка
 * СТС, паспорт) — в выборку НЕ включён: ноль позиций там правильный ответ, и
 * второй путь только сожжёт квоту. Исключение сделано по ответу модели, а не по
 * имени файла: имя — это подгонка выборки, ответ — факт.
 *
 * Пометка `pricing: absent` отдельным классом НЕ является, хотя выглядит как
 * он: у 10 из 18 пустых ответов она стоит вместе со всеми null и confidence 0,
 * то есть означает «цен нет, потому что нет ничего». Нормализация
 * normalizeUpdNoPricingTotals такие ответы и не трогает — она требует
 * непустого items.
 *
 * Снимок `паспорт.jpeg` оставлен в выборке намеренно, как контроль: если путь B
 * «найдёт» на нём позиции, это галлюцинация, и такой результат важнее любого
 * выигрыша в других строках.
 */
const SAMPLE: Array<{ id: string; klass: string; s3Key: string }> = [
  { id: '17cdf4a3-5544-4f5c-81f7-2b09a6bab7ad', klass: 'empty', s3Key: '13/unknown/source-documents/3edb19ae-8331-4c8d-9e95-15e164c92896/doc-2-b77ea8ac-a1a0-4ce0-9847-920df856726f.jpg' },
  { id: '2a83b497-c99e-486b-a899-3f234abb4a5c', klass: 'empty', s3Key: 'unknown/unknown/source-documents/1f14e7ff-8f44-46a7-b949-9d89b58b35f8/doc-2-паспорт.jpeg' },
  { id: '3827762a-38f9-4808-9ab7-dded943e00f4', klass: 'empty', s3Key: '33/unknown/source-documents/cafb8265-a2a4-437f-acc4-3575027b7c62/doc-3-IMG_20260819_154310.jpg' },
  { id: '9d9075e9-7da2-4832-b10d-796a5ee4fbee', klass: 'empty', s3Key: '13/unknown/source-documents/6d34eda3-44d8-4956-b851-92caee72b345/doc-2-6f0f3bac-f286-479e-abba-fd19b8adeeae.jpg' },
  { id: 'b71ba4c5-9136-4b51-ac56-62221ed8b40c', klass: 'empty', s3Key: 'unknown/unknown/source-documents/0dc7f531-2241-40e1-be4c-dc4bd6c97ae3/doc-1-IMG20260817095849.jpg' },
  { id: 'cfe24c7c-a606-44ec-9217-4b19d4919fdd', klass: 'empty', s3Key: '2/unknown/source-documents/6ecf1ca9-9743-4d0f-a089-aef6fc7afbd9/doc-1-1787571899675.jpg' },
  { id: 'aa590c70-54a8-4299-867e-49418acc6fe9', klass: 'header_only', s3Key: '13/unknown/source-documents/35020d3b-e96c-4bc7-8bf1-4b00c2cee54b/doc-2-IMG_20260821_112229_286.jpg' },
  { id: 'b92abfd1-340d-4049-9c8b-20b82a555f11', klass: 'header_only', s3Key: 'unknown/unknown/source-documents/66bf4659-be84-4d48-8423-2ef2e2772449/doc-2-IMG_5024.jpeg' },
  { id: 'f2bda529-e813-419f-bc31-a569f43520c8', klass: 'header_only', s3Key: 'unknown/unknown/source-documents/f2c3f89a-41eb-43e2-8d3f-4aee8dc30c7e/doc-1-728b4b35-5f3e-4776-b629-67ea4a5dabd7.jpg' },
  { id: '038c9c40-8ec2-499d-9ca8-d69156383fb9', klass: 'empty', s3Key: 'unknown/unknown/source-documents/1c0b4f7a-1fab-4a76-8b0a-4caa3e0ddaa1/doc-1-IMG_0966.jpeg' },
  { id: '1177df7b-77cb-41e2-ae3c-e6f46d4aa606', klass: 'sum_mismatch', s3Key: '14/unknown/source-documents/ba5cf8dc-0262-47e3-838d-ca67e3fbf566/doc-1-62E13F5E-FF8B-4335-99E9-FDD39F20AE35.webp' },
  { id: '203c907d-0179-4f19-9e59-0845ee8d38bf', klass: 'sum_mismatch', s3Key: '33/unknown/source-documents/2acdccef-2efc-4c02-b2d4-a0072da550e3/doc-1-IMG_20260820_085917_271.jpg' },
  { id: '2096acc2-4f7c-41ba-95aa-28f07e7d9b3c', klass: 'sum_mismatch', s3Key: '33/unknown/source-documents/128b7e83-d489-4267-ac47-b4375896f908/doc-1-IMG_20260825_071817_981.jpg' },
  { id: '244ee738-9ff2-4e20-a6ff-ee6781308aa3', klass: 'sum_mismatch', s3Key: '56/unknown/source-documents/0688b996-c092-4cea-b485-065671c26b1f/doc-2-IMG_5180.jpeg' },
  { id: '3d15b5ec-86f3-4dbb-a4ce-31d3e0172e88', klass: 'sum_mismatch', s3Key: '33/unknown/source-documents/51d94207-c1f9-4a98-be56-1a5a5f50cee0/doc-6-IMG_20260815_114149_679.jpg' },
];

/** Мера качества разбора — своя, чтобы не проверять код его же средствами. */
type Measure = {
  items: number;
  docNumber: string | null;
  totalSum: number | null;
  /** Сумма граф 9 по строкам. */
  rowsSum: number | null;
  /** Относительное расхождение строк с итогом, доли единицы. null — не с чем сверять. */
  sumGap: number | null;
  /** Строк, где qty × price не сходится со стоимостью без налога. */
  rowArithBad: number;
  /** Строк без количества либо без суммы — их нечем проверить. */
  rowIncomplete: number;
};

function measure(p: UpdPdfParsed): Measure {
  const items = p.items.length;
  const sums = p.items.map((i) => i.sum).filter((v): v is number => v != null);
  const rowsSum = sums.length === items && items > 0 ? round2(sums.reduce((a, b) => a + b, 0)) : null;
  const total = p.totalSum ?? null;
  const sumGap =
    rowsSum != null && total != null && Math.abs(total) > 0.005
      ? Math.abs(rowsSum - total) / Math.abs(total)
      : null;
  let rowArithBad = 0;
  let rowIncomplete = 0;
  for (const i of p.items) {
    if (i.qty == null || i.price == null || i.sum == null) {
      rowIncomplete += 1;
      continue;
    }
    // Графа 9 = стоимость с налогом, поэтому налог вычитаем. Допуск — копейка
    // на строку плюс процент: округления в бланках встречаются штатно.
    const net = i.sum - (i.vatSum ?? 0);
    if (Math.abs(i.qty * i.price - net) > Math.max(0.02, Math.abs(net) * 0.01)) rowArithBad += 1;
  }
  return { items, docNumber: p.docNumber ?? null, totalSum: total, rowsSum, sumGap, rowArithBad, rowIncomplete };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function argOf(name: string, def: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1]! : def;
}

async function baselineOf(id: string) {
  const [doc] = await db.select().from(sourceDocuments).where(eq(sourceDocuments.id, id)).limit(1);
  if (!doc) return null;
  const items = await db
    .select()
    .from(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, id));
  return {
    parseMode: doc.parseMode,
    status: doc.status,
    parseErrorCode: doc.parseErrorCode,
    docNumber: doc.docNumber,
    totalSum: doc.totalSum == null ? null : Number(doc.totalSum),
    items: items.length,
    originalFilename: doc.originalFilename,
  };
}

async function main() {
  const offset = Number(argOf('offset', '0'));
  const limit = Number(argOf('limit', '5'));
  const delayMs = Number(argOf('delay', '5000'));
  const out = argOf('out', 'path-ab.json');
  const window = SAMPLE.slice(offset, offset + limit);
  const log = (line: string) => process.stdout.write(`${line}\n`);

  log(`окно: ${offset}..${offset + window.length - 1} из ${SAMPLE.length}, вызовов модели: ${window.length * 2}`);

  const rows: unknown[] = [];
  for (const [n, item] of window.entries()) {
    const started = Date.now();
    log(`[${offset + n}] ${item.id} (${item.klass})`);
    const row: Record<string, unknown> = {
      id: item.id,
      klass: item.klass,
      s3Key: item.s3Key,
      baseline: await baselineOf(item.id),
      // Заполняет ЧЕЛОВЕК, сверяясь с оригиналом: 'A' | 'B' | 'equal' | 'both_bad'.
      verdict: '',
    };

    let buffer: Buffer;
    try {
      buffer = await getObject(item.s3Key);
    } catch (err) {
      row.error = `s3: ${err instanceof Error ? err.message : String(err)}`;
      rows.push(row);
      continue;
    }
    const mime = imageMimeOfKey(item.s3Key);
    if (!mime) {
      row.error = `не изображение: ${item.s3Key}`;
      rows.push(row);
      continue;
    }
    row.bytes = buffer.length;

    // A — боевой одиночный путь, файл уходит как есть.
    try {
      const a = await parseUpdVision(
        { buffer, mimeType: mime, filename: item.s3Key },
        { sourceDocumentId: null },
      );
      row.A = measure(a.parsed);
    } catch (err) {
      row.A = { error: err instanceof Error ? err.message : String(err) };
    }

    await sleep(delayMs);

    // B — сегментный путь: тот же кадр, но нормализованный и с хвостом промпта.
    try {
      const page = await imageToVisionPage(buffer);
      row.pngBytes = page.length;
      const b = await extractUpdSegment([page], {
        sourceDocumentId: null,
        bundleId: 'path-ab',
        segmentIndex: 0,
      });
      row.B = measure(b.parsed);
    } catch (err) {
      row.B = { error: err instanceof Error ? err.message : String(err) };
    }

    row.elapsedMs = Date.now() - started;
    rows.push(row);
    log(`    A=${JSON.stringify(row.A)}`);
    log(`    B=${JSON.stringify(row.B)}`);
    if (n < window.length - 1) await sleep(delayMs);
  }

  await writeReportSafely(out, { generatedAt: new Date().toISOString(), offset, limit, rows }, log);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
