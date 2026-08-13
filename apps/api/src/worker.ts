/**
 * Отдельный процесс BullMQ-воркера для асинхронного распознавания УПД PDF.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api worker        — продакшн (tsx src/worker.ts)
 *   pnpm --filter @matcheck/api worker:dev    — dev с watch
 *
 * В docker-compose.prod.yml поднимается отдельным контейнером
 * matcheck-worker, чтобы тяжёлые LLM-вызовы не блокировали event-loop API.
 */
import './instrument.js'; // ПЕРВЫМ — Sentry.init до bullmq/postgres/undici
import * as Sentry from '@sentry/node';
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { logger } from './lib/logger.js';
import { db } from './db/client.js';
import {
  counterparties,
  entityDeletions,
  materials,
  s3CleanupOutbox,
  sourceBundles,
  sourceDocuments,
  sourceDocumentItems,
  suppliers,
} from './db/schema.js';
import { sql as drSql } from 'drizzle-orm';
import { matchOrCreateSupplier } from './domain/sourceDocuments/supplierMatcher.js';
import {
  autoAssignContractorFromBuyer,
  manualRecipientSource,
} from './domain/sourceDocuments/resolve-contractor.js';
import {
  buildQueueConnection,
  S3_CLEANUP_QUEUE,
  UPD_PARSE_QUEUE,
  UPD_PARSE_JOB_OPTIONS,
  type S3CleanupJobData,
  type UpdParseJobData,
} from './plugins/queue.js';
import { deleteObject, getObject } from './domain/storage/s3.signer.js';
import {
  parseUpdPdf,
  PdfNoTextError,
  PdfTextGarbageError,
} from './domain/edo/upd-pdf.parser.js';
import {
  parseUpdVision,
  PdfRenderError,
  PdfRenderTimeoutError,
  VisionBudgetExceededError,
  VisionTimeoutError,
} from './domain/edo/upd-vision.parser.js';
import { tryParseUpdBundle } from './domain/edo/upd-bundle.parser.js';
import { tryParseTextUpdBundle } from './domain/edo/upd-text-bundle.parser.js';
import { parseUpdXlsx } from './domain/edo/upd-xlsx.parser.js';
import { convertXlsToXlsxBuffer, XlsConvertError } from './domain/edo/xls-to-xlsx.js';
import {
  convertExcelToPng,
  ExcelConvertError,
  ExcelConvertTimeoutError,
  LibreOfficeNotAvailableError,
} from './domain/edo/excel-to-png.js';

// Минимальная уверенность LLM, при которой запускается дедупликация по
// (supplier_directory_id, doc_number, doc_date). Ниже — пропускаем dedup
// и оставляем документ в needs_resolution+partial_parse: пользователь сам
// решит. Защита от галлюцинаций LLM на плохих сканах: на размытом фото
// модель может «придумать» ИНН/номер/дату, совпасть с чужим УПД, и
// триггерить ложный «Дубликат УПД». Порог 0.6 эмпирически — выше 0.7
// будем терять часть нормально распознанных сканов, ниже 0.5 — будут
// проскакивать галлюцинации (LLM на мусоре часто возвращает ровно 0.5).
const MIN_DEDUP_CONFIDENCE = 0.6;
import {
  parseWaybillBatch,
  type WaybillInputImage,
} from './domain/edo/waybill-batch.parser.js';
import { expandPdfAttachmentsForOpenRouter } from './domain/edo/waybill-pdf.js';
import { getDefaultProviderKind } from './domain/llm/registry.js';
import { cleanupPhotoOrphans } from './domain/jobs/photo-orphan-cleanup.js';
import { validateUpdTotals } from './domain/edo/upd-validation.js';
import { chooseBetterUpdResult, mergeParties } from './domain/edo/upd-result-compare.js';
import { normalizeM15ZeroTotals } from './domain/edo/m15-normalize.js';
import {
  getExcelVisionFallbackReasons,
  mergeExcelStructuralWithVision,
} from './domain/edo/excel-vision-fallback.js';
import { publishSseEvent } from './domain/sse/redis-bridge.js';
import { sourceDocumentAttachments, bundleImportItems } from './db/schema.js';
import { createHash, randomUUID } from 'node:crypto';
import { classifyFile, type FileClassification } from './domain/edo/document-router.js';
import {
  finalizeStaleRegistryItems,
  markSubBundleItemsFailed,
  selectRegistryRows,
} from './domain/sourceDocuments/bundle-import-registry.js';
import { classifyImageKind } from './domain/edo/vision-classifier.js';
import {
  assemblyDispatchKeyOf,
  bundleDispatchKeyOf,
  documentSecondPassKeyOf,
  dispatchKeyOf,
  enqueueJob,
  processJobOutbox,
  segmentDispatchKeyOf,
  OUTBOX_INTERVAL_MS as JOB_OUTBOX_INTERVAL_MS,
} from './domain/jobs/job-outbox.js';
import { loadEnv } from './lib/env.js';
import { bundleSegments, ingestEvents, jobOutbox } from './db/schema.js';
import { classifyPages, type PageClassification } from './domain/edo/upd-page-prefilter.js';
import { imageToPng, renderPdf, toClassifyThumb } from './domain/edo/page-render.js';
import {
  mergeClassificationChunks,
  pageRefsOfSegment,
  planUpdSegments,
  type AssemblyPage,
  type PageRef,
} from './domain/edo/upd-assembly.js';
import { extractUpdSegment } from './domain/edo/upd-segment-extract.js';
import { resolveRootBundle } from './domain/sourceDocuments/bundle-import-registry.js';
import { llmProviders, llmProviderCredentials } from './db/schema.js';
import { buildAad, decryptField } from './domain/auth/crypto.js';
import { repairStuckJobs, STUCK_INTERVAL_MS } from './domain/jobs/stuck-jobs.js';
import type { UpdPdfParsed, WaybillDocument } from '@matcheck/contracts';

// Хелпер: уведомляем подключённых SSE-клиентов о смене статуса УПД через
// Redis Pub/Sub (worker в отдельном процессе, in-process bus API ему
// недоступен). Без него мобила узнавала о готовности новой УПД только
// через 15-минутный periodic sync.
async function notifySourceDocumentUpdated(sourceDocumentId: string): Promise<void> {
  await publishSseEvent({
    type: 'source_document_updated',
    entityId: sourceDocumentId,
    ts: new Date().toISOString(),
  });
}

// 1, не 2: распознавание PDF временно раздувает память (PDF→PNG растры,
// base64-payload, jimp RGBA-битмапы, child-процесс tesseract OSD). При двух
// параллельных тяжёлых PDF суммарный RSS перевалил cgroup-лимит воркера и V8
// падал с «heap out of memory» прямо посреди job → документ зависал в
// processing. Один воркер за раз убирает параллельные native-пики; это
// важнее поднятия mem_limit. Throughput для очереди приёмок некритичен.
const CONCURRENCY = 1;
// Документы, висящие в processing дольше этого времени, считаем «потерянными»
// после краша воркера и возвращаем в очередь при старте.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

async function findOrCreateMaterial(name: string, unit?: string | null): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('material name is empty');
  const existing = await db
    .select({ id: materials.id })
    .from(materials)
    .where(drSql`lower(${materials.name}) = lower(${trimmed})`)
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await db
    .insert(materials)
    .values({ name: trimmed, unit: unit && unit.trim() ? unit.trim() : 'шт' })
    .returning({ id: materials.id });
  if (!created) throw new Error('Failed to create material');
  return created.id;
}

async function findOrCreateCounterparty(
  party: { inn: string; kpp: string | null; name: string },
  role: 'supplier' | 'customer',
): Promise<string> {
  const existing = await db
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(
      and(
        eq(counterparties.inn, party.inn),
        party.kpp ? eq(counterparties.kpp, party.kpp) : drSql`${counterparties.kpp} is null`,
      ),
    )
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [created] = await db
    .insert(counterparties)
    .values({
      inn: party.inn,
      kpp: party.kpp,
      name: party.name,
      isSupplier: role === 'supplier',
      isCustomer: role === 'customer',
    })
    .returning({ id: counterparties.id });
  if (!created) throw new Error('Failed to create counterparty');
  return created.id;
}

/**
 * Чем разобран документ. Нужен, чтобы решать про второй проход: булев
 * `parsedViaVision` для этого не годится — у структурного Excel он тоже false,
 * и слабый .xlsx ушёл бы в vision как PDF.
 */
type ParseMode =
  | 'text'
  | 'text_bundle'
  | 'vision_pdf'
  | 'vision_bundle'
  | 'image_vision'
  | 'excel_structural'
  | 'excel_vision'
  | 'm15_vision'
  | 'second_pass_vision'
  // Логический УПД, собранный из страниц пакета (см. bundle_segments).
  | 'segment_vision';

/**
 * Режимы, для которых имеет смысл второй проход картинкой.
 *
 * Только одиночный текстовый PDF:
 *   * excel_* — у Excel свой vision-fallback внутри ветки, и на проде он даёт
 *     100% (28 из 28 документов разобраны полностью);
 *   * text_bundle / vision_bundle — это агрегат НЕСКОЛЬКИХ УПД из одного файла,
 *     одиночный vision склеил бы их в один документ;
 *   * vision_* и image_vision — картинка уже была, повторять нечем.
 */
const SECOND_PASS_MODES: ReadonlySet<ParseMode> = new Set<ParseMode>(['text']);

/** Слабый результат: документ формально разобран, но пользоваться им нельзя. */
function weakParseReasons(parsed: UpdPdfParsed, hasMismatch: boolean): string[] {
  const reasons: string[] = [];
  if (parsed.items.length === 0) reasons.push('no_items');
  if (parsed.totalSum == null) reasons.push('no_total');
  if (parsed.docNumber == null) reasons.push('no_doc_number');
  if (parsed.docDate == null) reasons.push('no_doc_date');
  if ((parsed.confidence ?? 0) < 0.5) reasons.push('low_confidence');
  if (hasMismatch) reasons.push('validation_mismatch');
  return reasons;
}

/**
 * Заказывает второй проход: пишет состояние документа и задание в ОДНОЙ
 * транзакции через outbox.
 *
 * Почему не «обновить строку, потом queue.add»: между ними есть окно, в котором
 * недоступность Redis оставит документ с пометкой «повтор заказан», но без
 * задания — навсегда. Ровно для этого в проекте есть transactional outbox.
 *
 * Возвращает false, если повтор уже заказывался: `second_pass` заполняется
 * только здесь, поэтому непустое значение = «одна попытка уже была». Без этого
 * документ, который плохо читается обоими путями, гонял бы задания по кругу.
 */
async function queueSecondPass(args: {
  sourceDocumentId: string;
  s3Key: string;
  reasons: string[];
  values: Record<string, unknown>;
}): Promise<boolean> {
  const [current] = await db
    .select({ secondPass: sourceDocuments.secondPass })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, args.sourceDocumentId))
    .limit(1);
  if (!current || current.secondPass != null) return false;

  await db.transaction(async (tx) => {
    await tx
      .update(sourceDocuments)
      .set({
        ...args.values,
        secondPass: {
          state: 'queued',
          mode: 'vision',
          requestedAt: new Date().toISOString(),
          reasons: args.reasons,
        },
      })
      .where(eq(sourceDocuments.id, args.sourceDocumentId));
    await enqueueJob(tx as unknown as typeof db, {
      queue: UPD_PARSE_QUEUE,
      jobName: 'parse',
      payload: { sourceDocumentId: args.sourceDocumentId, s3Key: args.s3Key, pass: 'vision' },
      dedupeKey: documentSecondPassKeyOf(args.sourceDocumentId),
    });
  });
  return true;
}

/** Снимок сохранённого разбора — база сравнения для второго прохода. */
async function loadParsedBaseline(sourceDocumentId: string): Promise<UpdPdfParsed | null> {
  const [doc] = await db
    .select()
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sourceDocumentId))
    .limit(1);
  if (!doc) return null;
  const items = await db
    .select()
    .from(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, sourceDocumentId))
    .orderBy(sourceDocumentItems.lineNo);
  const num = (v: string | null): number | null => (v == null ? null : Number(v));
  return {
    docNumber: doc.docNumber,
    docDate: doc.docDate ? doc.docDate.toISOString().slice(0, 10) : null,
    totalSum: num(doc.totalSum),
    vatSum: num(doc.vatSum),
    itemsCount: null,
    // Стороны восстанавливаем из *_raw: FK может быть пустым (графу 4 печатают
    // без ИНН), а для слияния важны и имя, и ИНН. ИНН здесь не «для полноты»:
    // vision часто возвращает сторону с именем, но без реквизитов, и без него
    // mergeParties нечем было бы дозаполнить победителя (см. mergeParty).
    //
    // Поставщик остаётся null: его сторона нужна не для отображения, а для
    // matchOrCreateSupplier, который на втором проходе отрабатывает заново.
    supplier: null,
    recipient: doc.buyerNameRaw
      ? { inn: doc.buyerInnRaw, kpp: null, name: doc.buyerNameRaw }
      : null,
    consignee: doc.consigneeNameRaw
      ? { inn: doc.consigneeInnRaw, kpp: null, name: doc.consigneeNameRaw }
      : null,
    items: items.map((i) => ({
      nameRaw: i.nameRaw,
      qty: num(i.qty),
      unit: i.unit,
      price: num(i.price),
      sum: num(i.sum),
      vatRate: num(i.vatRate),
      vatSum: num(i.vatSum),
      volumeM3: num(i.volumeM3),
      massKg: num(i.massKg),
      volumeConfidence: (i.volumeConfidence as 'low' | 'medium' | 'high' | null) ?? null,
      groupName: i.groupName,
    })),
    confidence: doc.llmConfidence != null ? Number(doc.llmConfidence) : 0,
  };
}

/**
 * Обработчик задания очереди UPD_PARSE_QUEUE.
 *
 * Экспортируется ради интеграционных тестов границы сохранения (какие поля
 * документа реально оказываются в БД после разбора). В проде вызывается
 * только через BullMQ-воркер, объявленный ниже.
 */
export async function handleJob(job: Job<UpdParseJobData>): Promise<void> {
  // Очередь UPD_PARSE_QUEUE обслуживает три вида job: УПД (sourceDocumentId+s3Key),
  // накладные batch (bundleId) и единый вход (bundleId+mode:'router').
  // См. UpdParseJobData в plugins/queue.ts.
  //
  // Ветка router — ПЕРВАЯ: дискриминатор по полю mode, у старых job его нет,
  // поэтому существующие ветки (waybill / одиночный УПД) не затрагиваются.
  if ('mode' in job.data && job.data.mode === 'router' && job.data.bundleId) {
    const log = logger.child({ bundleId: job.data.bundleId, jobId: job.id, mode: 'router' });
    await handleDocumentRouterJob(job.data.bundleId, log);
    return;
  }
  // Сборка логических УПД. Проверка ОБЯЗАНА стоять раньше общей ветки по
  // bundleId: у дочернего пакета сборки тот же ключ, и без дискриминатора он
  // ушёл бы в waybill-обработчик — тот не нашёл бы накладных и пометил пакет
  // parse_failed.
  if ('mode' in job.data && job.data.mode === 'upd_assembly' && job.data.bundleId) {
    const log = logger.child({
      bundleId: job.data.bundleId,
      jobId: job.id,
      mode: 'upd_assembly',
    });
    await handleUpdAssemblyJob(job.data.bundleId, job.data.generation, log);
    return;
  }
  if ('bundleId' in job.data && job.data.bundleId) {
    const log = logger.child({ bundleId: job.data.bundleId, jobId: job.id });
    await handleWaybillBundleJob(job.data.bundleId, log);
    return;
  }
  // Сегмент сборки: файла у задания нет вовсе — страницы адресует манифест,
  // поэтому проверка payload ниже пропускает его отдельно.
  const segmentJob =
    'segmentId' in job.data && job.data.segmentId && job.data.sourceDocumentId
      ? { segmentId: job.data.segmentId, generation: job.data.generation }
      : null;

  if (!job.data.sourceDocumentId || (!job.data.s3Key && !segmentJob)) {
    logger.warn({ jobId: job.id, data: job.data }, 'unknown job payload — skipping');
    return;
  }
  const sourceDocumentId = job.data.sourceDocumentId;

  // Fencing сегментного задания. Одной проверки поколения мало: откат
  // происходит ВНУТРИ того же поколения, и после него задание, дождавшееся
  // своей очереди, снова прошло бы проверку и переписало бы документ, которого
  // уже нет. Поэтому условий несколько, и достаточно любого несовпадения.
  let segmentContext: SegmentJobContext | null = null;
  if (segmentJob) {
    segmentContext = await loadSegmentContext(sourceDocumentId, segmentJob);
    if (!segmentContext) {
      logger.info(
        { jobId: job.id, segmentId: segmentJob.segmentId },
        'сегмент сборки: задание неактуально — пропускаем',
      );
      return;
    }
  }

  // Для сегмента ключ первого вложения нужен только для логов и сообщений:
  // распознавание идёт по страницам манифеста, а не по файлу.
  const s3Key = job.data.s3Key ?? segmentContext?.firstS3Key ?? '';
  const secondPassJob = 'pass' in job.data && job.data.pass === 'vision';
  const log = logger.child({
    sourceDocumentId,
    jobId: job.id,
    ...(secondPassJob ? { pass: 'vision' } : {}),
  });

  // Второй проход сравнивает свой результат с уже сохранённым, поэтому снимок
  // делается ДО того, как документ уйдёт в processing и начнётся разбор.
  const baseline = secondPassJob ? await loadParsedBaseline(sourceDocumentId) : null;

  // Переводим в processing + считаем attempt. Если кто-то уже удалил
  // документ через DELETE /:id, returning() вернёт пустой массив — выходим.
  const [proc] = await db
    .update(sourceDocuments)
    .set({
      status: 'processing',
      jobAttempts: drSql`${sourceDocuments.jobAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(sourceDocuments.id, sourceDocumentId))
    .returning({ id: sourceDocuments.id, kind: sourceDocuments.kind });
  if (!proc) {
    log.warn('source document is gone — skipping job');
    return;
  }

  // ─── УПД-флоу (kind='upd'/'request') ─────────────────────────────────────
  //
  // У сегмента страниц несколько и лежат они в разных файлах, поэтому «скачать
  // один буфер» здесь неприменимо: страницы готовит loadSegmentPages ниже, по
  // адресам из манифеста.
  let buffer: Buffer = Buffer.alloc(0);
  if (!segmentContext) {
    try {
      buffer = await getObject(s3Key);
    } catch (err) {
      log.error({ err, s3Key }, 's3 getObject failed');
      throw err;
    }
  }

  // Routing по типу файла. s3Key содержит имя «source.{ext}», где ext —
  // pdf / xlsx / jpg / png / webp (см. detectUpdFileFormat в
  // routes/source-documents.ts).
  //
  //   xlsx          → parseUpdXlsx (локальные регулярки, без LLM).
  //   xls (BIFF)    → convertXlsToXlsxBuffer (SheetJS) → parseUpdXlsx.
  //                   ExcelJS не умеет BIFF и падал с "invalid signature
  //                   0xe011cfd0" — пред-конвертация решает это
  //                   без LibreOffice в Docker.
  //   pdf c текстом → parseUpdPdf (pdf-parse → LLM text).
  //   pdf-скан      → parseUpdPdf бросит PdfNoTextError →
  //                   fallback на parseUpdVision (Gemini Vision).
  //   jpg/png/webp  → сразу parseUpdVision.
  //
  // Vision pipeline переиспользует тот же UpdPdfParsedSchema, что и
  // текстовый — на уровне DTO они взаимозаменяемы, контракт
  // SourceDocumentSchema не трогается.
  const isXlsx = /\.xlsx$/i.test(s3Key);
  const isXls = /\.xls$/i.test(s3Key);
  const isImage = /\.(jpe?g|png|webp)$/i.test(s3Key);
  const imageMime = isImage
    ? /\.png$/i.test(s3Key)
      ? 'image/png'
      : /\.webp$/i.test(s3Key)
        ? 'image/webp'
        : 'image/jpeg'
    : null;

  let parsed: UpdPdfParsed;
  let llmProviderId: string | null = null;
  let parsedViaVision = false;
  let parseMode: ParseMode = 'text';
  try {
    if (segmentContext) {
      // Логический УПД, собранный из страниц пакета. Страницы уже отобраны
      // классификатором и лежат в манифесте — ни классифицировать заново, ни
      // угадывать формат файла не нужно.
      const pages = await loadSegmentPages(segmentContext);
      const r = await extractUpdSegment(pages, {
        sourceDocumentId,
        bundleId: segmentContext.rootId,
        segmentIndex: segmentContext.segmentIndex,
      });
      parsed = r.parsed;
      llmProviderId = r.llmProviderId;
      parsedViaVision = true;
      // Отдельный режим, а не image_vision: по нему видно, что документ собран
      // из страниц, и он намеренно НЕ входит в SECOND_PASS_MODES — повторять
      // картинку картинкой нечем.
      parseMode = 'segment_vision';
    } else if (secondPassJob) {
      // Второй проход: сразу картинка, без текстового пути и bundle-попыток —
      // именно они и дали слабый результат на первом заходе.
      const mimeForVision = isImage ? imageMime! : 'application/pdf';
      const r = await parseUpdVision(
        { buffer, mimeType: mimeForVision, filename: s3Key },
        { sourceDocumentId },
      );
      parsed = r.parsed;
      llmProviderId = r.llmProviderId;
      parsedViaVision = true;
      parseMode = 'second_pass_vision';
    } else if ('docKind' in job.data && job.data.docKind === 'm15') {
      // М-15 (накладная на отпуск материалов) — всегда распознаём через vision
      // отдельным m15-промптом: у сканов/фото нет текстового слоя, а у PDF из
      // 1С он часто «битый» (нечитаемые глифы). Тип документа уже задан при
      // создании (transport_waybill → «Накладная»); здесь только извлекаем
      // позиции и реквизиты — дальше та же логика сохранения, что и для УПД,
      // поэтому данные пишутся проверенным путём.
      const mimeForVision = isImage ? imageMime! : 'application/pdf';
      const r = await parseUpdVision(
        { buffer, mimeType: mimeForVision, filename: s3Key },
        { sourceDocumentId, promptDocKind: 'm15' },
      );
      parsed = r.parsed;
      llmProviderId = r.llmProviderId;
      parsedViaVision = true;
      parseMode = 'm15_vision';
    } else if (isXlsx || isXls) {
      // Excel-пайплайн: единый для .xlsx (OOXML) и .xls (BIFF/OLE2).
      // .xls сначала переводим в OOXML-буфер через SheetJS (in-memory,
      // без диска и LibreOffice). Дальше — общая ветка.
      const xlsxBuffer = isXls ? convertXlsToXlsxBuffer(buffer) : buffer;

      // Шаг 1: структурный парсер ExcelJS — быстрый, дешёвый, точный
      // для стандартных шаблонов 1С/Элевел (см. upd-xlsx.parser.ts).
      let structural: UpdPdfParsed | null = null;
      try {
        structural = await parseUpdXlsx(xlsxBuffer);
      } catch (xlsxErr) {
        // ExcelJS падает на странных файлах (нестандартный layout,
        // защищённые workbook'и). Это НЕ повод для internal_error —
        // отправим документ в Vision-fallback на следующем шаге.
        log.warn(
          { err: xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr) },
          'parseUpdXlsx threw — will try Excel→Vision fallback',
        );
        structural = null;
      }

      // Шаг 2: fallback на Vision, если структурный парсер не смог извлечь
      // позиции. Для УПД шапка без строк почти бесполезна: пользователь всё
      // равно получает partial_parse и вручную добивает табличную часть. Это
      // ровно кейс старых .xls / нестандартных 1С-Excel: номер, дата и
      // поставщик находятся, но items=[] из-за плавающей разметки. Поэтому
      // идём в Excel→PNG→Vision не только при полностью пустой шапке, а при
      // отсутствии позиций или низкой уверенности.
      // Сильные признаки частичного/сомнительного структурного результата
      // (см. excel-vision-fallback.ts): нет structural / нет позиций / низкая
      // уверенность / суммы не сходятся / НДС должен быть, но пуст / пустая
      // шапка без позиций. Слабые одиночные сигналы Vision НЕ триггерят.
      const fallbackReasons = getExcelVisionFallbackReasons(structural);
      const needsVisionFallback = fallbackReasons.length > 0;

      if (!needsVisionFallback) {
        parsed = structural!;
        parseMode = 'excel_structural';
      } else {
        log.warn(
          {
            isXls,
            reasons: fallbackReasons,
            items: structural?.items.length ?? null,
            confidence: structural?.confidence ?? null,
          },
          'excel structural parse incomplete/invalid — trying vision fallback',
        );
        try {
          const pngPages = await convertExcelToPng(buffer, isXls ? 'xls' : 'xlsx');
          // Берём первую страницу: первый лист Excel почти всегда —
          // шапка + табличка УПД. Симметрия с PDF Vision-fallback
          // (там тоже только первая страница, см. PDF_MAX_PAGES в
          // upd-vision.parser.ts).
          const r = await parseUpdVision(
            { buffer: pngPages[0]!, mimeType: 'image/png', filename: s3Key },
            { sourceDocumentId },
          );
          // Merge: Vision ДОБИРАЕТ только пустые поля шапки, структурные items
          // не затираются (см. mergeExcelStructuralWithVision). При пустом/слабом
          // структурном — берём Vision целиком, как раньше.
          const merged = mergeExcelStructuralWithVision(structural, r.parsed);
          parsed = merged.result;
          if (merged.tookVisionWhole) {
            log.info('vision fallback success — took vision result whole (structural empty/weak)');
          } else {
            log.info(
              { mergedFields: merged.mergedFields },
              'vision fallback success — merged empty header fields into structural (items kept)',
            );
          }
          llmProviderId = r.llmProviderId;
          parsedViaVision = true;
          parseMode = 'excel_vision';
        } catch (fbErr) {
          // LibreOfficeNotAvailableError — фича недоступна, не ошибка.
          // Падаем в partial_parse с понятной подсказкой (не parse_failed):
          // пользователь видит «распознано частично», открывает документ,
          // дополняет вручную. Это лучше, чем «ошибка распознавания».
          if (fbErr instanceof LibreOfficeNotAvailableError) {
            log.warn(
              'LibreOffice not installed — keeping structural empty result as partial_parse',
            );
            // Если у нас был хотя бы structural==null vs «пустой» — берём
            // пустой шаблон, чтобы дальнейший pipeline (валидация/dedup)
            // не упал на null'ах.
            parsed = structural ?? emptyParsed();
            parseMode = 'excel_structural';
          } else if (
            fbErr instanceof ExcelConvertError ||
            fbErr instanceof ExcelConvertTimeoutError
          ) {
            // Реальная ошибка конвертации (битый файл / soffice упал).
            // Пробрасываем во внешний catch — он переведёт в parse_failed
            // с понятной причиной без BullMQ retry.
            throw fbErr;
          } else {
            // Vision LLM упал (timeout / budget / провайдер не отвечает).
            // VisionTimeoutError / VisionBudgetExceededError обрабатываются
            // во внешнем catch (там уже есть fail-fast).
            throw fbErr;
          }
        }
      }
    } else if (isImage && imageMime) {
      // JPG/PNG/WEBP — сразу Vision (текстового слоя у изображений нет).
      const r = await parseUpdVision(
        { buffer, mimeType: imageMime, filename: s3Key },
        { sourceDocumentId },
      );
      parsed = r.parsed;
      llmProviderId = r.llmProviderId;
      parsedViaVision = true;
      parseMode = 'image_vision';
    } else {
      // PDF — сначала пробуем ТЕКСТОВЫЙ multi-UPD bundle: несколько счёт-фактур
      // с текстовым слоем в одном файле (ЭДО-пачка) → агрегат «N1, N2, …»,
      // объединённые позиции. При null (один уникальный УПД, нет текста, не
      // пакет) идём обычным одиночным text-pipeline ниже БЕЗ изменений.
      let textBundle: Awaited<ReturnType<typeof tryParseTextUpdBundle>> = null;
      try {
        textBundle = await tryParseTextUpdBundle(buffer, { sourceDocumentId });
      } catch (bundleErr) {
        if (
          bundleErr instanceof VisionTimeoutError ||
          bundleErr instanceof VisionBudgetExceededError
        ) {
          throw bundleErr;
        }
        log.warn(
          { bundleErr: bundleErr instanceof Error ? bundleErr.message : String(bundleErr) },
          'text multi-UPD bundle attempt failed — falling back to single text parse',
        );
      }
      if (textBundle) {
        parsed = textBundle.parsed;
        llmProviderId = textBundle.llmProviderId;
        parseMode = 'text_bundle';
        log.info(
          {
            segments: textBundle.segments,
            extracted: textBundle.extracted,
            reasons: textBundle.reasons,
          },
          'text multi-UPD bundle recognized — aggregated into one document',
        );
      } else {
        // PDF — быстрый одиночный text-pipeline.
        try {
          const r = await parseUpdPdf(buffer, { sourceDocumentId });
          parsed = r.parsed;
          llmProviderId = r.llmProviderId;
          if (r.partiesFilledFromText?.length) {
            // Модель промолчала про стороны, хотя они есть в тексте. Документ
            // выглядит разобранным, и без этой записи понять, что стороны
            // пришли не от LLM, можно было бы только сверкой llm_calls с БД.
            log.warn(
              { filled: r.partiesFilledFromText },
              'parties recovered from text — LLM returned empty parties',
            );
          }
          // Расширенный Vision-fallback: text-LLM формально не упал, но
          // вернул полностью пустой результат — нет ни одной позиции, ни
          // номера, ни даты. Это типично для сканов: pdf-parse возвращает
          // 200+ символов OCR-артефактов (порог MIN_TEXT_LENGTH=200 пройден,
          // PdfNoTextError не кидается), LLM получает мусор и не может
          // ничего извлечь. До этого фикса такие документы зависали в
          // partial_parse — теперь повторно пробуем через Vision на
          // оригинальном PDF (Gemini читает картинку напрямую).
          // Дополнительный $0.0005 на этот случай оправдан — иначе тупик.
          const textLlmEmpty =
            parsed.items.length === 0 &&
            parsed.docNumber == null &&
            parsed.docDate == null &&
            parsed.totalSum == null;
          if (textLlmEmpty) {
            log.warn(
              { confidence: parsed.confidence },
              'text-LLM returned empty result — retry via vision',
            );
            try {
              const vr = await parseUpdVision(
                { buffer, mimeType: 'application/pdf', filename: s3Key },
                { sourceDocumentId },
              );
              parsed = vr.parsed;
              llmProviderId = vr.llmProviderId;
              parsedViaVision = true;
              parseMode = 'vision_pdf';
            } catch (visionErr) {
              // VisionTimeoutError / VisionBudgetExceededError — fail-fast:
              // пробрасываем во внешний catch, который пометит parse_failed
              // без BullMQ retry. Оба класса означают, что повтор бесполезен.
              if (
                visionErr instanceof VisionTimeoutError ||
                visionErr instanceof VisionBudgetExceededError
              ) {
                throw visionErr;
              }
              // Прочие ошибки (провайдер не поддерживает PDF / сетевые
              // глюки) — некритично: оставляем text-LLM результат
              // (пустые поля), документ попадёт в partial_parse.
              log.warn(
                { visionErr },
                'text-LLM empty + vision retry failed — keep partial_parse',
              );
            }
          }
        } catch (err) {
          // PdfNoTextError — <200 символов в тексте (чистый скан).
          // PdfTextGarbageError — есть текст 200+, но не похож на УПД
          //   (OCR-артефакты, нет ключевых слов «счёт-фактура»/«ИНН»/...).
          // Обе ошибки обрабатываем одинаково: fallback на Vision LLM
          // по оригинальному PDF (или PNG-страницы, если провайдер
          // openrouter — см. upd-vision.parser.ts).
          if (err instanceof PdfNoTextError || err instanceof PdfTextGarbageError) {
            const isGarbage = err instanceof PdfTextGarbageError;
            log.warn(
              isGarbage
                ? { textLength: err.textLength, reason: err.reason }
                : { textLength: err.textLength },
              isGarbage
                ? 'pdf text looks like OCR garbage — falling back to vision LLM'
                : 'pdf has no text — falling back to vision LLM',
            );
            try {
              // Шаг 3 multi-UPD: сначала пробуем как пакет из НЕСКОЛЬКИХ УПД
              // (один скан = несколько документов одной поставки). Если это не
              // bundle (один УПД / не OpenRouter / prefilter не сработал) —
              // tryParseUpdBundle вернёт null, и идём обычным одиночным vision.
              // Bundle-результат — агрегат: docNumber «487, 488, 489, 490»,
              // объединённые позиции; сохраняется существующей секцией ниже.
              let bundle: Awaited<ReturnType<typeof tryParseUpdBundle>> = null;
              try {
                bundle = await tryParseUpdBundle(buffer, { sourceDocumentId });
              } catch (bundleErr) {
                if (
                  bundleErr instanceof VisionTimeoutError ||
                  bundleErr instanceof VisionBudgetExceededError
                ) {
                  throw bundleErr;
                }
                log.warn(
                  {
                    bundleErr:
                      bundleErr instanceof Error ? bundleErr.message : String(bundleErr),
                  },
                  'multi-UPD bundle attempt failed — falling back to single vision',
                );
                bundle = null;
              }
              if (bundle) {
                parsed = bundle.parsed;
                llmProviderId = bundle.llmProviderId;
                parsedViaVision = true;
                parseMode = 'vision_bundle';
                log.info(
                  { segments: bundle.segments, extracted: bundle.extracted, reasons: bundle.reasons },
                  'multi-UPD bundle recognized — aggregated into one document',
                );
              } else {
                const r = await parseUpdVision(
                  { buffer, mimeType: 'application/pdf', filename: s3Key },
                  { sourceDocumentId },
                );
                parsed = r.parsed;
                llmProviderId = r.llmProviderId;
                parsedViaVision = true;
                parseMode = 'vision_pdf';
              }
            } catch (visionErr) {
              // VisionTimeoutError / VisionBudgetExceededError — fail-fast:
              // пробрасываем во внешний catch (parse_failed без BullMQ retry,
              // понятная причина reason='vision_timeout' или 'vision_budget').
              if (
                visionErr instanceof VisionTimeoutError ||
                visionErr instanceof VisionBudgetExceededError
              ) {
                throw visionErr;
              }
              // Vision тоже не справился (провайдер не поддерживает PDF —
              // например, OpenRouter, или сетевая ошибка). Помечаем
              // parse_failed без retry — на тот же файл retry бесполезен.
              await db
                .update(sourceDocuments)
                .set({
                  status: 'parse_failed',
                  parseErrorCode: 'pdf_no_text',
                  parseErrorDetails: {
                    textLength: err.textLength,
                    visionError:
                      visionErr instanceof Error ? visionErr.message : String(visionErr),
                  },
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(sourceDocuments.id, sourceDocumentId));
              log.warn(
                { visionErr },
                'pdf-no-text + vision fallback failed — marked parse_failed',
              );
              await notifySourceDocumentUpdated(sourceDocumentId);
              return;
            }
          } else if (!secondPassJob) {
            // Любая другая ошибка текстового разбора — например обрыв JSON по
            // лимиту токенов на большом УПД (оба прод-parse_failed были именно
            // такими). Раньше она улетала наверх и документ падал, хотя картинка
            // его читает. Заказываем второй проход и выходим: сам документ
            // остаётся в queued до его выполнения.
            const message = err instanceof Error ? err.message : String(err);
            log.warn({ err: message }, 'text parse failed — queueing vision second pass');
            const queued = await queueSecondPass({
              sourceDocumentId,
              s3Key,
              reasons: ['text_parse_error'],
              values: {
                status: 'queued',
                parseErrorCode: null,
                parseErrorDetails: { textParseError: message },
                updatedAt: new Date(),
              },
            });
            if (queued) return;
            throw err;
          } else {
            throw err;
          }
        }
      }
    }
  } catch (err) {
    // Второй проход упал — сохранённый разбор важнее причины падения. Он уже
    // лежит в БД, и первый проход мог дать пользователю рабочий документ:
    // затирать его статусом parse_failed из-за неудачной попытки улучшить
    // нельзя. Помечаем попытку завершённой и выходим, документ не трогаем.
    if (secondPassJob) {
      const message = err instanceof Error ? err.message : String(err);
      const secondPassState = {
        state: 'done',
        mode: 'vision',
        outcome: 'vision_failed',
        error: message,
        finishedAt: new Date().toISOString(),
      };
      // Baseline пуст только если первый проход упал целиком (текстовый разбор
      // бросил исключение) — тогда документ действительно не разобран, и
      // parse_failed честен. Во всех остальных случаях данные первого прохода
      // остаются как есть: статус, позиции и стороны не трогаем.
      const baselineEmpty =
        baseline == null || (baseline.items.length === 0 && baseline.docNumber == null);
      await db
        .update(sourceDocuments)
        .set(
          baselineEmpty
            ? {
                status: 'parse_failed',
                parseErrorCode: 'parse_failed',
                parseErrorDetails: { reason: 'second_pass_failed', message },
                secondPass: secondPassState,
                processedAt: new Date(),
                updatedAt: new Date(),
              }
            : { secondPass: secondPassState, updatedAt: new Date() },
        )
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn(
        { err: message, baselineEmpty },
        baselineEmpty
          ? 'vision second pass failed and baseline is empty — parse_failed'
          : 'vision second pass failed — baseline kept',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    // VisionTimeoutError — fail-fast: помечаем parse_failed СРАЗУ, без
    // BullMQ retries. По умолчанию queue имеет attempts=3 с exponential
    // backoff 60с, что при VISION_TIMEOUT_MS=180с дало бы пользователю
    // 3+1+3+2+3=12 минут ожидания. После таймаута на тот же payload
    // повторно запрашивать ту же модель бессмысленно — либо она опять
    // не успеет, либо у неё проблема с этим контентом. Пользователь
    // получит понятную ошибку и сможет переключить default-модель в
    // админке или загрузить файл как JPG/PNG (image-flow быстрее).
    // parseErrorCode='pdf_no_text' — переиспользуем существующий код
    // из контрактного enum (vision_timeout не добавляем, чтобы не
    // менять @matcheck/contracts). UI уже умеет показывать pdf_no_text,
    // подробности — в parseErrorDetails.reason='vision_timeout'.
    if (
      err instanceof VisionTimeoutError ||
      err instanceof VisionBudgetExceededError
    ) {
      // Оба класса означают, что повторный запуск Vision на тот же payload
      // бесполезен (per-attempt timeout 180с уже исчерпан, или total budget
      // 240с — даже на retry не хватит). Без этого блока BullMQ сделал бы
      // 3 attempts × VISION_TOTAL_TIMEOUT_MS + backoff ≈ 13 минут.
      // reason='vision_timeout' для per-attempt и 'vision_budget' для
      // total-budget: в админке можно отличить «модель повисла на 180с»
      // от «retry не уложился в общий бюджет».
      const isBudget = err instanceof VisionBudgetExceededError;
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'pdf_no_text',
          parseErrorDetails: {
            reason: isBudget ? 'vision_budget' : 'vision_timeout',
            elapsedMs: err.elapsedMs,
            message: err.message,
          },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn(
        { elapsedMs: err.elapsedMs, reason: isBudget ? 'vision_budget' : 'vision_timeout' },
        'vision fail-fast — marked parse_failed without retry',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    // PdfRenderTimeoutError / PdfRenderError — fail-fast: pdftoppm не
    // справился с подготовкой PDF к Vision-распознаванию (повреждённый
    // PDF, отсутствует poppler-utils, гигантский PDF). Повтор запуска
    // pdftoppm на тот же файл даст тот же результат — BullMQ retry
    // только впустую съест минуты. Помечаем parse_failed сразу с
    // понятным сообщением; пользователь может загрузить страницы как
    // JPG/PNG (image-flow обходит pdftoppm). parseErrorCode='pdf_no_text'
    // переиспользуем, чтобы не менять контрактный enum; конкретная
    // причина — в parseErrorDetails.reason.
    // XlsConvertError — .xls (BIFF) не удалось прочитать SheetJS'ом:
    // повреждённый файл, нестандартная разновидность BIFF, пустой
    // workbook. Повтор той же конвертации того же payload бесполезен,
    // ретраить не имеет смысла. Помечаем parse_failed с понятной
    // причиной — пользователю показываем «пересохраните как .xlsx»,
    // в админке reason='xls_convert_failed' для отладки.
    // parseErrorCode='parse_failed' — обычный код, используем именно
    // его (не internal_error), чтобы UI показал стандартный alert
    // вместо «технической ошибки». Контракт SourceParseErrorCode
    // не меняется.
    if (err instanceof XlsConvertError) {
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'parse_failed',
          parseErrorDetails: {
            reason: 'xls_convert_failed',
            message: err.message,
            userHint:
              'Не удалось прочитать .xls. Пересохраните файл как .xlsx или загрузите PDF/JPG.',
          },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn({ err }, 'xls convert failed — marked parse_failed without retry');
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    // ExcelConvertError / ExcelConvertTimeoutError — LibreOffice/pdftoppm
    // упали при попытке Excel→PNG→Vision fallback (битый файл, soffice
    // повис, exit≠0). Fail-fast без BullMQ retry: повтор той же команды
    // даст тот же результат. parseErrorCode='parse_failed' (общий код,
    // деталь в reason). userHint советует переснять/загрузить PDF.
    if (err instanceof ExcelConvertError || err instanceof ExcelConvertTimeoutError) {
      const isTimeout = err instanceof ExcelConvertTimeoutError;
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'parse_failed',
          parseErrorDetails: {
            reason: isTimeout ? 'excel_render_timeout' : 'excel_render_error',
            ...(isTimeout ? { elapsedMs: err.elapsedMs } : {}),
            message: err.message,
            userHint:
              'Не удалось преобразовать Excel в изображение для распознавания. ' +
              'Попробуйте сохранить файл как PDF или загрузить фото первой страницы.',
          },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn(
        { err, isTimeout },
        'excel→png conversion failed — marked parse_failed without retry',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    if (err instanceof PdfRenderTimeoutError || err instanceof PdfRenderError) {
      const isTimeout = err instanceof PdfRenderTimeoutError;
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'pdf_no_text',
          parseErrorDetails: {
            reason: isTimeout ? 'pdf_render_timeout' : 'pdf_render_error',
            ...(isTimeout ? { elapsedMs: err.elapsedMs } : {}),
            message: err.message,
          },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn(
        { reason: isTimeout ? 'pdf_render_timeout' : 'pdf_render_error', err },
        'pdf→png failed — marked parse_failed without retry',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    log.error({ err }, 'parse failed, will retry');
    throw err;
  }

  // ─── Второй проход: принимаем результат, только если он лучше ─────────────
  //
  // Vision вызывали ради улучшения, но он умеет и ухудшать: выдумать строки,
  // потерять итог, вернуть пустую шапку. Сравниваем с сохранённым разбором по
  // явным критериям (upd-result-compare.ts) и при проигрыше просто закрываем
  // попытку, не трогая документ.
  if (secondPassJob && baseline) {
    const decision = chooseBetterUpdResult(baseline, parsed);
    if (decision.winner === 'base') {
      await db
        .update(sourceDocuments)
        .set({
          secondPass: {
            state: 'done',
            mode: 'vision',
            outcome: 'kept_baseline',
            reasons: decision.reasons,
            finishedAt: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.info({ reasons: decision.reasons }, 'vision second pass worse than baseline — kept');
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    // Победил vision — но стороны берём объединением: активный промпт v8
    // грузополучателя не запрашивает вовсе, и без слияния успешный второй
    // проход стёр бы сторону, добранную из текста на первом заходе.
    parsed = mergeParties(parsed, baseline);
    log.info({ reasons: decision.reasons }, 'vision second pass better than baseline — replacing');
  }

  // Поставщик — сравниваем со справочником `suppliers` (CRUD в Справочниках).
  // Если нашли по ИНН/fuzzy name — возвращается id найденной записи; не нашли
  // — INSERT в справочник (счётчик «Поставщики» вырастает). В counterparties
  // НЕ пишем — поставщики и контрагенты это разные сущности (см. миграцию
  // 0064 и supplierMatcher.ts).
  const supplier = parsed.supplier;
  const supplierMatch =
    supplier && (supplier.inn || supplier.name)
      ? await matchOrCreateSupplier(
          { db },
          { inn: supplier.inn ?? null, kpp: supplier.kpp ?? null, name: supplier.name ?? null },
        )
      : null;
  const supplierDirectoryId = supplierMatch?.id ?? null;

  // Получатель (покупатель) — операционная сущность, остаётся в counterparties.
  const recipient = parsed.recipient;
  const recipientId =
    recipient && recipient.inn && recipient.name
      ? await findOrCreateCounterparty(
          { inn: recipient.inn, kpp: recipient.kpp ?? null, name: recipient.name },
          'customer',
        )
      : null;

  // Стороны САМОГО документа — покупатель (графа 6) и грузополучатель (графа 4).
  //
  // Имя пишем всегда, когда распознали: графу 4 печатают без ИНН, а
  // counterparties.inn NOT NULL — связать такую сторону не с чем, и без
  // *_name_raw она бы просто потерялась. FK — только когда есть и ИНН, и имя.
  //
  // Роль 'customer', а НЕ isContractor: список подрядчиков (фильтр «Подрядчик»,
  // /counterparties?role=contractor, справочник на планшете) должен оставаться
  // тем, что выбирают люди, иначе туда натечёт каждый грузополучатель из УПД.
  const consignee = parsed.consignee;
  const consigneeId =
    consignee && consignee.inn && consignee.name
      ? await findOrCreateCounterparty(
          { inn: consignee.inn, kpp: consignee.kpp ?? null, name: consignee.name },
          'customer',
        )
      : null;
  const documentParties = {
    buyerId: recipientId,
    buyerNameRaw: recipient?.name ?? null,
    consigneeId,
    consigneeNameRaw: consignee?.name ?? null,
    // ИНН пишем сырым, как распознали, — ровно по той же причине, что и имя:
    // сторона без FK (графа 4 без ИНН) иначе осталась бы совсем без реквизитов,
    // а справочную запись потом правят люди, и она перестаёт отвечать на вопрос
    // «что стояло в документе». Нормализацию оставляем читателю.
    supplierInnRaw: supplier?.inn ?? null,
    buyerInnRaw: recipient?.inn ?? null,
    consigneeInnRaw: consignee?.inn ?? null,
  };

  // Проверка дубля. Считаем дублем УПД с тем же (supplier_directory_id,
  // docNumber, docDate), уже принятый или ожидающий разрешения. Свою
  // собственную запись из выборки исключаем. Старый supplier_id (FK на
  // counterparties) больше не участвует в дедупе новых УПД — для них он
  // всегда NULL; исторические УПД продолжают работать по своему индексу.
  //
  // Confidence-guard: dedup запускается только если LLM уверен в
  // распознавании (confidence >= MIN_DEDUP_CONFIDENCE = 0.6). При низкой
  // уверенности — на плохих сканах модель может выдумать ИНН/номер/дату
  // и случайно совпасть с чужим УПД (ложный «Дубликат УПД»). Документ
  // в таком случае всё равно сохраняется, но без dedup — попадает в
  // partial_parse, пользователь может проверить распознанное и дополнить.
  const docDate = parsed.docDate ? new Date(parsed.docDate) : null;
  const confidence = parsed.confidence ?? 0;
  const canDedup = confidence >= MIN_DEDUP_CONFIDENCE;

  // ─── Решение о втором проходе — ДО дедупликации ───────────────────────────
  //
  // Ветка дубля ниже завершается своим UPDATE и возвращается, до конца функции
  // выполнение не доходит. Если оценивать качество после неё, слабо разобранный
  // дубль (у наших двух прод-дублей вообще нет позиций) второго шанса не
  // получит. Поэтому считаем здесь, а ставим задание вместе с записью
  // результата — в одной транзакции, в обеих ветках.
  const preValidation = validateUpdTotals({
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    items: parsed.items.map((i) => ({
      qty: i.qty ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
    })),
  });
  const weakReasons = weakParseReasons(parsed, preValidation.hasMismatch);
  const wantSecondPass =
    !secondPassJob && weakReasons.length > 0 && SECOND_PASS_MODES.has(parseMode);

  let duplicate: { id: string } | null = null;
  if (canDedup && supplierDirectoryId && parsed.docNumber && docDate) {
    const [existing] = await db
      .select({
        id: sourceDocuments.id,
        supplierName: suppliers.name,
      })
      .from(sourceDocuments)
      .leftJoin(suppliers, eq(sourceDocuments.supplierDirectoryId, suppliers.id))
      .where(
        and(
          eq(sourceDocuments.kind, 'upd'),
          eq(sourceDocuments.supplierDirectoryId, supplierDirectoryId),
          eq(sourceDocuments.docNumber, parsed.docNumber),
          eq(sourceDocuments.docDate, docDate),
          inArray(sourceDocuments.status, ['parsed', 'needs_resolution']),
          drSql`${sourceDocuments.id} <> ${sourceDocumentId}`,
        ),
      )
      .limit(1);
    if (existing && segmentContext) {
      // Сегмент сборки. Ветка ниже терминальна: она пишет шапку и выходит ДО
      // сохранения позиций, оставляя пустую карточку. Для собранного документа
      // это неприемлемо — распознавание уже состоялось, и терять его позиции
      // из-за того, что такой же УПД когда-то загружали, нельзя. Дубликат
      // здесь остаётся предупреждением: пометку проставим после сохранения.
      duplicate = { id: existing.id };
      log.warn({ existingId: existing.id }, 'сегмент: дубликат — сохраняем полностью');
    } else if (existing) {
      duplicate = { id: existing.id };
      const duplicateValues = {
        status: 'needs_resolution' as const,
        parseErrorCode: 'duplicate_upd' as const,
        parseErrorDetails: {
          existingId: existing.id,
          supplierName: existing.supplierName,
          docNumber: parsed.docNumber,
          docDate: parsed.docDate,
        },
        // supplier_id оставляем NULL — для новых УПД поставщик теперь
        // живёт в supplier_directory_id (FK на suppliers).
        supplierId: null,
        supplierDirectoryId,
        recipientId,
        // Дубль — тоже распознанный документ, и в списке он виден. Стороны
        // пишем здесь же: этот UPDATE терминальный, до записи шапки ниже
        // выполнение не доходит.
        ...documentParties,
        llmProviderId,
        llmConfidence: parsed.confidence.toString(),
        processedAt: new Date(),
        updatedAt: new Date(),
      };
      // Слабый дубль тоже заслуживает второго прохода: у обоих прод-дублей нет
      // ни одной позиции, и без повтора они так и останутся пустыми карточками.
      const queued = wantSecondPass
        ? await queueSecondPass({
            sourceDocumentId,
            s3Key,
            reasons: weakReasons,
            values: duplicateValues,
          })
        : false;
      if (!queued) {
        await db
          .update(sourceDocuments)
          .set(duplicateValues)
          .where(eq(sourceDocuments.id, sourceDocumentId));
      }
      log.warn(
        { existingId: existing.id, confidence, parsedViaVision, secondPassQueued: queued },
        'duplicate detected — needs_resolution',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
    }
  } else if (!canDedup && supplierDirectoryId && parsed.docNumber && docDate) {
    // Диагностика: distinguishable fields есть, но confidence низкая.
    // Логируем для аудита частоты срабатывания confidence-guard'а.
    log.warn(
      { confidence, parsedViaVision, docNumber: parsed.docNumber },
      'dedup skipped: confidence below MIN_DEDUP_CONFIDENCE',
    );
  }

  // Обычный путь на дубликате заканчивается: шапка записана веткой выше.
  // Сегмент идёт дальше — его результат сохраняется целиком.
  if (duplicate && !segmentContext) return;

  // Толлинг-М-15 без стоимостной части (итог прописью «Ноль»): доопределяем
  // totalSum/vatSum в 0, чтобы документ не падал в partial_parse из-за
  // недетерминизма vision (0 vs null). Для всех прочих документов — no-op.
  // См. m15-normalize.ts.
  parsed = normalizeM15ZeroTotals(parsed, 'docKind' in job.data ? job.data.docKind : undefined);

  // Валидация сумм.
  const validation = validateUpdTotals({
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    items: parsed.items.map((i) => ({
      qty: i.qty,
      price: i.price ?? null,
      sum: i.sum ?? null,
    })),
  });

  const hasMismatch = validation.hasMismatch;
  // Шапка распознана НЕПОЛНО — это нормальный случай для excel-УПД на
  // Шаге 2a (парсер пока не извлекает позиции и totalSum). Также защищает
  // от падения UPDATE на CHECK-constraint source_upd_required, который
  // требует docNumber/docDate/totalSum NOT NULL при status='parsed'.
  // В таком виде документ записывается со статусом needs_resolution —
  // пользователь добавит недостающие поля и позиции через UI.
  const isIncomplete =
    parsed.items.length === 0 ||
    parsed.totalSum == null ||
    parsed.docNumber == null ||
    parsed.docDate == null;
  const status: 'parsed' | 'needs_resolution' =
    hasMismatch || isIncomplete ? 'needs_resolution' : 'parsed';
  // Приоритет: partial_parse важнее validation_mismatch. Если документ
  // распознан частично (нет позиций или итого) — сверка сумм бессмысленна,
  // показывать «суммы не сходятся» вводит пользователя в заблуждение.
  // Семантически правильно сначала добить шапку/позиции, потом проверять
  // суммы — для xlsx Шага 2a это всегда так.
  const parseErrorCode: 'validation_mismatch' | 'partial_parse' | null = isIncomplete
    ? 'partial_parse'
    : hasMismatch
      ? 'validation_mismatch'
      : null;
  // confidence и parsedViaVision в parseErrorDetails — диагностика для
  // UI / администратора (поля опциональные, контракт не меняем).
  // reason='low_confidence' помечает кейс «модель не уверена в распознавании»
  // — будущий UI может показать предупреждение «проверьте качество фото».
  const parseErrorDetails: Record<string, unknown> | null = isIncomplete
    ? {
        missing: [
          parsed.docNumber == null ? 'docNumber' : null,
          parsed.docDate == null ? 'docDate' : null,
          parsed.totalSum == null ? 'totalSum' : null,
          parsed.items.length === 0 ? 'items' : null,
        ].filter(Boolean) as string[],
        confidence,
        parsedViaVision,
        reason: confidence < MIN_DEDUP_CONFIDENCE ? 'low_confidence' : null,
      }
    : hasMismatch
      ? {
          failedChecks: validation.checks
            .filter((c) => !c.ok)
            .map((c) => ({
              name: c.name,
              scope: c.scope,
              expected: c.expected,
              actual: c.actual,
              diff: c.diff,
            })),
        }
      : null;

  // Запись шапки. Для новых распознанных УПД поставщик живёт в
  // supplier_directory_id (FK на suppliers), supplier_id (FK на counterparties)
  // оставляем NULL — DTO supplierName собирается из COALESCE двух источников.
  const headerValues = {
    status,
    parseErrorCode,
    parseErrorDetails,
    supplierId: null,
    supplierDirectoryId,
    recipientId,
    ...documentParties,
    docNumber: parsed.docNumber ?? null,
    docDate,
    totalSum: parsed.totalSum != null ? parsed.totalSum.toString() : null,
    vatSum: parsed.vatSum != null ? parsed.vatSum.toString() : null,
    llmProviderId,
    llmConfidence: parsed.confidence.toString(),
    validation,
    processedAt: new Date(),
    updatedAt: new Date(),
    // Второй проход, дошедший сюда, победил сравнение — фиксируем исход, иначе
    // recovery посчитал бы попытку незавершённой и поставил её заново.
    ...(secondPassJob
      ? {
          secondPass: {
            state: 'done',
            mode: 'vision',
            outcome: 'replaced',
            finishedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
  const secondPassQueued = wantSecondPass
    ? await queueSecondPass({ sourceDocumentId, s3Key, reasons: weakReasons, values: headerValues })
    : false;
  if (!secondPassQueued) {
    await db
      .update(sourceDocuments)
      .set(headerValues)
      .where(eq(sourceDocuments.id, sourceDocumentId));

    // Автоподстановка подрядчика по покупателю — только для публичной загрузки.
    //
    // Отдельным UPDATE после записи шапки, а не полем в headerValues: условие
    // «получателя ещё никто не задавал» должно проверяться в момент записи,
    // иначе менеджер, выбравший подрядчика между разбором и сохранением,
    // молча потеряет свой выбор. Все guard'ы — внутри, см. resolve-contractor.ts.
    //
    // Заказан второй проход — не трогаем: документ ещё не в финальном виде,
    // подставим по итогам победившего прохода.
    const autoAssign = await autoAssignContractorFromBuyer(db, {
      sourceDocumentId,
      status,
      confidence,
      minConfidence: MIN_DEDUP_CONFIDENCE,
      buyerInn: recipient?.inn ?? null,
    });
    if (autoAssign.assigned) {
      log.info(
        { contractorId: autoAssign.contractorId, contractorName: autoAssign.name },
        'contractor auto-assigned from buyer INN',
      );
    }
  } else {
    log.warn(
      { reasons: weakReasons, parseMode },
      'weak parse — vision second pass queued as separate job',
    );
  }

  // Удаляем возможные старые позиции (если это повторный прогон после
  // resolve-duplicate/replace) и вставляем новые.
  await db
    .delete(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, sourceDocumentId));
  if (parsed.items.length > 0) {
    const rows = await Promise.all(
      parsed.items.map(async (it, idx) => ({
        sourceDocumentId,
        materialId: await findOrCreateMaterial(it.nameRaw, it.unit),
        nameRaw: it.nameRaw,
        // qty может быть null для строк-услуг (доставка без количества) —
        // в БД пишем '0' (колонка NOT NULL), как в waybill-пути.
        qty: it.qty != null ? it.qty.toString() : '0',
        unit: it.unit,
        price: it.price != null ? it.price.toString() : null,
        sum: it.sum != null ? it.sum.toString() : null,
        // vatRate/vatSum извлекаются промптом v5+. Старые промпты их
        // игнорируют → останутся NULL, веб-портал в этом случае рисует
        // «—» в колонке «Сумма НДС». См. контракт UpdPdfItemSchema.
        vatRate: it.vatRate != null ? it.vatRate.toString() : null,
        vatSum: it.vatSum != null ? it.vatSum.toString() : null,
        volumeM3: it.volumeM3 != null ? it.volumeM3.toString() : null,
        massKg: it.massKg != null ? it.massKg.toString() : null,
        volumeConfidence: it.volumeConfidence ?? null,
        groupName: it.groupName ?? null,
        lineNo: idx + 1,
      })),
    );
    await db.insert(sourceDocumentItems).values(rows);
  }

  // Дубликат у собранного документа — предупреждение поверх сохранённого
  // результата: позиции и реквизиты остаются, менеджер решает, что делать.
  if (duplicate && segmentContext) {
    await db
      .update(sourceDocuments)
      .set({
        status: 'needs_resolution',
        parseErrorCode: 'duplicate_upd',
        parseErrorDetails: {
          existingId: duplicate.id,
          docNumber: parsed.docNumber,
          docDate: parsed.docDate,
        },
        updatedAt: new Date(),
      })
      .where(eq(sourceDocuments.id, sourceDocumentId));
  }

  log.info(
    { itemsCount: parsed.items.length, status, parseErrorCode },
    'upd parsed successfully',
  );
  await notifySourceDocumentUpdated(sourceDocumentId);

  // Комплект мог стать готовым именно сейчас. Вызов здесь, а не в вызывающем
  // коде: у handleJob несколько ранних выходов, и публикация не должна
  // зависеть от того, каким из них закончился разбор — за остальные отвечает
  // finally в обработчике очереди и ветка worker.on('failed').
  if (segmentContext) {
    await tryFinalizeUpdAssembly(segmentContext.rootId, segmentContext.generation, log);
  }
}

// ─── Накладные (ТН-2116 + ОС-2): vision-LLM пайплайн ─────────────────────
//
// Один пакет (source_bundles row) может породить N source_documents разных
// форм. Шаги:
//   1. Перевод bundle.status в 'processing'.
//   2. Сбор всех attachments пакета (по bundle_id записей нет — attachments
//      привязаны к source_documents; временно мы кладём их на «техническую»
//      запись source_document с kind='transport_waybill' status='queued',
//      создаваемую при загрузке. См. uploadWaybill в routes/source-documents.ts).
//   3. Vision-LLM вызов parseWaybillBatch → массив документов.
//   4. Если массив пустой → bundle.status='parse_failed' + удаление
//      технической source_document.
//   5. Иначе: транзакционно
//        - DELETE технической source_document (с её attachments_junction);
//        - INSERT N source_documents (kind по форме), их items;
//        - INSERT N×M строк в sourceDocumentAttachments (все файлы пакета
//          ко всем созданным документам — оператор всегда видит весь
//          пакет в карточке любого документа);
//        - UPDATE bundle.status='parsed', doc_count=N.
//   6. SSE-уведомление о каждом созданном source_document.
//
// Минимальный logger-интерфейс — для совместимости с тем, что возвращает
// logger.child() (полный pino-тип через границу функции не передаётся).
type WorkerLog = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

async function handleWaybillBundleJob(bundleId: string, log: WorkerLog): Promise<void> {
  // Берём bundle и проверяем что он ещё актуален.
  const [bundle] = await db
    .update(sourceBundles)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(sourceBundles.id, bundleId))
    .returning();
  if (!bundle) {
    log.warn('bundle is gone — skipping job');
    return;
  }

  // Техническая source_document, под которой висят attachments пакета.
  // Она создаётся при загрузке (kind='transport_waybill', status='queued')
  // и после распознавания будет заменена на N реальных документов.
  //
  // Фильтр по is_technical обязателен: реальные документы тоже несут bundleId,
  // и без него повтор задания взял бы уже разобранный документ и продублировал
  // пачку.
  const [tech] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.bundleId, bundleId), eq(sourceDocuments.isTechnical, true)))
    .limit(1);
  if (!tech) {
    await db
      .update(sourceBundles)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'parse_failed',
        parseErrorMessage: 'нет технической записи source_document для пакета',
        updatedAt: new Date(),
      })
      .where(eq(sourceBundles.id, bundleId));
    log.warn('bundle has no technical source_document — parse_failed');
    return;
  }
  const techId = tech.id;

  const attachments = await db
    .select()
    .from(sourceDocumentAttachments)
    .where(eq(sourceDocumentAttachments.sourceDocumentId, techId));
  if (attachments.length === 0) {
    await db
      .update(sourceBundles)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'parse_failed',
        parseErrorMessage: 'нет приложенных файлов',
        updatedAt: new Date(),
      })
      .where(eq(sourceBundles.id, bundleId));
    log.warn('bundle: нет attachments — parse_failed');
    return;
  }

  const files: WaybillInputImage[] = [];
  for (const a of attachments) {
    try {
      const buf = await getObject(a.s3Key);
      files.push({ buffer: buf, mimeType: a.mimeType ?? 'image/jpeg', filename: a.filename });
    } catch (err) {
      log.warn({ err, s3Key: a.s3Key }, 'bundle: skip attachment, getObject failed');
    }
  }
  if (files.length === 0) {
    throw new Error('bundle: не удалось скачать ни одного attachment');
  }

  // Накладные через OpenRouter: vision принимает только image/* (не PDF) —
  // конвертируем PDF-вложения в PNG-страницы ПЕРЕД parseWaybillBatch. Gemini
  // читает PDF нативно, для него не трогаем. Ошибка рендера пробрасывается во
  // внешний catch → bundle помечается parse_failed без BullMQ-retry.
  if ((await getDefaultProviderKind()) === 'openrouter') {
    const expanded = await expandPdfAttachmentsForOpenRouter(files);
    files.length = 0;
    files.push(...expanded);
  }

  let parsed;
  let llmProviderId: string | null = null;
  try {
    const r = await parseWaybillBatch(files, { sourceDocumentId: techId, bundleId });
    parsed = r.parsed;
    llmProviderId = r.llmProviderId;
  } catch (err) {
    log.error({ err }, 'waybill batch parse failed, will retry');
    throw err;
  }

  // Пакет не содержит распознаваемых документов → parse_failed,
  // ни одной source_document не создаём (техническую удалит DELETE
  // ниже только если есть documents; здесь оставляем её для аудита).
  if (parsed.documents.length === 0) {
    await db
      .update(sourceDocuments)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'no_waybill_found',
        llmProviderId,
        llmConfidence: '0',
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceDocuments.id, techId));
    await db
      .update(sourceBundles)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'no_waybill_found',
        parseErrorMessage: 'в пакете не найдено ни ТН, ни ОС-2',
        updatedAt: new Date(),
      })
      .where(eq(sourceBundles.id, bundleId));
    log.warn('no waybill found in bundle');
    // Пакет мог быть развёрнут router'ом из файла родительской поставки —
    // тогда без этой отметки файл исчезал из виду совсем (документа нет,
    // родительская строка реестра осталась в created).
    await markSubBundleItemFailed(
      bundleId,
      'накладная не распознана — ни ТН, ни ОС-2 не найдены',
      log,
    );
    await notifySourceDocumentUpdated(techId);
    return;
  }

  // Создаём N source_documents по одному на каждый элемент массива.
  // Атачменты пакета прикрепляем к каждому из них (все ко всем) —
  // оператор в карточке любого документа видит весь пакет.
  const created: { id: string; docNumber: string | null; form: string }[] = [];
  for (const doc of parsed.documents) {
    const newId = await createSourceDocumentFromWaybill({
      doc,
      bundleId,
      bundle,
      llmProviderId,
      attachments: attachments.map((a) => ({
        s3Key: a.s3Key,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
      })),
    });
    created.push({ id: newId, docNumber: doc.docNumber ?? null, form: doc.form });
  }

  // Удаляем техническую запись — она больше не нужна, её attachments уже
  // продублированы в реальные source_documents. Вместе с tombstone: клиент,
  // получивший её до внедрения фильтра `is_technical`, должен узнать об
  // удалении через /sync.deletedIds.
  await db.transaction(async (tx) => {
    const [tech] = await tx
      .select({ siteId: sourceDocuments.siteId })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, techId))
      .limit(1);
    await tx.insert(entityDeletions).values({
      entityType: 'source_document',
      entityId: techId,
      siteId: tech?.siteId ?? null,
    });
    await tx.delete(sourceDocuments).where(eq(sourceDocuments.id, techId));
  });

  await db
    .update(sourceBundles)
    .set({
      status: 'parsed',
      docCount: created.length,
      updatedAt: new Date(),
    })
    .where(eq(sourceBundles.id, bundleId));

  log.info(
    { created: created.length, forms: created.map((c) => c.form) },
    'waybill bundle parsed successfully',
  );
  for (const c of created) {
    await notifySourceDocumentUpdated(c.id);
  }
}

/**
 * Входной файл пачки для router'а.
 *
 * Источников два, и это временно: пакеты нового формата описаны реестром
 * (bundle_import_items), старые — только attachments служебной записи. Поля
 * совпадают с attachments намеренно, чтобы ветки маршрутизации не знали, откуда
 * пришёл файл.
 */
type RouterInputFile = {
  s3Key: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Строка реестра. NULL — legacy-пакет, строку придётся создавать вставкой. */
  registryItemId: string | null;
  uploadGeneration: number | null;
  /**
   * Позиция файла в пачке. Адресует страницы при сборке логических УПД:
   * PageRef хранит именно её, а не порядок выборки из БД.
   */
  inputOrder: number;
  /**
   * Статус строки реестра на входе в прогон.
   *
   * Терминальных состояний два, и повторять нельзя ни одно: `created` дал бы
   * второй документ на тот же файл, `skipped` — лишнюю работу над файлом,
   * который распознавать не нужно. Хранится именно статус, а не булев флаг:
   * дальше по нему решается, увеличивать ли счётчик созданных.
   */
  status: string | null;
  /** `store_only` — файл из зоны «Дополнительные документы»: не распознаём. */
  processingMode: string;
};

/**
 * Что разбирать: реестр живой загрузки, иначе attachments служебной записи.
 *
 * Реестр — источник истины: он заводится при приёме, переживает и разбор, и
 * удаление служебной записи, поэтому повторный запуск возможен всегда. Fallback
 * на attachments остаётся для пакетов, принятых до этого.
 *
 * Источник возвращается наружу: от него зависит, чистить ли legacy-строки
 * журнала перед прогоном (см. вызов).
 */
async function loadRouterInputs(
  bundleId: string,
  activeUploadGeneration: number,
  techId: string | null,
): Promise<{ files: RouterInputFile[]; source: 'registry' | 'attachments' }> {
  const registry = await selectRegistryRows(db, bundleId, activeUploadGeneration);

  if (registry.length > 0) {
    // Порядок файлов: input_order, проставленный при приёме. У строк старше
    // миграции 0096 его нет — они идут после нумерованных, в порядке
    // поступления. Сортировка здесь, а не в SQL: fallback-ветка ниже читает
    // attachments, и порядок должен определяться одним правилом.
    const ordered = [...registry].sort((a, b) => {
      if (a.inputOrder !== null && b.inputOrder !== null) return a.inputOrder - b.inputOrder;
      if (a.inputOrder !== null) return -1;
      if (b.inputOrder !== null) return 1;
      const byDate = a.createdAt.getTime() - b.createdAt.getTime();
      return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
    });
    return {
      source: 'registry',
      files: ordered.map((r, idx) => ({
        s3Key: r.s3Key as string,
        filename: r.filename,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        registryItemId: r.id,
        uploadGeneration: r.uploadGeneration,
        // Позиция в разложенном порядке: сборка адресует страницы именно ею, и
        // для legacy-строк без input_order она тоже должна быть определена.
        inputOrder: r.inputOrder ?? idx,
        status: r.status,
        processingMode: r.processingMode,
      })),
    };
  }

  if (!techId) return { files: [], source: 'attachments' };

  const attachments = await db
    .select()
    .from(sourceDocumentAttachments)
    .where(eq(sourceDocumentAttachments.sourceDocumentId, techId));
  return {
    source: 'attachments',
    files: attachments.map((a, idx) => ({
      s3Key: a.s3Key,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      registryItemId: null,
      uploadGeneration: null,
      inputOrder: idx,
      status: null,
      // Пакеты, принятые до появления зон, знали только один режим.
      processingMode: 'auto',
    })),
  };
}

/** Решение router'а по файлу — то, что отличается между ветками. */
type ImportItemOutcome = {
  detectedKind?: string | null;
  confidence?: string | null;
  parserUsed?: string | null;
  status: string;
  reason?: string | null;
  createdDocumentIds?: string[];
  subBundleId?: string | null;
  metadata?: Record<string, unknown> | null;
  // Конечный исход файла, если он отличается от решения router'а. Ключ не
  // передан — выводится из status; передан явный null — исход ЕЩЁ НЕ ИЗВЕСТЕН
  // (файл ушёл в асинхронную сборку, см. recordImportItem).
  effectiveStatus?: string | null;
};

// Решения router'а, после которых по файлу больше ничего не произойдёт.
// Нетерминальные (accepted, uploading, needs_review) означают, что файл до
// разбора не дошёл — их добивает инвариант завершённости пакета.
const TERMINAL_ITEM_STATUSES = new Set(['created', 'skipped', 'failed']);

/**
 * Записывает решение по файлу в реестр.
 *
 * Для пакетов нового формата строка уже существует (заведена при приёме) —
 * обновляем её по id. Для legacy-пакетов строки нет, вставляем. Раньше журнал
 * очищался целиком перед каждым прогоном; теперь строка постоянная, иначе файл,
 * упавший при разборе, не оставлял бы следов вообще.
 *
 * Принимает tx: в ветках, создающих документ, запись обязана быть в ОДНОЙ
 * транзакции с документом и заданием очереди — иначе крах между ними оставит
 * файл незакрытым, и повтор создаст второй документ.
 */
async function recordImportItem(
  tx: typeof db,
  bundleId: string,
  file: RouterInputFile,
  outcome: ImportItemOutcome,
): Promise<void> {
  const values = {
    detectedKind: outcome.detectedKind ?? null,
    confidence: outcome.confidence ?? null,
    parserUsed: outcome.parserUsed ?? null,
    status: outcome.status,
    reason: outcome.reason ?? null,
    createdDocumentIds: outcome.createdDocumentIds ?? [],
    subBundleId: outcome.subBundleId ?? null,
    metadata: outcome.metadata ?? null,
    // Конечный исход. Для терминальных решений он совпадает с status; ветки,
    // где исход выясняется позже (дочерний пакет накладной), переписывают его
    // отдельно. Держать колонку заполненной обязательно: проверка «ни один
    // принятый файл не потерян» опирается именно на неё.
    //
    // Различаем «ключ не передан» и «передан явный null»: у сборки логических
    // УПД файл уезжает в дочерний пакет со status='created', но исход по нему
    // выяснится только после публикации или отката, и объявлять его
    // обработанным сразу нельзя. `??` такой разницы не видит, поэтому проверка
    // именно по наличию ключа.
    effectiveStatus:
      'effectiveStatus' in outcome
        ? outcome.effectiveStatus
        : TERMINAL_ITEM_STATUSES.has(outcome.status)
          ? outcome.status
          : null,
    updatedAt: new Date(),
  };

  if (file.registryItemId) {
    await tx
      .update(bundleImportItems)
      .set(values)
      .where(eq(bundleImportItems.id, file.registryItemId));
    return;
  }

  await tx.insert(bundleImportItems).values({
    bundleId,
    sourceFilename: file.filename,
    inputS3Key: file.s3Key,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    uploadGeneration: file.uploadGeneration,
    ...values,
  });
}

/**
 * Обёртка над markSubBundleItemsFailed: ошибку разметки глушим — она не повод
 * валить обработчик, а исход перепроверит периодическая проверка инварианта.
 */
async function markSubBundleItemFailed(
  subBundleId: string,
  reason: string,
  log: WorkerLog,
): Promise<void> {
  try {
    const updated = await markSubBundleItemsFailed(db, subBundleId, reason);
    if (updated.length > 0) {
      log.warn({ subBundleId, items: updated.length }, 'sub-bundle failed → строка реестра failed');
    }
  } catch (err) {
    log.error({ err, subBundleId }, 'не удалось пометить строку реестра failed');
  }
}

/**
 * Инвариант завершённости: пакет не считается разобранным, пока в реестре есть
 * строки «в процессе». Ошибку глушим — она не повод валить разбор, тот же
 * инвариант перепроверяется периодически (repairStuckJobs).
 */
async function closeStaleRegistryItems(
  bundleId: string,
  log: WorkerLog,
  opts?: { reason?: string },
): Promise<void> {
  try {
    const stale = await finalizeStaleRegistryItems(db, bundleId, opts);
    if (stale.length > 0) {
      log.warn(
        { bundleId, files: stale.map((s) => s.filename) },
        'router: строки реестра не дошли до разбора — помечены failed',
      );
    }
  } catch (err) {
    log.error({ err, bundleId }, 'не удалось закрыть незавершённые строки реестра');
  }
}

// Единый вход «Загрузить документы» (router). Классифицирует КАЖДЫЙ файл пачки
// и разворачивает его в СУЩЕСТВУЮЩИЙ проверенный flow:
//   - УПД → одиночная очередь {sourceDocumentId, s3Key} (как «Загрузить УПД»);
//   - накладная (ТН/ОС-2) → отдельный waybill-bundle {bundleId} (как
//     «Загрузить накладные»).
// Router сам документы НЕ парсит и НЕ создаёт «с нуля» — переиспользует рабочий
// код, поэтому данные не портятся. Каждое решение пишется в bundle_import_items
// (журнал). Файл, тип которого не подтвердили ни классификатор, ни vision,
// становится документом «не распознано» (needs_resolution) под ручной разбор —
// молча исчезнуть он не может.
// Экспортируется ради теста провенанса: проверяется, что документы наследуют
// происхождение пакета, получают связь с ним и что повтор задания не удваивает
// пачку. В проде вызывается только из handleJob.
export async function handleDocumentRouterJob(bundleId: string, log: WorkerLog): Promise<void> {
  const [bundle] = await db
    .update(sourceBundles)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(sourceBundles.id, bundleId))
    .returning();
  if (!bundle) {
    log.warn('router bundle is gone — skipping');
    return;
  }

  // Только служебная запись — см. пояснение в handleWaybillBundleJob.
  // С переходом на реестр она перестала быть обязательной: пакеты нового
  // формата разбираются и без неё, поэтому её отсутствие больше не фатально.
  const [tech] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.bundleId, bundleId), eq(sourceDocuments.isTechnical, true)))
    .limit(1);
  const techId = tech?.id ?? null;

  const { files: inputs, source: inputsSource } = await loadRouterInputs(
    bundleId,
    bundle.activeUploadGeneration,
    techId,
  );
  if (inputs.length === 0) {
    await db
      .update(sourceBundles)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'parse_failed',
        parseErrorMessage: techId
          ? 'нет приложенных файлов'
          : 'нет ни реестра входных файлов, ни технической записи source_document',
        updatedAt: new Date(),
      })
      .where(eq(sourceBundles.id, bundleId));
    log.warn('router bundle: нечего разбирать — parse_failed');
    return;
  }

  const bundleExpected =
    bundle.expectedDate instanceof Date
      ? bundle.expectedDate
      : bundle.expectedDate
        ? new Date(bundle.expectedDate)
        : null;

  // Происхождение наследуется от пакета: документ, приехавший письмом, должен
  // остаться почтовым и после разбора. У пакетов, загруженных кнопкой,
  // origin не заполнен — для них поведение прежнее.
  const bundleOrigin = bundle.origin ?? 'manual_pdf';

  // Идемпотентность журнала. Раньше здесь стоял безусловный DELETE всех строк
  // пакета: иначе при повторном прогоне они НАКАПЛИВАЛИСЬ и import-result
  // показывал дубли (1 файл → 2-3-4 строки, в т.ч. с reason от прежних версий
  // кода).
  //
  // Чистим ТОЛЬКО когда входы взяты из attachments: там recordImportItem идёт
  // вставкой, и без чистки повтор наплодил бы дубли (NULL в upload_generation
  // частичный unique-индекс не удерживает — Postgres считает NULL различными).
  // Если же входы пришли из реестра, эти самые строки и есть источник истины:
  // снести их значило бы обновлять несуществующие записи и остаться с пустым
  // журналом импорта.
  if (inputsSource === 'attachments') {
    await db
      .delete(bundleImportItems)
      .where(
        and(eq(bundleImportItems.bundleId, bundleId), isNull(bundleImportItems.uploadGeneration)),
      );
  }

  let createdCount = 0;
  let failedCount = 0;

  // Сборка логических УПД включается только там, где она и нужна: публичная
  // форма поставщика, входящее направление, включённый флаг. Проверка одна на
  // весь пакет — до цикла, чтобы решение по файлам не разъехалось.
  const assemblyEnabled = await isUpdAssemblyEligible(bundleId, bundle);
  const assemblyCandidates: { file: RouterInputFile; cls: FileClassification }[] = [];

  for (const a of inputs) {
    // Файл уже в терминальном состоянии от прошлого прогона (крах в середине
    // пачки, BullMQ retry, ручной перезапуск). Повторять нельзя: created дал бы
    // второй документ на тот же файл, skipped — лишний vision-вызов ради файла,
    // который распознавать не нужно.
    if (a.status === 'created') {
      createdCount++;
      continue;
    }
    if (a.status === 'skipped') continue;

    if (a.processingMode === 'store_only') {
      // Файл из зоны «Дополнительные документы»: сертификат, паспорт качества,
      // спецификация, акт. Человек уже сказал, что распознавать его не надо,
      // поэтому его даже не скачивают из S3 — ни классификации, ни vision, ни
      // дочернего задания. Файл лежит в бакете, строка реестра помнит его, и
      // менеджер открывает его в карточке поставки.
      await recordImportItem(db, bundleId, a, {
        detectedKind: null,
        parserUsed: 'none',
        status: 'skipped',
        createdDocumentIds: [],
        reason: 'дополнительный документ — загружен без распознавания',
        metadata: { processingMode: 'store_only' },
      });
      // Ни created, ни failed: это штатный исход, а не отказ.
      continue;
    }

    // Per-file изоляция: ошибка одного файла (битый S3 / исключение в
    // классификации или роутинге) НЕ должна валить весь router-job, иначе
    // пакет уйдёт в retry с backoff 60с и «зависнет», а остальные файлы не
    // обработаются. Любой сбой по файлу → failed в журнал, идём дальше.
    try {
      let buffer: Buffer;
      try {
        buffer = await getObject(a.s3Key);
      } catch (err) {
        log.warn({ err, s3Key: a.s3Key }, 'router: getObject failed');
        await recordImportItem(db, bundleId, a, {
          parserUsed: 'none',
          status: 'failed',
          reason: 'не удалось скачать файл из S3',
        });
        failedCount++;
        continue;
      }

      // Сбой самой классификации не должен прятать файл. Раньше исключение
      // отсюда ловил общий catch файла и писал failed, а дополнительные файлы
      // поставки отбираются по skipped — файл переставал быть виден вообще.
      // Считаем такой случай «тип не определён»: ниже по нему заведётся
      // документ «не распознано» под ручной разбор. Инфраструктурные сбои
      // (S3, БД) по-прежнему failed.
      let cls: FileClassification;
      try {
        cls = await classifyFile(buffer, a.mimeType ?? '', a.filename);
      } catch (err) {
        log.warn({ err, file: a.filename }, 'router: classifyFile failed — сохраняем как прочий');
        cls = {
          detectedKind: 'unknown',
          confidence: 0,
          needsVision: false,
          parserUsed: 'none',
          signals: ['classify:error'],
        };
      }

      // Vision-доклассификация типа: если детерминированно тип не определён
      // (фото/скан/битый PDF без маркера в имени → detectedKind='unknown',
      // needsVision) — спрашиваем модель, что это за документ по изображению.
      // Так фото М-15/накладной не уходит по умолчанию в УПД (кейс «Су-10
      // Алюспэйс»). Лёгкий запрос (1 картинка, ≤200 токенов). При неуверенности
      // (< 0.6) / ошибке classifyImageKind вернёт null или unknown → cls не
      // меняется, и файл попадает в ветку unknown ниже (документ «не
      // распознано» под ручной разбор). Уже работающие сканы УПД не
      // затрагиваются: их vision подтверждает как upd.
      if (cls.detectedKind === 'unknown' && cls.needsVision) {
        const vc = await classifyImageKind(buffer, a.mimeType ?? '', { sourceDocumentId: null });
        if (vc && vc.confidence >= 0.6 && vc.kind !== 'unknown') {
          cls = {
            ...cls,
            detectedKind: vc.kind,
            // Уверенность тоже от модели: раньше в журнал уезжало исходное 0
            // или 0.3 — число, к принятому решению отношения не имеющее.
            confidence: vc.confidence,
            signals: [...cls.signals, `vision-kind:${vc.kind}:${vc.confidence.toFixed(2)}`],
          };
        }
      }

      // Накладная (по тексту ИЛИ по vision-доклассификации) → waybill-парсер.
      // Подтверждённое УПД — в УПД-flow (ветка else): парсер сам покрывает
      // Excel (parseUpdXlsx), текстовый PDF (parseUpdPdf) и скан/фото/битый
      // текстовый слой (parseUpdVision). Благодаря этому сканы, фото и PDF с
      // «битыми» глифами 1С НЕ теряются, а распознаются. Главное — на КАЖДЫЙ
      // файл создаётся видимая строка (12 загрузил → 12 строк).
      const isWaybill =
        cls.detectedKind === 'transport_waybill' || cls.detectedKind === 'os2_transfer';

      if (cls.detectedKind === 'unknown' && assemblyEnabled && isAssemblyCandidate(a, cls)) {
        // Страница-продолжение УПД (таблица позиций без шапки счёта-фактуры)
        // пофайлово опознаётся именно как unknown: ни текстовый классификатор,
        // ни vision по одному кадру не могут сказать, частью чего она является.
        // Отправить её в заглушку ДО пакетной классификации — значит гарантированно
        // повторить исходную ошибку: страница станет пустым документом, а её
        // позиции пропадут из своего УПД.
        //
        // Поэтому при включённой сборке такой файл идёт в общий разбор пакета,
        // и заглушкой становится только если ни одна его страница не вошла в
        // сегмент.
        assemblyCandidates.push({ file: a, cls });
        continue;
      }

      if (cls.detectedKind === 'unknown') {
        // Тип не подтвердил ни текстовый классификатор, ни vision. В УПД-flow
        // такой файл отправлять нельзя: он почти всегда оседал пустым
        // черновиком (из 12 таких документов на бою менеджер удалил 10). Но и
        // прятать его в дополнительные файлы нельзя — он пришёл из ОБЯЗАТЕЛЬНОЙ
        // зоны формы, где поставщик грузит накладную и УПД; молча исчезнув
        // оттуда, он теряется для приёмки.
        //
        // Поэтому заводим документ-заглушку: строка в «Документах» с тегом «не
        // распознано», разбирать её будет человек. Задание в очередь НЕ ставим —
        // распознавать нечем, все автоматические попытки уже исчерпаны.
        const docId = randomUUID();
        await db.transaction(async (tx) => {
          await tx.insert(sourceDocuments).values({
            id: docId,
            // Новых видов не вводим: тип неизвестен, а 'upd' — общий вход
            // раздела «Документы». В UI он подменяется на «—» по коду ошибки.
            kind: 'upd',
            direction: bundle.direction,
            origin: bundleOrigin,
            status: 'needs_resolution',
            parseErrorCode: 'unrecognized_type',
            parseErrorDetails: {
              message: 'тип документа не определён — требуется ручной разбор',
              signals: cls.signals,
            },
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            recipientSource: manualRecipientSource(bundle),
            siteId: bundle.siteId,
            expectedDate: bundleExpected,
            originalFilename: a.filename,
            // Разбор завершён (и не начнётся снова) — processedAt честно
            // фиксирует момент, дальше документ ждёт человека.
            processedAt: new Date(),
            bundleId,
            createdByUserId: bundle.createdByUserId,
          });
          await tx.insert(sourceDocumentAttachments).values({
            sourceDocumentId: docId,
            s3Key: a.s3Key,
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            role: 'original',
          });
          await recordImportItem(tx as unknown as typeof db, bundleId, a, {
            detectedKind: 'unknown',
            confidence: cls.confidence.toString(),
            parserUsed: 'none',
            status: 'created',
            effectiveStatus: 'created',
            createdDocumentIds: [docId],
            reason: 'тип документа не определён — требуется ручной разбор',
            metadata: { signals: cls.signals, needsVision: cls.needsVision },
          });
        });
        createdCount++;
        continue;
      }

      if (cls.detectedKind === 'supplementary') {
        // Документ о качестве или соответствии: сертификат, паспорт качества,
        // декларация, протокол испытаний. Реквизиты из него не нужны, поэтому
        // ни документа, ни задания — файл просто остаётся в S3, а строка
        // реестра помнит его и показывает менеджеру в карточке поставки.
        //
        // Раньше такой файл уходил в УПД-flow: занимал слот воркера, тратил
        // vision-вызовы и оседал в списке пустым черновиком.
        await recordImportItem(db, bundleId, a, {
          detectedKind: 'supplementary',
          confidence: cls.confidence.toString(),
          parserUsed: 'none',
          status: 'skipped',
          createdDocumentIds: [],
          reason: 'сопроводительный документ — распознавание не требуется',
          metadata: { signals: cls.signals, needsVision: cls.needsVision },
        });
        // Ни created, ни failed: это штатный исход, а не отказ.
        continue;
      }

      if (cls.detectedKind === 'm15') {
        // М-15 (накладная на отпуск материалов). Создаём документ типа
        // «Накладная» (transport_waybill — новых enum не вводим) и ставим
        // одиночный job с docKind:'m15' → handleJob распознает его vision'ом по
        // форме М-15. Изолировано: УПД/ТН/ОС-2 не затрагиваются.
        // Идентификатор задаём сами: тогда ключ задания известен до вставки и
        // документ вместе с заданием попадает в БД одной транзакцией.
        const docId = randomUUID();
        const dedupeKey = dispatchKeyOf(docId);
        await db.transaction(async (tx) => {
          await tx.insert(sourceDocuments).values({
            id: docId,
            kind: 'transport_waybill',
            direction: bundle.direction,
            origin: bundleOrigin,
            status: 'queued',
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            recipientSource: manualRecipientSource(bundle),
            siteId: bundle.siteId,
            expectedDate: bundleExpected,
            originalFilename: a.filename,
            queuedAt: new Date(),
            parsedAt: new Date(),
            jobId: dedupeKey,
            // Связь с пакетом: без неё от документа не дойти до истории
            // загрузки, а сам пакет выглядит осиротевшим и повторная загрузка
            // того же комплекта запускала бы разбор заново.
            bundleId,
            createdByUserId: bundle.createdByUserId,
          });
          await tx.insert(sourceDocumentAttachments).values({
            sourceDocumentId: docId,
            s3Key: a.s3Key,
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            role: 'original',
          });
          await enqueueJob(tx as unknown as typeof db, {
            queue: UPD_PARSE_QUEUE,
            jobName: 'parse',
            payload: { sourceDocumentId: docId, s3Key: a.s3Key, docKind: 'm15' },
            dedupeKey,
          });
          // В ТОЙ ЖЕ транзакции, что документ и задание: иначе крах между ними
          // оставит файл незакрытым в реестре, и повтор создаст второй документ.
          await recordImportItem(tx as unknown as typeof db, bundleId, a, {
            detectedKind: 'm15',
            confidence: cls.confidence.toString(),
            parserUsed: 'parseUpdVision',
            status: 'created',
            createdDocumentIds: [docId],
            reason: 'М-15 (отпуск материалов) → распознавание по форме М-15',
            metadata: { signals: cls.signals, needsVision: cls.needsVision },
          });
        });
        createdCount++;
      } else if (isWaybill) {
        // Разворачиваем в waybill-flow: отдельный под-bundle на этот файл
        // (тот же путь, что «Загрузить накладные»).
        const subHash = createHash('sha256').update(`router:${bundleId}:${a.s3Key}`).digest('hex');
        const subId = randomUUID();
        const subTechId = randomUUID();
        await db.transaction(async (tx) => {
          await tx.insert(sourceBundles).values({
            id: subId,
            bundleHash: subHash,
            kind: 'waybill',
            direction: bundle.direction,
            // Дочерний пакет наследует происхождение родителя — иначе накладная
            // из письма после разбора выглядела бы загруженной вручную.
            origin: bundle.origin,
            parentBundleId: bundleId,
            siteId: bundle.siteId,
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            expectedDate: bundle.expectedDate,
            status: 'queued',
            createdByUserId: bundle.createdByUserId,
          });
          await tx.insert(sourceDocuments).values({
            id: subTechId,
            kind: 'transport_waybill',
            // Служебная запись sub-пакета — тоже вне выдачи инспектору.
            isTechnical: true,
            direction: bundle.direction,
            origin: bundleOrigin,
            status: 'queued',
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            recipientSource: manualRecipientSource(bundle),
            siteId: bundle.siteId,
            expectedDate: bundleExpected,
            originalFilename: a.filename,
            queuedAt: new Date(),
            bundleId: subId,
            createdByUserId: bundle.createdByUserId,
          });
          await tx.insert(sourceDocumentAttachments).values({
            sourceDocumentId: subTechId,
            s3Key: a.s3Key,
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            role: 'original',
          });
          await enqueueJob(tx as unknown as typeof db, {
            queue: UPD_PARSE_QUEUE,
            jobName: 'parse',
            payload: { bundleId: subId },
            dedupeKey: bundleDispatchKeyOf(subId, 0),
          });
          await recordImportItem(tx as unknown as typeof db, bundleId, a, {
            detectedKind: cls.detectedKind,
            confidence: cls.confidence.toString(),
            parserUsed: 'parseWaybillBatch',
            status: 'created',
            createdDocumentIds: [],
            // Итоговый документ появится в ДОЧЕРНЕМ пакете, поэтому связь на
            // него явная: по bundle_id родителя его не найти.
            subBundleId: subId,
            reason: 'накладная → waybill-парсер',
            metadata: { signals: cls.signals, subBundleId: subId },
          });
        });
        createdCount++;
      } else if (assemblyEnabled && isAssemblyCandidate(a, cls)) {
        // Сборка логических УПД: файл не превращается в документ здесь.
        // Страницы всех кандидатов классифицируются одним заходом в дочернем
        // пакете, и уже там решается, сколько документов получится. Строка
        // реестра заводится сразу (файл не должен пропасть из виду), но исход
        // по ней ещё не известен — его проставит публикация или откат.
        assemblyCandidates.push({ file: a, cls });
      } else {
        // УПД-flow (одиночный, тот же путь, что «Загрузить УПД»). Сюда попадают:
        //  - УПД (Excel / текстовый PDF) — детерминированно;
        //  - сканы и фото, которые vision подтвердил как УПД (needsVision) —
        //    handleJob распознает их через parseUpdVision.
        // Неопознанное сюда больше не доходит: оно обработано веткой выше.
        await createSingleUpdDocument({ bundleId, bundle, bundleOrigin, bundleExpected, file: a, cls });
        createdCount++;
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), file: a.filename },
        'router: ошибка обработки файла — помечаем failed, продолжаем',
      );
      await recordImportItem(db, bundleId, a, {
        parserUsed: 'none',
        status: 'failed',
        reason: 'внутренняя ошибка обработки файла',
      }).catch(() => undefined);
      failedCount++;
    }
  }

  // Кандидаты на сборку уезжают одним дочерним пакетом: их страницы нужно
  // классифицировать вместе, иначе не понять, где кончается одна УПД и
  // начинается следующая.
  let assemblyStarted = false;
  if (assemblyCandidates.length > 0) {
    try {
      await startUpdAssembly({
        bundleId,
        bundle,
        bundleOrigin,
        candidates: assemblyCandidates,
        log,
      });
      assemblyStarted = true;
      // createdCount не увеличиваем: документы появятся в дочернем пакете и
      // будут посчитаны при публикации.
    } catch (err) {
      // Не удалось даже завести сборку (БД, outbox) — файлы не должны
      // застрять. Разворачиваем их прежним путём прямо здесь.
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'router: не удалось запустить сборку УПД — откат на «файл = документ»',
      );
      for (const c of assemblyCandidates) {
        try {
          await createSingleUpdDocument({
            bundleId,
            bundle,
            bundleOrigin,
            bundleExpected,
            file: c.file,
            cls: c.cls,
          });
          createdCount++;
        } catch (inner) {
          log.error(
            { err: inner instanceof Error ? inner.message : String(inner), file: c.file.filename },
            'router: откат кандидата сборки тоже упал',
          );
          failedCount++;
        }
      }
    }
  }

  // Техническая запись router-bundle больше не нужна — её attachments
  // переиспользованы по s3Key в развёрнутых документах (паттерн как у waybill).
  // Перечень принятых файлов от её удаления больше не страдает: он живёт в
  // реестре, а не в attachments.
  //
  // Удаляем вместе с tombstone: клиент, успевший получить эту запись до
  // внедрения фильтра `is_technical`, узнает об удалении через
  // /sync.deletedIds, а не будет держать её фантомом до logout/login.
  if (techId) {
    await db.transaction(async (tx) => {
      const [tech] = await tx
        .select({ siteId: sourceDocuments.siteId })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, techId))
        .limit(1);
      await tx.insert(entityDeletions).values({
        entityType: 'source_document',
        entityId: techId,
        siteId: tech?.siteId ?? null,
      });
      await tx.delete(sourceDocuments).where(eq(sourceDocuments.id, techId));
    });
  }
  // Инвариант завершённости: пакет объявляется разобранным только после того,
  // как у КАЖДОЙ его строки активного поколения есть терминальный исход.
  // Строка, оставшаяся в accepted (крах в середине пачки) или в needs_review
  // (legacy-строка без ключа S3, до входов вообще не дошедшая), невидима
  // нигде — ни документа, ни дополнительного файла.
  await closeStaleRegistryItems(bundleId, log);

  // Пакет со сборкой ещё не разобран: документы появятся, когда дочерний пакет
  // опубликует поколение. Ставить 'parsed' сейчас — значит объявить готовым
  // пакет, у которого ни одного видимого документа нет.
  await db
    .update(sourceBundles)
    .set({
      status: assemblyStarted ? 'processing' : 'parsed',
      kind: 'mixed',
      docCount: createdCount,
      updatedAt: new Date(),
    })
    .where(eq(sourceBundles.id, bundleId));
  log.info(
    { created: createdCount, failed: failedCount, assembly: assemblyCandidates.length },
    'router bundle classified',
  );
}

// ─── Сборка логических УПД (Э6) ─────────────────────────────────────────────
//
// Пофайловый разбор ломается на самом частом сценарии публичной формы:
// поставщик фотографирует документы постранично. Шесть снимков одной машины —
// это, например, три УПД, но router делает из них шесть документов, два из
// которых обрубки без шапки, а суммы у оставшихся не сходятся.
//
// Сборка идёт тремя фазами, и тяжёлое намеренно вынесено из router-job:
// однажды vision внутри него уже вешал воркер с CONCURRENCY=1 (revert ab25477).
//   1. router  — отбирает кандидатов и заводит дочерний пакет;
//   2. assembly — ОДИН дешёвый вызов классификации страниц, нарезка, манифест,
//      технические документы и задания на них;
//   3. handleJob по сегменту + финализатор, публикующий комплект целиком.

/**
 * Можно ли собирать этот пакет.
 *
 * Узко по умолчанию: флаг, входящее направление и публичная форма. Почта, ЭДО
 * и внутренняя загрузка на портале идут прежним путём — там другие сценарии
 * (готовые PDF из 1С), а зона риска должна оставаться маленькой.
 */
async function isUpdAssemblyEligible(
  bundleId: string,
  bundle: typeof sourceBundles.$inferSelect,
): Promise<boolean> {
  if (!loadEnv().UPD_ASSEMBLY_V1) return false;
  if (bundle.direction !== 'inbound') return false;
  const root = await resolveRootBundle(db, bundleId);
  if (!root) return false;
  const [publicEvent] = await db
    .select({ id: ingestEvents.id })
    .from(ingestEvents)
    .where(and(eq(ingestEvents.bundleId, root.id), eq(ingestEvents.channel, 'public')))
    .limit(1);
  return !!publicEvent;
}

/**
 * Годится ли файл в сборку: страницы из него можно получить растром.
 *
 * Excel остаётся на одиночном пути — у него свой структурный парсер, который
 * читает ячейки, а не картинку, и разбирать его страницами значило бы терять
 * точность ради ненужной здесь склейки.
 */
function isAssemblyCandidate(file: RouterInputFile, cls: FileClassification): boolean {
  if (cls.detectedKind === 'supplementary' || cls.detectedKind === 'm15') return false;
  const name = file.filename.toLowerCase();
  const mime = (file.mimeType ?? '').toLowerCase();
  if (/\.(xlsx?|xlsm)$/i.test(name) || mime.includes('spreadsheet') || mime.includes('excel')) {
    return false;
  }
  return (
    mime.startsWith('image/') ||
    mime === 'application/pdf' ||
    /\.(jpe?g|png|webp|pdf)$/i.test(name)
  );
}

/** Одиночный путь «файл = документ»: документ, вложение, задание, реестр. */
async function createSingleUpdDocument(args: {
  bundleId: string;
  bundle: typeof sourceBundles.$inferSelect;
  bundleOrigin: NonNullable<typeof sourceBundles.$inferSelect.origin>;
  bundleExpected: Date | null;
  file: RouterInputFile;
  cls: FileClassification;
  /** Причина в реестре: у отката она своя. */
  reasonOverride?: string;
}): Promise<string> {
  const { bundleId, bundle, bundleOrigin, bundleExpected, file: a, cls } = args;
  const docId = randomUUID();
  const dedupeKey = dispatchKeyOf(docId);
  const reason =
    args.reasonOverride ??
    (cls.detectedKind === 'upd' && !cls.needsVision
      ? cls.updInvoiceCount && cls.updInvoiceCount >= 2
        ? `УПД-пачка (${cls.updInvoiceCount} счёт-фактур) → агрегат`
        : 'УПД → одиночный парсер'
      : cls.needsVision
        ? 'скан/фото/неясный текст → распознавание через vision'
        : 'тип неоднозначен → попытка распознавания');
  await db.transaction(async (tx) => {
    await tx.insert(sourceDocuments).values({
      id: docId,
      kind: 'upd',
      direction: bundle.direction,
      origin: bundleOrigin,
      status: 'queued',
      contractorId: bundle.contractorId,
      recipientMolId: bundle.recipientMolId,
      recipientSource: manualRecipientSource(bundle),
      siteId: bundle.siteId,
      expectedDate: bundleExpected,
      originalFilename: a.filename,
      queuedAt: new Date(),
      parsedAt: new Date(),
      jobId: dedupeKey,
      bundleId,
      createdByUserId: bundle.createdByUserId,
    });
    await tx.insert(sourceDocumentAttachments).values({
      sourceDocumentId: docId,
      s3Key: a.s3Key,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      role: 'original',
    });
    await enqueueJob(tx as unknown as typeof db, {
      queue: UPD_PARSE_QUEUE,
      jobName: 'parse',
      payload: { sourceDocumentId: docId, s3Key: a.s3Key },
      dedupeKey,
    });
    await recordImportItem(tx as unknown as typeof db, bundleId, a, {
      detectedKind: cls.detectedKind,
      confidence: cls.confidence.toString(),
      parserUsed: cls.needsVision ? 'parseUpdVision' : cls.parserUsed,
      status: 'created',
      createdDocumentIds: [docId],
      reason,
      metadata: {
        signals: cls.signals,
        needsVision: cls.needsVision,
        updInvoiceCount: cls.updInvoiceCount ?? null,
      },
    });
  });
  return docId;
}

/**
 * Заводит дочерний пакет сборки и ставит задание.
 *
 * Идемпотентность — через bundle_hash, а не через id: id пакета всегда новый
 * uuid, а хеш детерминирован по (корень, поколение). Повторный router-job
 * упирается в уникальный индекс, подхватывает уже созданный пакет и второй
 * комплект документов не создаёт.
 */
async function startUpdAssembly(args: {
  bundleId: string;
  bundle: typeof sourceBundles.$inferSelect;
  bundleOrigin: NonNullable<typeof sourceBundles.$inferSelect.origin>;
  candidates: { file: RouterInputFile; cls: FileClassification }[];
  log: WorkerLog;
}): Promise<void> {
  const { bundleId, bundle, bundleOrigin, candidates, log } = args;
  const root = await resolveRootBundle(db, bundleId);
  if (!root) throw new Error('сборка УПД: не найден корневой пакет');
  const generation = root.activeUploadGeneration;

  const subHash = createHash('sha256')
    .update(`assembly:${root.id}:${generation}`)
    .digest('hex');

  const subId = randomUUID();
  const techId = randomUUID();

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(sourceBundles)
      .values({
        id: subId,
        bundleHash: subHash,
        kind: 'upd',
        direction: bundle.direction,
        origin: bundle.origin,
        parentBundleId: bundleId,
        siteId: bundle.siteId,
        contractorId: bundle.contractorId,
        recipientMolId: bundle.recipientMolId,
        expectedDate: bundle.expectedDate,
        status: 'queued',
        createdByUserId: bundle.createdByUserId,
      })
      .onConflictDoNothing({ target: sourceBundles.bundleHash })
      .returning({ id: sourceBundles.id });

    // Пакет этого поколения уже существует — значит задание поставлено раньше,
    // и повторять нечего: манифест и документы принадлежат ему.
    if (inserted.length === 0) {
      log.info({ subHash }, 'сборка УПД: дочерний пакет уже создан, пропускаем');
      return;
    }

    await tx.insert(sourceDocuments).values({
      id: techId,
      kind: 'upd',
      // Служебная запись пакета — вне выдачи, как у накладных.
      isTechnical: true,
      direction: bundle.direction,
      origin: bundleOrigin,
      status: 'queued',
      contractorId: bundle.contractorId,
      recipientMolId: bundle.recipientMolId,
      recipientSource: manualRecipientSource(bundle),
      siteId: bundle.siteId,
      expectedDate:
        bundle.expectedDate instanceof Date
          ? bundle.expectedDate
          : bundle.expectedDate
            ? new Date(bundle.expectedDate)
            : null,
      originalFilename: candidates[0]?.file.filename ?? null,
      queuedAt: new Date(),
      bundleId: subId,
      createdByUserId: bundle.createdByUserId,
    });
    await tx.insert(sourceDocumentAttachments).values(
      candidates.map((c) => ({
        sourceDocumentId: techId,
        s3Key: c.file.s3Key,
        filename: c.file.filename,
        mimeType: c.file.mimeType,
        sizeBytes: c.file.sizeBytes,
        role: 'original' as const,
      })),
    );

    for (const c of candidates) {
      await recordImportItem(tx as unknown as typeof db, bundleId, c.file, {
        detectedKind: c.cls.detectedKind,
        confidence: c.cls.confidence.toString(),
        parserUsed: 'updAssembly',
        status: 'created',
        subBundleId: subId,
        // Явный null: файл принят и передан в сборку, но чем она кончится —
        // публикацией или откатом — ещё неизвестно. Объявить его обработанным
        // сейчас значило бы соврать инварианту завершённости пакета.
        effectiveStatus: null,
        createdDocumentIds: [],
        reason: 'УПД → сборка страниц в логические документы',
        metadata: { signals: c.cls.signals, subBundleId: subId, assemblyGeneration: generation },
      });
    }

    await enqueueJob(tx as unknown as typeof db, {
      queue: UPD_PARSE_QUEUE,
      jobName: 'parse',
      payload: { bundleId: subId, mode: 'upd_assembly', generation },
      dedupeKey: assemblyDispatchKeyOf(subId, generation),
    });
  });

  log.info({ subBundleId: subId, files: candidates.length, generation }, 'сборка УПД запущена');
}

/** Всё, что сегментному заданию нужно знать о своём месте в сборке. */
type SegmentJobContext = {
  segmentId: string;
  segmentIndex: number;
  rootId: string;
  generation: number;
  pageRefs: PageRef[];
  /** Ключ первого файла сегмента — только для логов и сообщений об ошибке. */
  firstS3Key: string;
};

/**
 * Проверяет, что сегментное задание всё ещё имеет смысл, и собирает контекст.
 *
 * Проверок несколько, и это не перестраховка. Откат сборки происходит ВНУТРИ
 * того же поколения: манифест удаляется, документы стираются, файлы
 * разворачиваются по-старому. Задание, дождавшееся очереди после этого,
 * сравнение поколений прошло бы — и записало бы результат в документ, которого
 * уже нет, либо во второй раз распознало бы то, что уже разобрано иначе.
 */
async function loadSegmentContext(
  sourceDocumentId: string,
  job: { segmentId: string; generation: number },
): Promise<SegmentJobContext | null> {
  const [seg] = await db
    .select()
    .from(bundleSegments)
    .where(eq(bundleSegments.id, job.segmentId))
    .limit(1);
  if (!seg) return null; // манифест снят откатом
  if (seg.generation !== job.generation) return null;
  if (seg.sourceDocumentId !== sourceDocumentId) return null;

  const [root] = await db
    .select({
      id: sourceBundles.id,
      gen: sourceBundles.activeUploadGeneration,
      published: sourceBundles.publishedGeneration,
      status: sourceBundles.status,
    })
    .from(sourceBundles)
    .where(eq(sourceBundles.id, seg.bundleId))
    .limit(1);
  if (!root) return null;
  if (root.gen !== job.generation) return null;
  // Уже опубликовано — комплект закрыт, переписывать его нельзя.
  if (root.published !== null) return null;
  if (root.status !== 'processing') return null;

  const [doc] = await db
    .select({ id: sourceDocuments.id, isTechnical: sourceDocuments.isTechnical })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sourceDocumentId))
    .limit(1);
  // Документ уже опубликован (isTechnical снят) — значит комплект закрыт, а
  // это задание опоздало.
  if (!doc || !doc.isTechnical) return null;

  const refs = (seg.pageRefs ?? []) as PageRef[];
  if (refs.length === 0) return null;

  const [firstAttachment] = await db
    .select({ s3Key: sourceDocumentAttachments.s3Key })
    .from(sourceDocumentAttachments)
    .where(eq(sourceDocumentAttachments.sourceDocumentId, sourceDocumentId))
    .limit(1);

  return {
    segmentId: seg.id,
    segmentIndex: seg.segmentIndex,
    rootId: seg.bundleId,
    generation: seg.generation,
    pageRefs: refs,
    firstS3Key: firstAttachment?.s3Key ?? '',
  };
}

/**
 * Готовит страницы сегмента по адресам манифеста.
 *
 * Из PDF берётся ровно та страница, что записана в PageRef: сегмент может
 * занимать середину многостраничного файла, и отдавать модели весь документ
 * значило бы вернуть ту же путаницу, ради устранения которой всё затевалось.
 */
async function loadSegmentPages(ctx: SegmentJobContext): Promise<Buffer[]> {
  const rows = await selectRegistryRows(db, ctx.rootId, ctx.generation);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byOrder = new Map(rows.map((r) => [r.inputOrder ?? -1, r]));

  const pages: Buffer[] = [];
  // Кэш файлов: у россыпи фотографий каждый файл читается один раз, а у PDF
  // одна и та же выборка обслуживает несколько страниц сегмента.
  const buffers = new Map<string, Buffer>();
  for (const ref of ctx.pageRefs) {
    const row = ref.registryItemId ? byId.get(ref.registryItemId) : byOrder.get(ref.inputOrder);
    if (!row?.s3Key) continue;
    let buf = buffers.get(row.s3Key);
    if (!buf) {
      buf = await getObject(row.s3Key);
      buffers.set(row.s3Key, buf);
    }
    const isPdf =
      (row.mimeType ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(row.filename);
    if (isPdf) {
      const rendered = await renderPdf(buf, {
        firstPage: ref.pageInFile,
        lastPage: ref.pageInFile,
      });
      if (rendered[0]) pages.push(rendered[0]);
    } else {
      pages.push(await imageToPng(buf));
    }
  }
  if (pages.length === 0) throw new Error('сегмент: не удалось собрать ни одной страницы');
  return pages;
}

/** Ключи OpenRouter для классификации страниц. null — работать нечем. */
async function resolveOpenRouterCreds(): Promise<{
  apiBaseUrl: string;
  apiKey: string;
  model: string;
} | null> {
  const [provider] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!provider || provider.kind !== 'openrouter') return null;
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, provider.kind))
    .limit(1);
  if (!cred) return null;
  try {
    return {
      apiBaseUrl: cred.apiBaseUrl,
      apiKey: decryptField(cred.apiKeyEncrypted, buildAad('llm_provider_credentials', cred.kind)),
      model: provider.model,
    };
  } catch {
    return null;
  }
}

/**
 * Раскладывает файлы пакета в сквозной список страниц.
 *
 * Фотография — одна страница; PDF — столько, сколько в нём листов. Порядок
 * задаётся input_order: у россыпи снимков это единственное, что связывает
 * продолжение таблицы с её началом.
 */
async function buildAssemblyPages(
  files: RouterInputFile[],
  maxTotalPages: number,
): Promise<AssemblyPage[]> {
  const pages: AssemblyPage[] = [];
  for (const file of files) {
    const buffer = await getObject(file.s3Key);
    const isPdf =
      (file.mimeType ?? '').toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.filename);
    const rendered = isPdf
      ? await renderPdf(buffer, {})
      : [await imageToPng(buffer)];
    for (const [idx, full] of rendered.entries()) {
      if (pages.length >= maxTotalPages) {
        throw new Error(
          `пакет содержит больше ${maxTotalPages} страниц — сборка не запускается`,
        );
      }
      pages.push({
        ref: {
          registryItemId: file.registryItemId,
          inputOrder: file.inputOrder,
          pageInFile: idx + 1,
        },
        globalPage: pages.length + 1,
        full,
        thumb: await toClassifyThumb(full),
      });
    }
  }
  return pages;
}

// Сколько страниц уходит в один вызов классификатора. Тот же предел, что у
// prefilter: больше — и модель начинает путать номера.
const ASSEMBLY_CLASSIFY_CHUNK = 15;

/**
 * Сборка логических УПД: классификация страниц, нарезка, манифест, документы.
 *
 * Тяжёлого здесь ровно один вызов — классификация. Извлечение каждого УПД
 * уезжает отдельным заданием: при CONCURRENCY=1 это разница между «воркер
 * занят минуту» и «воркер занят десять».
 */
export async function handleUpdAssemblyJob(
  subBundleId: string,
  generation: number,
  log: WorkerLog,
): Promise<void> {
  const [sub] = await db
    .select()
    .from(sourceBundles)
    .where(eq(sourceBundles.id, subBundleId))
    .limit(1);
  if (!sub || !sub.parentBundleId) {
    log.warn('сборка УПД: дочерний пакет исчез — пропускаем');
    return;
  }
  const rootId = sub.parentBundleId;

  // Fencing на входе. Короткая транзакция: держать блокировку во время рендера
  // и обращения к модели нельзя — это минуты, за которые встанут соседние
  // операции по пакету.
  const gate = await db.transaction(async (tx) => {
    const [root] = await tx
      .select()
      .from(sourceBundles)
      .where(eq(sourceBundles.id, rootId))
      .for('update');
    if (!root) return { ok: false as const, reason: 'корневой пакет исчез' };
    if (root.activeUploadGeneration !== generation) {
      return { ok: false as const, reason: 'поколение устарело' };
    }
    if (root.publishedGeneration !== null) {
      return { ok: false as const, reason: 'поколение уже опубликовано' };
    }
    await tx
      .update(sourceBundles)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(eq(sourceBundles.id, subBundleId));
    return { ok: true as const, root };
  });
  if (!gate.ok) {
    log.info({ reason: gate.reason }, 'сборка УПД: задание неактуально');
    return;
  }

  // Манифест поколения уже есть — продолжаем с него. Переклассифицировать
  // нельзя: это LLM-вызов, второй раз он даст другую нарезку, и получится два
  // разных комплекта документов на один пакет.
  const existing = await db
    .select()
    .from(bundleSegments)
    .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)))
    .orderBy(bundleSegments.segmentIndex);

  let pages: AssemblyPage[] = [];
  if (existing.length === 0) {
    const registry = (await selectRegistryRows(db, rootId, generation)).filter(
      (r) => r.subBundleId === subBundleId && r.s3Key !== null,
    );
    if (registry.length === 0) {
      await rollbackUpdAssembly({
        rootId,
        subBundleId,
        generation,
        reason: 'в реестре нет файлов сборки',
        log,
      });
      return;
    }
    const files: RouterInputFile[] = [...registry]
      .sort((a, b) => (a.inputOrder ?? 0) - (b.inputOrder ?? 0))
      .map((r, idx) => ({
        s3Key: r.s3Key as string,
        filename: r.filename,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        registryItemId: r.id,
        uploadGeneration: r.uploadGeneration,
        inputOrder: r.inputOrder ?? idx,
        status: r.status,
        processingMode: r.processingMode,
      }));

    const creds = await resolveOpenRouterCreds();
    if (!creds) {
      await rollbackUpdAssembly({
        rootId,
        subBundleId,
        generation,
        reason: 'провайдер классификации недоступен',
        log,
      });
      return;
    }

    try {
      pages = await buildAssemblyPages(files, loadEnv().UPD_ASSEMBLY_MAX_TOTAL_PAGES);
    } catch (err) {
      await rollbackUpdAssembly({
        rootId,
        subBundleId,
        generation,
        reason: `не удалось подготовить страницы: ${err instanceof Error ? err.message : String(err)}`,
        log,
      });
      return;
    }

    // Классификация порциями. Смещение номеров обязательно: classifyPages в
    // каждом вызове нумерует страницы заново с единицы и про предыдущие порции
    // ничего не знает.
    const chunks: PageClassification[][] = [];
    const chunkSizes: number[] = [];
    try {
      for (let i = 0; i < pages.length; i += ASSEMBLY_CLASSIFY_CHUNK) {
        const slice = pages.slice(i, i + ASSEMBLY_CLASSIFY_CHUNK);
        const res = await classifyPages({ ...creds, thumbs: slice.map((p) => p.thumb) });
        chunks.push(res.classification);
        chunkSizes.push(slice.length);
      }
    } catch (err) {
      await rollbackUpdAssembly({
        rootId,
        subBundleId,
        generation,
        reason: `классификация страниц не удалась: ${err instanceof Error ? err.message : String(err)}`,
        log,
      });
      return;
    }

    const classification = mergeClassificationChunks(chunks, chunkSizes);
    const plan = planUpdSegments(classification, pages.length, MAX_PAGES_FOR_OPENROUTER_SEGMENT);
    if (!plan.confident) {
      await rollbackUpdAssembly({
        rootId,
        subBundleId,
        generation,
        reason: `нарезке нельзя доверять: ${plan.reasons.join('; ')}`,
        log,
      });
      return;
    }

    // Манифест пишется целиком или не пишется вовсе. Посегментная вставка
    // «кто успел» склеила бы результаты двух классификаций в один гибридный
    // комплект — с чужими страницами внутри документа.
    const written = await db.transaction(async (tx) => {
      const [root] = await tx
        .select({ gen: sourceBundles.activeUploadGeneration })
        .from(sourceBundles)
        .where(eq(sourceBundles.id, rootId))
        .for('update');
      if (!root || root.gen !== generation) return false;
      const [any] = await tx
        .select({ id: bundleSegments.id })
        .from(bundleSegments)
        .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)))
        .limit(1);
      if (any) return false; // чужой манифест победил — используем его
      await tx.insert(bundleSegments).values(
        plan.segments.map((seg) => ({
          bundleId: rootId,
          generation,
          segmentIndex: seg.segmentIndex,
          pageRefs: pageRefsOfSegment(seg, pages),
          confidence: seg.confidence,
        })),
      );
      return true;
    });
    if (!written) {
      log.info('сборка УПД: манифест этого поколения уже создан другим заданием');
    }
  }

  // Документы сегментов создаются техническими: до публикации их не должно
  // быть видно ни в списке, ни на планшете — иначе инспектор примет половину
  // поставки, пока остальные страницы ещё распознаются.
  const manifest = await db
    .select()
    .from(bundleSegments)
    .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)))
    .orderBy(bundleSegments.segmentIndex);

  const [rootBundle] = await db
    .select()
    .from(sourceBundles)
    .where(eq(sourceBundles.id, rootId))
    .limit(1);
  if (!rootBundle) return;

  const attachmentsByOrder = new Map<number, RouterInputFile>();
  for (const r of await selectRegistryRows(db, rootId, generation)) {
    if (r.subBundleId === subBundleId && r.s3Key) {
      attachmentsByOrder.set(r.inputOrder ?? 0, {
        s3Key: r.s3Key,
        filename: r.filename,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        registryItemId: r.id,
        uploadGeneration: r.uploadGeneration,
        inputOrder: r.inputOrder ?? 0,
        status: r.status,
        processingMode: r.processingMode,
      });
    }
  }

  for (const seg of manifest) {
    if (seg.sourceDocumentId) continue; // документ этого сегмента уже создан
    const refs = (seg.pageRefs ?? []) as PageRef[];
    const orders = [...new Set(refs.map((r) => r.inputOrder))].sort((a, b) => a - b);
    const docId = randomUUID();
    const dedupeKey = segmentDispatchKeyOf(seg.id, generation);
    await db.transaction(async (tx) => {
      // Повторная проверка под блокировкой строки манифеста: параллельное
      // задание могло создать документ между выборкой и вставкой.
      const [fresh] = await tx
        .select({ id: bundleSegments.id, docId: bundleSegments.sourceDocumentId })
        .from(bundleSegments)
        .where(eq(bundleSegments.id, seg.id))
        .for('update');
      if (!fresh || fresh.docId) return;

      await tx.insert(sourceDocuments).values({
        id: docId,
        kind: 'upd',
        isTechnical: true,
        direction: rootBundle.direction,
        origin: rootBundle.origin ?? 'manual_pdf',
        status: 'queued',
        contractorId: rootBundle.contractorId,
        recipientMolId: rootBundle.recipientMolId,
        recipientSource: manualRecipientSource(rootBundle),
        siteId: rootBundle.siteId,
        expectedDate:
          rootBundle.expectedDate instanceof Date
            ? rootBundle.expectedDate
            : rootBundle.expectedDate
              ? new Date(rootBundle.expectedDate)
              : null,
        originalFilename: attachmentsByOrder.get(orders[0] ?? 0)?.filename ?? null,
        queuedAt: new Date(),
        parsedAt: new Date(),
        jobId: dedupeKey,
        bundleId: subBundleId,
        createdByUserId: rootBundle.createdByUserId,
      });

      const attachments = orders
        .map((o) => attachmentsByOrder.get(o))
        .filter((f): f is RouterInputFile => f != null);
      if (attachments.length > 0) {
        await tx.insert(sourceDocumentAttachments).values(
          attachments.map((f) => ({
            sourceDocumentId: docId,
            s3Key: f.s3Key,
            filename: f.filename,
            mimeType: f.mimeType,
            sizeBytes: f.sizeBytes,
            role: 'original' as const,
          })),
        );
      }

      await tx
        .update(bundleSegments)
        .set({ sourceDocumentId: docId, updatedAt: new Date() })
        .where(eq(bundleSegments.id, seg.id));

      await enqueueJob(tx as unknown as typeof db, {
        queue: UPD_PARSE_QUEUE,
        jobName: 'parse',
        payload: { sourceDocumentId: docId, segmentId: seg.id, generation },
        dedupeKey,
      });
    });
  }

  log.info({ segments: manifest.length, subBundleId }, 'сборка УПД: сегменты поставлены в разбор');
}

// Предел страниц на один сегмент — столько картинок уходит в vision за раз.
// Тот же MAX_PAGES_FOR_OPENROUTER, что у одиночного пути; вынесен константой,
// чтобы planUpdSegments не зависел от модуля vision-парсера.
const MAX_PAGES_FOR_OPENROUTER_SEGMENT = 5;

/**
 * Исход сегмента с точки зрения публикации.
 *
 * needs_resolution в этом коде значит две разные вещи. Дубликат и расхождение
 * сумм — это ПРЕДУПРЕЖДЕНИЯ: документ распознан, менеджер разберётся, и
 * заваливать из-за них всю сборку нельзя (на боевом пакете в needs_resolution
 * были все шесть документов). А вот partial_parse — это «шапки или позиций
 * нет», то есть склеили неправильно, и такому комплекту верить нельзя.
 */
function segmentOutcome(doc: {
  status: string;
  parseErrorCode: string | null;
}): 'ready' | 'pending' | 'broken' {
  if (doc.status === 'queued' || doc.status === 'processing') return 'pending';
  if (doc.status === 'parsed') return 'ready';
  if (doc.status === 'needs_resolution') {
    return doc.parseErrorCode === 'partial_parse' ? 'broken' : 'ready';
  }
  return 'broken';
}

/**
 * Публикует комплект, когда все сегменты дошли до терминального состояния.
 *
 * Вызывается после КАЖДОГО сегментного задания (в том числе провалившегося) —
 * публикует та попытка, которая застала комплект готовым. Частичной публикации
 * не бывает: пока хоть один сегмент в работе, наружу не виден ни один документ
 * группы.
 */
export async function tryFinalizeUpdAssembly(
  rootId: string,
  generation: number,
  log: WorkerLog,
): Promise<void> {
  const decision = await db.transaction(async (tx) => {
    const [root] = await tx
      .select()
      .from(sourceBundles)
      .where(eq(sourceBundles.id, rootId))
      .for('update');
    if (!root) return { action: 'none' as const, reason: 'корневой пакет исчез' };
    if (root.activeUploadGeneration !== generation) {
      return { action: 'none' as const, reason: 'поколение устарело' };
    }
    // Уже опубликовано — второй раз ни статусы не трогаем, ни group_revision
    // не бампаем: ревизия означает «состав изменился», а он не менялся.
    if (root.publishedGeneration === generation) {
      return { action: 'none' as const, reason: 'уже опубликовано' };
    }

    const segments = await tx
      .select({
        id: bundleSegments.id,
        confidence: bundleSegments.confidence,
        docId: bundleSegments.sourceDocumentId,
      })
      .from(bundleSegments)
      .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)));
    if (segments.length === 0) return { action: 'none' as const, reason: 'манифест пуст' };

    if (segments.some((s) => s.confidence !== 'normal')) {
      return { action: 'rollback' as const, reason: 'в манифесте есть неуверенные сегменты' };
    }
    if (segments.some((s) => !s.docId)) {
      return { action: 'none' as const, reason: 'не у всех сегментов есть документ' };
    }

    const docIds = segments.map((s) => s.docId as string);
    const docs = await tx
      .select({
        id: sourceDocuments.id,
        status: sourceDocuments.status,
        parseErrorCode: sourceDocuments.parseErrorCode,
      })
      .from(sourceDocuments)
      .where(inArray(sourceDocuments.id, docIds));

    if (docs.length !== docIds.length) {
      return { action: 'rollback' as const, reason: 'документ сегмента исчез' };
    }
    const outcomes = docs.map(segmentOutcome);
    if (outcomes.includes('pending')) {
      return { action: 'none' as const, reason: 'часть сегментов ещё распознаётся' };
    }
    if (outcomes.includes('broken')) {
      return { action: 'rollback' as const, reason: 'сегмент распознан неполно' };
    }

    // ── публикация ──────────────────────────────────────────────────────────
    const now = new Date();
    // updated_at и version обязательны: планшет забирает дельту по updated_at,
    // и без бампа документы, созданные до его последней синхронизации, не
    // приедут никогда.
    await tx
      .update(sourceDocuments)
      .set({ isTechnical: false, updatedAt: now, version: drSql`${sourceDocuments.version} + 1` })
      .where(inArray(sourceDocuments.id, docIds));
    await tx
      .update(bundleSegments)
      .set({ publishedAt: now, updatedAt: now })
      .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)));
    await tx
      .update(sourceBundles)
      .set({
        assemblyVersion: 'logical_v1',
        publishedGeneration: generation,
        groupRevision: drSql`${sourceBundles.groupRevision} + 1`,
        status: 'parsed',
        updatedAt: now,
      })
      .where(eq(sourceBundles.id, rootId));

    return { action: 'publish' as const, docIds, reason: 'комплект готов' };
  });

  if (decision.action === 'none') {
    log.info({ reason: decision.reason }, 'сборка УПД: публикация отложена');
    return;
  }
  if (decision.action === 'rollback') {
    const [sub] = await db
      .select({ id: sourceBundles.id })
      .from(sourceBundles)
      .where(and(eq(sourceBundles.parentBundleId, rootId), eq(sourceBundles.kind, 'upd')))
      .limit(1);
    await rollbackUpdAssembly({
      rootId,
      subBundleId: sub?.id ?? null,
      generation,
      reason: decision.reason,
      log,
    });
    return;
  }

  // Дочерний пакет отработал: закрываем его и убираем служебную запись, чтобы
  // у него не осталось ни одного technical-документа.
  await finishAssemblySubBundle(rootId, 'parsed', log);
  await closeAssemblyRegistryRows(rootId, generation, decision.docIds, 'created');
  await recountGroupDocCount(rootId);

  for (const id of decision.docIds) await notifySourceDocumentUpdated(id);
  log.info({ documents: decision.docIds.length }, 'сборка УПД: поколение опубликовано');
}

/**
 * Откат на «файл = документ».
 *
 * Единый выход для всех неуспехов: классификация упала, нарезке нельзя
 * доверять, провайдер не тот, сегмент распознан неполно. Менеджер в худшем
 * случае видит ровно то, что видел бы без сборки.
 */
async function rollbackUpdAssembly(args: {
  rootId: string;
  subBundleId: string | null;
  generation: number;
  reason: string;
  log: WorkerLog;
}): Promise<void> {
  const { rootId, subBundleId, generation, reason, log } = args;
  log.warn({ reason, subBundleId }, 'сборка УПД: откат на «файл = документ»');

  // 1. Снимаем манифест и технические документы. Задания сегментов, ещё не
  //    доставленные в очередь, забираем сразу: fencing их всё равно обезвредит,
  //    но холостое задание занимает слот воркера с CONCURRENCY=1 и остаётся в
  //    outbox мусором. Уже доставленные (строки в outbox нет) отсекутся
  //    проверками loadSegmentContext.
  const removedDocIds = await db.transaction(async (tx) => {
    const segments = await tx
      .select({ id: bundleSegments.id, docId: bundleSegments.sourceDocumentId })
      .from(bundleSegments)
      .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)));
    const docIds = segments.map((s) => s.docId).filter((v): v is string => v !== null);
    if (segments.length > 0) {
      await tx.delete(jobOutbox).where(
        inArray(
          jobOutbox.dedupeKey,
          segments.map((s) => segmentDispatchKeyOf(s.id, generation)),
        ),
      );
    }
    await tx
      .delete(bundleSegments)
      .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)));
    if (docIds.length > 0) {
      // Документы технические — наружу они не выходили, поэтому tombstone не
      // нужен: клиенты их не видели и удалять у себя нечего.
      await tx.delete(sourceDocuments).where(inArray(sourceDocuments.id, docIds));
    }
    await tx
      .update(sourceBundles)
      .set({
        assemblyVersion: 'legacy',
        publishedGeneration: null,
        // Причина отката переживает уборку: llm_calls удаляются вместе с
        // документами сегментов, и без этой записи разбираться было бы не по
        // чему.
        parseErrorMessage: `сборка УПД отменена: ${reason}`.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(sourceBundles.id, rootId));
    return docIds;
  });

  // 2. Разворачиваем файлы прежним путём. Повторно звать router нельзя: его
  //    строки реестра уже в status='created', и он их пропустит.
  const [rootBundle] = await db
    .select()
    .from(sourceBundles)
    .where(eq(sourceBundles.id, rootId))
    .limit(1);
  if (!rootBundle) return;

  const rows = (await selectRegistryRows(db, rootId, generation)).filter(
    (r) => r.s3Key !== null && (subBundleId ? r.subBundleId === subBundleId : r.effectiveStatus === null),
  );
  const createdIds: string[] = [];
  for (const r of rows) {
    const file: RouterInputFile = {
      s3Key: r.s3Key as string,
      filename: r.filename,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      registryItemId: r.id,
      uploadGeneration: r.uploadGeneration,
      inputOrder: r.inputOrder ?? 0,
      status: r.status,
      processingMode: r.processingMode,
    };
    try {
      const docId = await createSingleUpdDocument({
        bundleId: rootId,
        bundle: rootBundle,
        bundleOrigin: rootBundle.origin ?? 'manual_pdf',
        bundleExpected:
          rootBundle.expectedDate instanceof Date
            ? rootBundle.expectedDate
            : rootBundle.expectedDate
              ? new Date(rootBundle.expectedDate)
              : null,
        file,
        cls: {
          detectedKind: 'upd',
          confidence: 0,
          needsVision: true,
          parserUsed: 'none',
          signals: ['assembly:rollback'],
        },
        reasonOverride: `сборка отменена (${reason}) → распознавание по файлу`,
      });
      createdIds.push(docId);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), file: r.filename },
        'сборка УПД: откат файла не удался',
      );
    }
  }

  await finishAssemblySubBundle(rootId, 'parse_failed', log);
  await recountGroupDocCount(rootId);
  log.info(
    { removed: removedDocIds.length, created: createdIds.length },
    'сборка УПД: откат завершён',
  );
}

/**
 * Закрывает дочерний пакет сборки и убирает его служебную запись.
 *
 * Служебных документов у дочернего пакета после завершения оставаться не
 * должно: они невидимы в интерфейсе, но живут в БД и мешают инварианту
 * «technical — это всегда идущая обработка».
 */
async function finishAssemblySubBundle(
  rootId: string,
  status: 'parsed' | 'parse_failed',
  log: WorkerLog,
): Promise<void> {
  const subs = await db
    .select({ id: sourceBundles.id })
    .from(sourceBundles)
    .where(and(eq(sourceBundles.parentBundleId, rootId), eq(sourceBundles.kind, 'upd')));
  for (const sub of subs) {
    await db.transaction(async (tx) => {
      await tx
        .delete(sourceDocuments)
        .where(and(eq(sourceDocuments.bundleId, sub.id), eq(sourceDocuments.isTechnical, true)));
      await tx
        .update(sourceBundles)
        .set({ status, updatedAt: new Date() })
        .where(eq(sourceBundles.id, sub.id));
    });
  }
  if (subs.length > 0) log.info({ subs: subs.length, status }, 'сборка УПД: дочерний пакет закрыт');
}

/**
 * Проставляет строкам реестра итоговый исход и созданные документы.
 *
 * Один документ попадает в несколько строк (страницы одной УПД сняты разными
 * кадрами), и наоборот — многостраничный PDF даёт несколько документов одной
 * строке. Поэтому список пишется целиком всем строкам сборки.
 */
async function closeAssemblyRegistryRows(
  rootId: string,
  generation: number,
  docIds: string[],
  effectiveStatus: 'created' | 'failed',
): Promise<void> {
  const rows = (await selectRegistryRows(db, rootId, generation)).filter(
    (r) => r.effectiveStatus === null && r.subBundleId !== null,
  );
  if (rows.length === 0) return;
  await db
    .update(bundleImportItems)
    .set({ effectiveStatus, createdDocumentIds: docIds, updatedAt: new Date() })
    .where(
      inArray(
        bundleImportItems.id,
        rows.map((r) => r.id),
      ),
    );
}

/**
 * Пересчитывает число документов группы.
 *
 * Считается по всем нетехническим документам корневого и дочерних пакетов:
 * накладная или М-15 может закончиться позже сборки (ретрай), и зафиксировать
 * счётчик один раз значило бы показать заниженное число.
 */
async function recountGroupDocCount(rootId: string): Promise<void> {
  const [row] = await db
    .select({ n: drSql<number>`count(*)::int` })
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.isTechnical, false),
        or(
          eq(sourceDocuments.bundleId, rootId),
          drSql`${sourceDocuments.bundleId} in (select id from source_bundles where parent_bundle_id = ${rootId})`,
        ),
      ),
    );
  await db
    .update(sourceBundles)
    .set({ docCount: row?.n ?? 0, updatedAt: new Date() })
    .where(eq(sourceBundles.id, rootId));
}

// «Пустой» UpdPdfParsed для Excel-кейса, когда структурный парсер
// не нашёл ничего, а Vision fallback недоступен (LibreOffice не
// установлен в окружении). Документ записывается с partial_parse
// и пустыми позициями, пользователь добавит вручную через UI.
// confidence=0.01: не валидно для dedup (порог MIN_DEDUP_CONFIDENCE
// = 0.6), значит дубли не сработают.
function emptyParsed(): UpdPdfParsed {
  return {
    docNumber: null,
    docDate: null,
    totalSum: null,
    vatSum: null,
    itemsCount: null,
    supplier: null,
    recipient: null,
    items: [],
    confidence: 0.01,
  };
}

// Защищённый парс docDate от LLM. Промпт просит YYYY-MM-DD, но в проде
// встречалось DD.MM.YYYY и прочие форматы — `new Date('06.05.2026')` даёт
// Invalid Date и валит весь INSERT с RangeError: Invalid time value.
function parseLlmDocDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  // Каноническая форма из промпта.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // DD.MM.YYYY — частый формат на русских накладных.
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (m) {
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Прочие — пробуем Date.parse как best-effort; невалидные → null.
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Создаёт одну запись source_documents из распознанного WaybillDocument
// (ТН или ОС-2), прикрепляет attachments пакета и items позиций.
// Возвращает id созданного source_document.
async function createSourceDocumentFromWaybill(args: {
  doc: WaybillDocument;
  bundleId: string;
  bundle: typeof sourceBundles.$inferSelect;
  llmProviderId: string | null;
  attachments: { s3Key: string; filename: string; mimeType: string | null; sizeBytes: number | null }[];
}): Promise<string> {
  const { doc, bundleId, bundle, llmProviderId, attachments } = args;

  // Контрагенты ТН-2116:
  //   - shipper (поставщик/отправитель) → сравниваем со справочником
  //     `suppliers`. Совпало по ИНН или fuzzy-name → переиспользуем; не
  //     совпало → INSERT в справочник. В counterparties для shipper ничего
  //     не пишем (см. supplierMatcher.ts, миграция 0064).
  //   - consignee (грузополучатель) → сторона ДОКУМЕНТА: consignee_id +
  //     consignee_name_raw. Раньше он писался в recipient_id, но recipient —
  //     операционный получатель отгрузки (его выбирает человек), и колонка
  //     «Покупатель» показывала бы грузополучателя накладной. Смена безопасна:
  //     на бою recipient_id пуст у всех накладных — путь не срабатывал ни разу
  //     (условие inn && name, а ИНН в разделе 2 распознаётся редко).
  //   - ОС-2 (внутреннее перемещение) — обе стороны внутренние, supplier_id
  //     остаётся NULL.
  let supplierDirectoryId: string | null = null;
  let consigneeId: string | null = null;
  let consigneeNameRaw: string | null = null;
  // ИНН сторон накладной. У ОС-2 обе стороны внутренние и ИНН у них нет вовсе
  // (WaybillInternalPartySchema — только name/department), поэтому поля
  // остаются null и заполняются лишь в ветке ТН-2116.
  let supplierInnRaw: string | null = null;
  let consigneeInnRaw: string | null = null;
  if (doc.form === 'tn_2116') {
    if (doc.shipper?.inn || doc.shipper?.name) {
      const match = await matchOrCreateSupplier(
        { db },
        {
          inn: doc.shipper.inn ?? null,
          kpp: null,
          name: doc.shipper.name ?? null,
        },
      );
      supplierDirectoryId = match?.id ?? null;
      supplierInnRaw = doc.shipper.inn ?? null;
    }
    consigneeNameRaw = doc.consignee?.name ?? null;
    consigneeInnRaw = doc.consignee?.inn ?? null;
    if (doc.consignee?.inn && doc.consignee?.name) {
      consigneeId = await findOrCreateCounterparty(
        { inn: doc.consignee.inn, kpp: null, name: doc.consignee.name },
        'customer',
      );
    }
  }

  const docDate = parseLlmDocDate(doc.docDate);
  const kind = doc.form === 'os2' ? 'os2_transfer' : 'transport_waybill';

  // Защита от несоответствия типов: bundle.expectedDate может прийти как
  // строка 'YYYY-MM-DD' (исторически — если колонка осталась типа PG date
  // до миграции 0043) или как Date. Приводим к Date или null.
  const bundleExpected =
    bundle.expectedDate instanceof Date
      ? bundle.expectedDate
      : bundle.expectedDate
        ? new Date(bundle.expectedDate)
        : null;

  const [inserted] = await db
    .insert(sourceDocuments)
    .values({
      kind,
      direction: bundle.direction,
      status: 'parsed',
      // Поставщик ТН-2116 живёт в справочнике (supplier_directory_id), не в
      // counterparties — см. supplierMatcher и миграцию 0064. supplier_id
      // оставляем NULL; DTO supplierName собирается через COALESCE.
      supplierId: null,
      supplierDirectoryId,
      supplierInnRaw,
      consigneeId,
      consigneeNameRaw,
      consigneeInnRaw,
      contractorId: bundle.contractorId,
      recipientMolId: bundle.recipientMolId,
      recipientSource: manualRecipientSource(bundle),
      siteId: bundle.siteId,
      docNumber: doc.docNumber ?? null,
      docDate,
      totalSum: doc.totalSum != null ? doc.totalSum.toString() : null,
      expectedDate: bundleExpected,
      // Наследуем от пакета: накладная из письма остаётся почтовой.
      origin: bundle.origin ?? 'manual_pdf',
      llmProviderId,
      llmConfidence: doc.confidence.toString(),
      parsedAt: new Date(),
      processedAt: new Date(),
      bundleId,
      createdByUserId: bundle.createdByUserId,
    })
    .returning({ id: sourceDocuments.id });
  if (!inserted) throw new Error('Failed to insert source_document from waybill');
  const id = inserted.id;

  // Дублируем attachments на каждый созданный документ. S3-файл общий
  // (один объект в bucket), а в junction-таблице — новые строки.
  if (attachments.length > 0) {
    await db.insert(sourceDocumentAttachments).values(
      attachments.map((a) => ({
        sourceDocumentId: id,
        s3Key: a.s3Key,
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        role: 'original' as const,
      })),
    );
  }

  // Позиции документа. Для ОС-2 — invNumber + price/sum; для ТН — без них.
  if (doc.items.length > 0) {
    const rows = await Promise.all(
      doc.items.map(async (it, idx) => ({
        sourceDocumentId: id,
        materialId:
          kind === 'transport_waybill'
            ? await findOrCreateMaterial(it.nameRaw, it.unit ?? null)
            : null,
        nameRaw: it.nameRaw,
        qty: it.qty != null ? it.qty.toString() : '0',
        unit: it.unit && it.unit.trim() ? it.unit.trim() : 'шт',
        price: it.price != null ? it.price.toString() : null,
        sum: it.sum != null ? it.sum.toString() : null,
        vatRate: null,
        vatSum: null,
        volumeM3: null,
        massKg: null,
        volumeConfidence: null,
        groupName: null,
        lineNo: idx + 1,
        inventoryNumber: it.invNumber ?? null,
      })),
    );
    await db.insert(sourceDocumentItems).values(rows);
  }

  return id;
}

async function handleS3Cleanup(job: Job<S3CleanupJobData>): Promise<void> {
  const { s3Keys } = job.data;
  const log = logger.child({ jobId: job.id, queue: S3_CLEANUP_QUEUE });
  if (!s3Keys || s3Keys.length === 0) return;

  const results = await Promise.allSettled(s3Keys.map((k) => deleteObject(k)));
  let failed = 0;
  results.forEach((r, idx) => {
    if (r.status === 'rejected') {
      failed += 1;
      log.warn({ err: r.reason, s3Key: s3Keys[idx] }, 's3 delete failed');
    }
  });
  // Если все ключи зафейлились — это похоже на проблему с S3-доступом
  // в целом, имеет смысл повторить задачу. Если часть успешна — БД и
  // так уже консистентна, считаем успехом.
  if (failed === s3Keys.length) {
    throw new Error(`all ${failed} s3 deletions failed`);
  }
  log.info({ total: s3Keys.length, failed }, 's3 cleanup done');
}

// ─── S3 cleanup outbox consumer (Волна 1D) ──────────────────────────────────
// Надёжная дочистка S3 при удалении приёмок/отгрузок. Задания пишутся в
// s3_cleanup_outbox В ОДНОЙ транзакции с удалением операции (см. routes), поэтому
// не зависят от доступности Redis в момент удаления. Здесь обрабатываем батчами:
// FOR UPDATE SKIP LOCKED → пометка processing_at (лизинг) → идемпотентный DELETE
// объекта в S3 → успех: строка удаляется; ошибка: attempts++ и next_attempt_at
// с backoff. Зависшие processing (краш воркера) возвращаются в очередь по лизингу.
const OUTBOX_BATCH = 50;
const OUTBOX_LEASE_MS = 5 * 60 * 1000;
const OUTBOX_MAX_ATTEMPTS = 12;
const OUTBOX_INTERVAL_MS = 15 * 1000;

async function processS3CleanupOutbox(): Promise<void> {
  const log = logger.child({ task: 's3-cleanup-outbox' });
  const now = new Date();
  const leaseCutoff = new Date(now.getTime() - OUTBOX_LEASE_MS);

  // 1) Атомарно забираем батч готовых строк и помечаем processing_at.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: s3CleanupOutbox.id,
        s3Key: s3CleanupOutbox.s3Key,
        attempts: s3CleanupOutbox.attempts,
      })
      .from(s3CleanupOutbox)
      .where(
        and(
          lte(s3CleanupOutbox.nextAttemptAt, now),
          or(isNull(s3CleanupOutbox.processingAt), lt(s3CleanupOutbox.processingAt, leaseCutoff)),
        ),
      )
      .orderBy(s3CleanupOutbox.createdAt)
      .limit(OUTBOX_BATCH)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return [] as typeof rows;
    await tx
      .update(s3CleanupOutbox)
      .set({ processingAt: now })
      .where(
        inArray(
          s3CleanupOutbox.id,
          rows.map((r) => r.id),
        ),
      );
    return rows;
  });
  if (claimed.length === 0) return;

  // 2) Вне транзакции удаляем каждый ключ (идемпотентно: DELETE отсутствующего
  //    объекта в S3 = успех). Успех → строка убирается; ошибка → backoff.
  let ok = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      await deleteObject(row.s3Key);
      await db.delete(s3CleanupOutbox).where(eq(s3CleanupOutbox.id, row.id));
      ok += 1;
    } catch (err) {
      failed += 1;
      const attempts = row.attempts + 1;
      const parked = attempts >= OUTBOX_MAX_ATTEMPTS;
      const backoffMs = Math.min(2 ** attempts * 1000, 60 * 60 * 1000);
      const nextAttemptAt = new Date(Date.now() + (parked ? 24 * 60 * 60 * 1000 : backoffMs));
      await db
        .update(s3CleanupOutbox)
        .set({
          attempts,
          nextAttemptAt,
          lastError: err instanceof Error ? err.message : String(err),
          processingAt: null,
        })
        .where(eq(s3CleanupOutbox.id, row.id));
      log.warn({ err, s3Key: row.s3Key, attempts, parked }, 's3 cleanup outbox delete failed');
    }
  }
  log.info({ ok, failed }, 's3 cleanup outbox batch done');
}

// Экспортируется ради теста: проверяется, что возвращённый в очередь документ
// получает тот же ключ задания, что и подбор зависших записей.
export async function recoverStaleProcessing(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  const stale = await db
    .select({ id: sourceDocuments.id, secondPass: sourceDocuments.secondPass })
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.status, 'processing'), lt(sourceDocuments.updatedAt, cutoff)));
  if (stale.length === 0) return;
  await db
    .update(sourceDocuments)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(
      inArray(
        sourceDocuments.id,
        stale.map((s) => s.id),
      ),
    );
  // Сегменты сборки восстанавливаются СВОИМ заданием: файла у них нет, работу
  // адресует строка манифеста. Обычное задание по s3Key вернуло бы документ на
  // одиночный путь — он распознал бы одну страницу вместо всего логического
  // УПД и потерял бы остальные позиции.
  const segmentsById = new Map(
    (
      await db
        .select({
          docId: bundleSegments.sourceDocumentId,
          segmentId: bundleSegments.id,
          generation: bundleSegments.generation,
        })
        .from(bundleSegments)
        .where(
          inArray(
            bundleSegments.sourceDocumentId,
            stale.map((s) => s.id),
          ),
        )
    ).map((r) => [r.docId as string, r]),
  );

  // Точечная постановка джобов: для каждой записи берём S3-ключ из её
  // attachments (роль original) и кладём в очередь заново.
  for (const s of stale) {
    const segment = segmentsById.get(s.id);
    if (segment) {
      const dedupeKey = segmentDispatchKeyOf(segment.segmentId, segment.generation);
      await db.transaction(async (tx) => {
        await tx
          .update(sourceDocuments)
          .set({ jobId: dedupeKey })
          .where(eq(sourceDocuments.id, s.id));
        await enqueueJob(tx as unknown as typeof db, {
          queue: UPD_PARSE_QUEUE,
          jobName: 'parse',
          payload: {
            sourceDocumentId: s.id,
            segmentId: segment.segmentId,
            generation: segment.generation,
          },
          dedupeKey,
        });
      });
      continue;
    }
    const [att] = await db.execute(
      drSql`select s3_key from source_document_attachments
            where source_document_id = ${s.id} and role = 'original'
            order by created_at desc limit 1`,
    );
    const s3Key = (att as { s3_key?: string } | undefined)?.s3_key;
    if (s3Key) {
      // Через outbox и под ТЕМ ЖЕ ключом, что использует подбор зависших
      // записей. Раньше здесь стоял прямой queue.add без jobId: задание
      // получало случайный идентификатор, и если документ снова застревал в
      // queued, repair добавлял второе — документ распознавался дважды.
      // Второй проход восстанавливаем вторым проходом: обычное задание вернуло
      // бы документ на текстовый путь, который уже дал слабый результат.
      const pendingSecondPass = (s.secondPass as { state?: string } | null)?.state === 'queued';
      const dedupeKey = pendingSecondPass ? documentSecondPassKeyOf(s.id) : dispatchKeyOf(s.id);
      await db.transaction(async (tx) => {
        await tx
          .update(sourceDocuments)
          .set({ jobId: dedupeKey })
          .where(eq(sourceDocuments.id, s.id));
        await enqueueJob(tx as unknown as typeof db, {
          queue: UPD_PARSE_QUEUE,
          jobName: 'parse',
          payload: pendingSecondPass
            ? { sourceDocumentId: s.id, s3Key, pass: 'vision' as const }
            : { sourceDocumentId: s.id, s3Key },
          dedupeKey,
        });
      });
    }
  }
  logger.warn({ count: stale.length }, 'recovered stale processing documents');
}

const connection = buildQueueConnection();

// Лёгкий клиент к собственной очереди, чтобы recovery мог положить
// потерянные джобы обратно.
//
// defaultJobOptions обязательны: через этот экземпляр идёт ВЕСЬ outbox —
// публичная загрузка, почта, дочерние задания router'а, второй проход. Без них
// BullMQ берёт свой дефолт attempts=0, и любая транзиентная ошибка сразу давала
// parse_failed без единой повторной попытки.
const queue = new Queue<UpdParseJobData>(UPD_PARSE_QUEUE, {
  connection,
  defaultJobOptions: UPD_PARSE_JOB_OPTIONS,
});

const worker = new Worker<UpdParseJobData>(
  UPD_PARSE_QUEUE,
  async (job) => {
    try {
      await handleJob(job);
    } finally {
      // Внешний finally для сегментов сборки. У handleJob несколько ранних
      // выходов — дубликат, таймаут vision, «документ исчез», — и если
      // публиковать только из «счастливого» конца, комплект, где один сегмент
      // ушёл по такой ветке, остался бы неопубликованным навсегда: технические
      // документы есть, а видимых нет.
      if ('segmentId' in job.data && job.data.segmentId) {
        try {
          const [seg] = await db
            .select({ rootId: bundleSegments.bundleId, generation: bundleSegments.generation })
            .from(bundleSegments)
            .where(eq(bundleSegments.id, job.data.segmentId))
            .limit(1);
          if (seg) await tryFinalizeUpdAssembly(seg.rootId, seg.generation, logger);
        } catch (err) {
          // Финализация — не повод потерять исходную ошибку задания.
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'сборка УПД: финализация после задания не удалась',
          );
        }
      }
    }
  },
  {
    connection,
    concurrency: CONCURRENCY,
  },
);

// Второй воркер — асинхронная чистка S3-объектов при удалении документов.
// Концурренси выше — операции лёгкие (один DELETE-запрос к S3 на ключ).
const S3_CLEANUP_CONCURRENCY = 4;
const s3CleanupWorker = new Worker<S3CleanupJobData>(
  S3_CLEANUP_QUEUE,
  handleS3Cleanup,
  { connection, concurrency: S3_CLEANUP_CONCURRENCY },
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  logger.warn({ jobId: job.id, attempts: job.attemptsMade, err: err.message }, 'job failed');
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
  // Все попытки исчерпаны — репортим в Sentry (payload не прикладываем, только ид/очередь).
  Sentry.captureException(err, {
    tags: { queue: UPD_PARSE_QUEUE },
    extra: { jobId: job.id, attempts: job.attemptsMade },
  });
  try {
    // Сборка не смогла даже начаться — файлы не должны застрять в дочернем
    // пакете. Откат разворачивает их прежним путём, поэтому общий обработчик
    // ошибки пакета (ниже) сюда не годится: он просто пометил бы пакет
    // parse_failed, и файлы исчезли бы из виду.
    if ('mode' in job.data && job.data.mode === 'upd_assembly' && job.data.bundleId) {
      const subId = job.data.bundleId;
      const [sub] = await db
        .select({ parentId: sourceBundles.parentBundleId })
        .from(sourceBundles)
        .where(eq(sourceBundles.id, subId))
        .limit(1);
      if (sub?.parentId) {
        await rollbackUpdAssembly({
          rootId: sub.parentId,
          subBundleId: subId,
          generation: job.data.generation,
          reason: `задание сборки не выполнилось: ${err.message}`,
          log: logger,
        });
      }
      return;
    }

    // Сегмент исчерпал попытки: помечаем документ и передаём решение
    // финализатору — он либо опубликует остальные (если этот единственный
    // сломанный), либо откатит весь комплект.
    if ('segmentId' in job.data && job.data.segmentId && job.data.sourceDocumentId) {
      const docId = job.data.sourceDocumentId;
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'internal_error',
          parseErrorDetails: { message: err.message },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, docId));
      const [seg] = await db
        .select({ rootId: bundleSegments.bundleId, generation: bundleSegments.generation })
        .from(bundleSegments)
        .where(eq(bundleSegments.id, job.data.segmentId))
        .limit(1);
      if (seg) await tryFinalizeUpdAssembly(seg.rootId, seg.generation, logger);
      return;
    }

    if ('bundleId' in job.data && job.data.bundleId) {
      const bundleId = job.data.bundleId;
      await db
        .update(sourceBundles)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'internal_error',
          parseErrorMessage: err.message,
          updatedAt: new Date(),
        })
        .where(eq(sourceBundles.id, bundleId));
      // Пакет мог быть дочерним (накладная из router'а): без этой отметки
      // родительская строка реестра осталась бы в created и файл исчез бы из
      // виду. Для не-дочернего пакета обновлять нечего — запрос ничего не
      // найдёт.
      await markSubBundleItemFailed(
        bundleId,
        `разбор накладной не удался: ${err.message}`,
        logger,
      );
      // Строки самого пакета, не дошедшие до терминального решения (краш
      // router-job в середине пачки), тоже нельзя оставлять «в процессе».
      await closeStaleRegistryItems(bundleId, logger, {
        reason: 'разбор пакета не удался — файл не дошёл до распознавания',
      });
      // Помечаем и техническую source_document, если она ещё жива. Именно
      // техническую: реальные документы пакета разобрались успешно, метить их
      // ошибкой нельзя.
      const [tech] = await db
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(and(eq(sourceDocuments.bundleId, bundleId), eq(sourceDocuments.isTechnical, true)))
        .limit(1);
      if (tech) {
        await db
          .update(sourceDocuments)
          .set({
            status: 'parse_failed',
            parseErrorCode: 'internal_error',
            parseErrorDetails: { message: err.message },
            processedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(sourceDocuments.id, tech.id));
        await notifySourceDocumentUpdated(tech.id);
      }
      return;
    }
    if (job.data.sourceDocumentId) {
      // Второй проход — попытка УЛУЧШИТЬ уже сохранённый разбор. Его крах не
      // повод обнулять результат первого прохода: документ мог быть вполне
      // рабочим. Помечаем попытку завершённой и оставляем данные как есть;
      // parse_failed остаётся только для документов, у которых сохранять
      // нечего (первый проход не дал ни позиций, ни номера).
      if ('pass' in job.data && job.data.pass === 'vision') {
        const [doc] = await db
          .select({ docNumber: sourceDocuments.docNumber, status: sourceDocuments.status })
          .from(sourceDocuments)
          .where(eq(sourceDocuments.id, job.data.sourceDocumentId))
          .limit(1);
        const [item] = await db
          .select({ id: sourceDocumentItems.id })
          .from(sourceDocumentItems)
          .where(eq(sourceDocumentItems.sourceDocumentId, job.data.sourceDocumentId))
          .limit(1);
        const baselineEmpty = !doc || (doc.docNumber == null && !item);
        await db
          .update(sourceDocuments)
          .set({
            secondPass: {
              state: 'done',
              mode: 'vision',
              outcome: 'vision_failed',
              error: err.message,
              finishedAt: new Date().toISOString(),
            },
            ...(baselineEmpty
              ? {
                  status: 'parse_failed' as const,
                  parseErrorCode: 'internal_error' as const,
                  parseErrorDetails: { message: err.message, reason: 'second_pass_failed' },
                  processedAt: new Date(),
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(sourceDocuments.id, job.data.sourceDocumentId));
        await notifySourceDocumentUpdated(job.data.sourceDocumentId);
        return;
      }
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'internal_error',
          parseErrorDetails: { message: err.message },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, job.data.sourceDocumentId));
      await notifySourceDocumentUpdated(job.data.sourceDocumentId);
    }
  } catch (e) {
    logger.error({ err: e }, 'failed to mark document as parse_failed');
  }
});

worker.on('completed', (job) => {
  logger.info({ jobId: job.id }, 'job completed');
});

s3CleanupWorker.on('failed', (job, err) => {
  if (!job) return;
  logger.warn(
    { jobId: job.id, queue: S3_CLEANUP_QUEUE, attempts: job.attemptsMade, err: err.message },
    's3 cleanup job failed',
  );
  // Cloud.ru бывает flaky (см. s3.signer ретрай) — репортим только исчерпание попыток.
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    Sentry.captureException(err, {
      tags: { queue: S3_CLEANUP_QUEUE },
      extra: { jobId: job.id, attempts: job.attemptsMade },
    });
  }
});

s3CleanupWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: S3_CLEANUP_QUEUE }, 's3 cleanup job completed');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  await worker.close().catch(() => undefined);
  await s3CleanupWorker.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
  await Sentry.flush(2000).catch(() => undefined); // дослать буфер до выхода
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

logger.info(
  {
    queues: [UPD_PARSE_QUEUE, S3_CLEANUP_QUEUE],
    concurrency: { [UPD_PARSE_QUEUE]: CONCURRENCY, [S3_CLEANUP_QUEUE]: S3_CLEANUP_CONCURRENCY },
  },
  'worker started',
);
void recoverStaleProcessing().catch((err) =>
  logger.error({ err }, 'recoverStaleProcessing failed'),
);

// Periodic photo-orphan cleanup. Запись в delivery_photos / shipment_photos
// создаётся ДО PUT в S3 — без последующего confirm она остаётся orphan'ом.
// Раз в час делаем S3.HEAD и либо проставляем uploaded_at, либо удаляем.
// Первый запуск — через 5 мин от старта (даём клиентам, висевшим на старом
// presign-URL, время подтвердить).
const PHOTO_ORPHAN_INTERVAL_MS = 60 * 60 * 1000;
const PHOTO_ORPHAN_DELAY_MS = 5 * 60 * 1000;
setTimeout(() => {
  void cleanupPhotoOrphans(logger).catch((err) =>
    logger.error({ err }, 'photo orphan cleanup failed'),
  );
  setInterval(() => {
    void cleanupPhotoOrphans(logger).catch((err) =>
      logger.error({ err }, 'photo orphan cleanup failed'),
    );
  }, PHOTO_ORPHAN_INTERVAL_MS).unref();
}, PHOTO_ORPHAN_DELAY_MS).unref();

// Periodic S3 cleanup outbox consumer (Волна 1D). Первый прогон через 10с от
// старта, далее каждые 15с. unref — не держит процесс при завершении.
setTimeout(() => {
  void processS3CleanupOutbox().catch((err) =>
    logger.error({ err }, 's3 cleanup outbox failed'),
  );
  setInterval(() => {
    void processS3CleanupOutbox().catch((err) =>
      logger.error({ err }, 's3 cleanup outbox failed'),
    );
  }, OUTBOX_INTERVAL_MS).unref();
}, 10 * 1000).unref();

// Periodic job outbox consumer: доставляет в BullMQ задания, записанные в одной
// транзакции с документами (router и приём писем). Пустой батч не делает ничего
// и не логируется. Первый прогон через 12с от старта (со сдвигом относительно
// s3-cleanup, чтобы две периодики не будили БД одновременно).
setTimeout(() => {
  const runJobOutbox = () =>
    void processJobOutbox({
      db,
      queues: { [UPD_PARSE_QUEUE]: queue },
      log: logger.child({ task: 'job-outbox' }),
    }).catch((err) => logger.error({ err }, 'job outbox consumer failed'));
  runJobOutbox();
  setInterval(runJobOutbox, JOB_OUTBOX_INTERVAL_MS).unref();
}, 12 * 1000).unref();

// Подбор записей, застрявших в queued без задания. Outbox закрывает разрыв
// «БД записала — Redis не принял», но не случай «задание доставлено и потеряно
// вместе с воркером». Раз в 10 минут, порог 45 минут — при CONCURRENCY=1
// запись законно ждёт своей очереди долго. Первый прогон через минуту:
// сразу после старта очередь ещё разбирается, торопиться некуда.
setTimeout(() => {
  const runRepair = () =>
    void repairStuckJobs({
      db,
      queue: UPD_PARSE_QUEUE,
      log: logger.child({ task: 'stuck-jobs' }),
    }).catch((err) => logger.error({ err }, 'stuck jobs repair failed'));
  runRepair();
  setInterval(runRepair, STUCK_INTERVAL_MS).unref();
}, 60 * 1000).unref();
