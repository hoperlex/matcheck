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
import { and, desc, eq, inArray, isNull, lt, lte, notInArray, or } from 'drizzle-orm';
import {
  markSourceDocumentContentChanged,
  publishGroupDocuments,
} from './domain/sourceDocuments/document-group.js';
import { recordVisibilityTransitions } from './domain/sourceDocuments/visibility-events.js';
import { logger } from './lib/logger.js';
import { installFatalHandlers } from './lib/fatal-visibility.js';
import { imageMimeOfKey } from './lib/image-kind.js';
import { db } from './db/client.js';
import type { Db } from './db/client.js';
import { resolveMachineSiteId } from './domain/sourceDocuments/site-transfer.js';
import { resolveMachineExpectedDate } from './domain/sourceDocuments/expected-date-transfer.js';
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
import { manualRecipientSource } from './domain/sourceDocuments/resolve-contractor.js';
import {
  consigneeOwnIdentity,
  normalizePartyForDirectory,
} from './domain/sourceDocuments/party-directory-guard.js';
import { nameBeforeAddress } from './domain/edo/upd-party-text.js';
import {
  buildQueueConnection,
  S3_CLEANUP_QUEUE,
  UPD_PARSE_QUEUE,
  UPD_PARSE_JOB_OPTIONS,
  UPD_PARSE_WORKER_OPTIONS,
  type S3CleanupJobData,
  type UpdParseJobData,
} from './plugins/queue.js';
import { deleteObject, getObject } from './domain/storage/s3.signer.js';
import { parseUpdPdf, PdfNoTextError, PdfTextGarbageError } from './domain/edo/upd-pdf.parser.js';
import {
  parseUpdVision,
  PdfRenderError,
  PdfRenderTimeoutError,
  VisionBudgetExceededError,
  VisionPayloadTooLargeError,
  VisionTimeoutError,
} from './domain/edo/upd-vision.parser.js';
import { tryParseUpdBundle } from './domain/edo/upd-bundle.parser.js';
import { tryParseTextUpdBundle } from './domain/edo/upd-text-bundle.parser.js';
import { parseUpdXlsx } from './domain/edo/upd-xlsx.parser.js';
import { convertXlsToXlsxBuffer, XlsConvertError } from './domain/edo/xls-to-xlsx.js';
import {
  convertExcelToPdf,
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
// Значение живёт в domain/edo/upd-validation.ts — см. импорт ниже.
import {
  parseWaybillBatch,
  type ParseWaybillBatchResult,
  type WaybillInputImage,
} from './domain/edo/waybill-batch.parser.js';
import {
  expandPdfAttachmentsForOpenRouter,
  WAYBILL_1T_MAX_PAGES_FOR_OPENROUTER,
} from './domain/edo/waybill-pdf.js';
import { detectWaybill1t } from './domain/edo/waybill-1t-detect.js';
import { getDefaultProviderKind } from './domain/llm/registry.js';
import { cleanupPhotoOrphans } from './domain/jobs/photo-orphan-cleanup.js';
import {
  MIN_DEDUP_CONFIDENCE,
  mergePersistentUpdWarnings,
  validateUpdTotals,
} from './domain/edo/upd-validation.js';
import {
  buildRepairHint,
  decideSegmentRepair,
  preserveDocumentIdentity,
} from './domain/edo/segment-repair-arbiter.js';
import { deriveUpdParseOutcome } from './domain/edo/upd-outcome.js';
import { chooseBetterUpdResult, mergeParties } from './domain/edo/upd-result-compare.js';
import { normalizeM15ZeroTotals } from './domain/edo/m15-normalize.js';
import { normalizeLineVatAgainstHeader } from './domain/edo/vat-rate-normalize.js';
import { verdictForDuplicate, type DuplicateVerdict } from './domain/edo/duplicate-verdict.js';
import { normalizeUpdNoPricingTotals } from './domain/edo/upd-no-pricing-normalize.js';
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
  markSubBundleItemDocumented,
  markSubBundleItemsFailed,
  selectRegistryRows,
} from './domain/sourceDocuments/bundle-import-registry.js';
import {
  ensureDocumentForRegistryRow,
  selectRowsWithoutDocument,
  stubReasonForRow,
} from './domain/sourceDocuments/stub-documents.js';
import { finalizeBundleTerminalState } from './domain/sourceDocuments/bundle-finalize.js';
import { selectUnreferencedS3Keys } from './domain/sourceDocuments/s3-key-usage.js';
import { classifyImageKind } from './domain/edo/vision-classifier.js';
import {
  assemblyDispatchKeyOf,
  segmentRepairKeyOf,
  bundleDispatchKeyOf,
  documentSecondPassKeyOf,
  dispatchKeyOf,
  enqueueJob,
  processJobOutbox,
  segmentDispatchKeyOf,
  OUTBOX_INTERVAL_MS as JOB_OUTBOX_INTERVAL_MS,
} from './domain/jobs/job-outbox.js';
import { loadEnv } from './lib/env.js';
import { bundleSegments, ingestEvents, jobOutbox, recognitionEvidenceEvents } from './db/schema.js';
import {
  classifyPages,
  PAGE_CLASSIFY_WITH_NUMBER_PROMPT,
  type PageClassification,
} from './domain/edo/upd-page-prefilter.js';
import {
  differentDocNumber,
  findNumberGaps,
  normalizeDocNumber,
} from './domain/edo/upd-doc-number.js';
import { imageToVisionPage, renderPdf, toClassifyThumb } from './domain/edo/page-render.js';
import {
  mergeClassificationChunks,
  pageRefsOfSegment,
  planUpdSegments,
  rollbackKindsByFile,
  type AssemblyPage,
  type PageRef,
} from './domain/edo/upd-assembly.js';
import { extractUpdSegment } from './domain/edo/upd-segment-extract.js';
import {
  planAssemblyDocumentMerges,
  planAssemblyDocumentMergesLegacy,
} from './domain/edo/upd-assembly-merge.js';
import { resolveRootBundle } from './domain/sourceDocuments/bundle-import-registry.js';
import { llmCalls, llmProviders, llmProviderCredentials } from './db/schema.js';
import { buildAad, decryptField } from './domain/auth/crypto.js';
import { repairStuckJobs, STUCK_INTERVAL_MS } from './domain/jobs/stuck-jobs.js';
import type {
  SourceStatus,
  UpdPdfParsed,
  UpdValidation,
  UpdWarning,
  WaybillDocument,
} from '@matcheck/contracts';

// Падение процесса обязано оставлять след в логе и в Sentry — см.
// lib/fatal-visibility.ts (инцидент 21.08: 854 немых рестарта API).
installFatalHandlers('worker');

// Хелпер: уведомляем подключённых SSE-клиентов о смене статуса УПД через
// Redis Pub/Sub (worker в отдельном процессе, in-process bus API ему
// недоступен). Без него мобила узнавала о готовности новой УПД только
// через 15-минутный periodic sync.
//
// siteId достаём здесь, а не в двадцати двух местах вызова: /events отдаёт
// инспектору только события его объекта, а распознавание — самый частый
// источник событий вообще. Оставь мы его глобальным, шторм триггеров уцелел
// бы наполовину, ради чего вся правка и делается. Один запрос по первичному
// ключу дешевле любого из шагов распознавания, а место вызова о скоупе знать
// не обязано.
//
// Документа может не оказаться (успели удалить, пока шёл job) — тогда шлём
// без siteId: событие уедет всем, как раньше. Терять уведомление из-за
// пропавшей строки хуже, чем разослать лишнее.
async function notifySourceDocumentUpdated(sourceDocumentId: string): Promise<void> {
  const [doc] = await db
    .select({ siteId: sourceDocuments.siteId })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.id, sourceDocumentId))
    .limit(1);
  await publishSseEvent({
    type: 'source_document_updated',
    entityId: sourceDocumentId,
    ...(doc?.siteId ? { siteId: doc.siteId } : {}),
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

/**
 * Контрагент под распознанную сторону документа: найти существующего, иначе
 * завести нового — но только если сторона прошла валидацию.
 *
 * Порядок шагов принципиален, и менять его нельзя:
 *
 *   1. поиск по ключу «ИНН как пришёл + КПП» — ровно как было до гарда. Иначе
 *      документы перестали бы привязываться к историческим записям с
 *      невалидным ИНН (их в справочнике уже с десяток), то есть правка,
 *      задуманная как защита, сама стала бы регрессом;
 *   2. поиск по нормализованному ИНН — лечит дубли от пробелов и разделителей
 *      в ответе модели («77 36 25 55 08» и «7736255508» — одна организация);
 *   3. и только СОЗДАНИЕ закрыто гардом: невалидный ИНН или имя-обрывок →
 *      возвращаем null, ничего не вставляя.
 *
 * null означает лишь «связи со справочником нет». Распознанное не теряется:
 * *_name_raw и *_inn_raw пишутся из сырого ответа независимо от этой функции.
 */
async function findOrCreateCounterparty(
  party: { inn: string; kpp: string | null; name: string },
  role: 'supplier' | 'customer',
): Promise<string | null> {
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

  const normalized = normalizePartyForDirectory(party);
  if (!normalized) {
    logger.warn(
      { inn: party.inn, name: party.name, role },
      'counterparty not created: party failed directory validation',
    );
    return null;
  }

  // Второй заход по нормализованному ключу: строка «77 36 25 55 08» не нашлась
  // точным сравнением на шаге 1, но организация в справочнике уже есть.
  if (normalized.inn !== party.inn || normalized.kpp !== party.kpp) {
    const byNormalized = await db
      .select({ id: counterparties.id })
      .from(counterparties)
      .where(
        and(
          eq(counterparties.inn, normalized.inn),
          normalized.kpp
            ? eq(counterparties.kpp, normalized.kpp)
            : drSql`${counterparties.kpp} is null`,
        ),
      )
      .limit(1);
    if (byNormalized[0]) return byNormalized[0].id;
  }

  const [created] = await db
    .insert(counterparties)
    .values({
      inn: normalized.inn,
      kpp: normalized.kpp,
      name: normalized.name,
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
  | 'segment_vision'
  // Накладная (ТН/ОС-2), разобранная пакетным parseWaybillBatch. Ставится не
  // здесь, а в createSourceDocumentFromWaybill: у пакетного пути свой обработчик.
  | 'waybill_batch';

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
 * Результат задания устарел: документ переразобрали, пока оно работало.
 *
 * Отдельный класс, а не «тихий return»: бросается из транзакции сохранения,
 * которую нужно откатить целиком. Ловится на выходе из handleJob и НЕ уходит в
 * BullMQ-retry — повторять нечего, документ уже принадлежит новому поколению.
 */
class StaleGenerationError extends Error {
  constructor() {
    super('document superseded by a newer reparse generation');
    this.name = 'StaleGenerationError';
  }
}

/**
 * Условие «этот документ и это поколение диспетчеризации».
 *
 * Ставится на КАЖДУЮ запись задания в документ. Поколение растёт только при
 * ручном повторе, поэтому для обычного потока условие всегда истинно (0 = 0), а
 * задание, застрявшее до повтора, после него не совпадёт и не перепишет свежий
 * результат своим устаревшим.
 */
function generationScoped(sourceDocumentId: string, generation: number) {
  return and(
    eq(sourceDocuments.id, sourceDocumentId),
    eq(sourceDocuments.dispatchGeneration, generation),
  );
}

/**
 * Возвращает документ в состояние до неудачного повтора.
 *
 * Инвариант кнопки «Распознать повторно»: нажатие не может ухудшить документ.
 * Маршрут к этому моменту уже сменил статус на `queued` и обнулил `second_pass`,
 * поэтому «просто ничего не писать» недостаточно — нужно вернуть снимок,
 * сделанный при постановке задания.
 *
 * Ничего не делает, если снимка нет (обычный, не ручной разбор) или поколение
 * разошлось — тогда документ уже принадлежит следующей попытке.
 */
async function rollbackReparse(
  sourceDocumentId: string,
  generation: number,
  reason: string,
  log: WorkerLog,
): Promise<boolean> {
  const [doc] = await db
    .select({ reparse: sourceDocuments.reparse })
    .from(sourceDocuments)
    .where(generationScoped(sourceDocumentId, generation))
    .limit(1);
  const state = doc?.reparse as
    | { generation?: number; snapshot?: Record<string, unknown> }
    | null
    | undefined;
  if (!state?.snapshot || state.generation !== generation) return false;

  const snap = state.snapshot as {
    status?: string;
    parseErrorCode?: string | null;
    parseErrorDetails?: Record<string, unknown> | null;
    validation?: unknown;
    processedAt?: string | null;
    secondPass?: unknown;
  };

  const [restored] = await db
    .update(sourceDocuments)
    .set({
      status: (snap.status ?? 'parse_failed') as 'parsed',
      parseErrorCode: snap.parseErrorCode ?? null,
      parseErrorDetails: snap.parseErrorDetails ?? null,
      validation: (snap.validation ?? null) as never,
      processedAt: snap.processedAt ? new Date(snap.processedAt) : null,
      secondPass: (snap.secondPass ?? null) as never,
      reparse: { ...state, state: 'failed', reason, finishedAt: new Date().toISOString() },
      updatedAt: new Date(),
    })
    .where(generationScoped(sourceDocumentId, generation))
    .returning({ id: sourceDocuments.id });
  if (restored) log.warn({ reason }, 'повторное распознавание откачено — документ не изменён');
  return Boolean(restored);
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
  /** Поколение задания-родителя: и для fencing, и для ключа второго прохода. */
  generation: number;
  /**
   * Идёт ли второй проход в рамках РУЧНОГО повтора.
   *
   * Признак обязан дожить до дочернего задания. Ручной повтор хранит снимок
   * «что было до» и при неудаче возвращает документ к нему; решает это
   * `reparseJob` в handleJob, а тот читает флаг из payload. Потеряв флаг здесь,
   * повтор, ушедший на второй проход и упавший там, не откатился бы вовсе —
   * документ остался бы в `processing` с прежним снимком навсегда.
   */
  reparse?: boolean;
  /**
   * Транзакция вызывающего. Для ручного повтора обязательна: иначе шапка со
   * слабым результатом успевает лечь в БД раньше, чем переписаны позиции, и в
   * этом окне документ выглядит как «новая шапка со старыми позициями».
   */
  tx?: typeof db;
}): Promise<boolean> {
  // Читаем ТОЙ ЖЕ транзакцией, что и пишем. Отдельное соединение изнутри чужой
  // транзакции — это запрос к строке, которую она уже держит: пул выдаёт другое
  // соединение, и оно ждёт коммита, которого не будет, пока ждём мы.
  const reader = args.tx ?? db;
  const [current] = await reader
    .select({ secondPass: sourceDocuments.secondPass })
    .from(sourceDocuments)
    .where(generationScoped(args.sourceDocumentId, args.generation))
    .limit(1);
  if (!current || current.secondPass != null) return false;

  const write = async (tx: typeof db) => {
    await tx
      .update(sourceDocuments)
      .set({
        ...args.values,
        secondPass: {
          state: 'queued',
          mode: 'vision',
          requestedAt: new Date().toISOString(),
          reasons: args.reasons,
          // Куда вернуть документ, если второй проход не доедет до конца.
          //
          // Первый проход УЖЕ дал результат — он лежит в args.values и пишется
          // этим же UPDATE. Дальше воркер переведёт документ в `processing`, и
          // прежнего статуса не останется нигде: снимка у второго прохода, в
          // отличие от ручного повтора, нет. Если такой документ зависнет,
          // сторож обязан вернуть его к результату первого прохода, а не
          // превратить в заглушку — иначе распознанная УПД исчезнет с планшета
          // из-за неудачи необязательного уточнения.
          restore: {
            status: args.values.status ?? null,
            parseErrorCode: args.values.parseErrorCode ?? null,
            parseErrorDetails: args.values.parseErrorDetails ?? null,
          },
        },
      })
      .where(generationScoped(args.sourceDocumentId, args.generation));
    await enqueueJob(tx as unknown as typeof db, {
      queue: UPD_PARSE_QUEUE,
      jobName: 'parse',
      payload: {
        sourceDocumentId: args.sourceDocumentId,
        s3Key: args.s3Key,
        pass: 'vision',
        docGeneration: args.generation,
        ...(args.reparse ? { reparse: true } : {}),
      },
      // Ключ версионный: после ручного повтора старый `doc~<id>~parse~vision`
      // уже отработал, а BullMQ держит завершённые задания сутки — без
      // поколения второй проход просто не запустился бы.
      dedupeKey: documentSecondPassKeyOf(args.sourceDocumentId, args.generation),
    });
  };

  if (args.tx) await write(args.tx);
  else await db.transaction(async (tx) => write(tx as unknown as typeof db));
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
 * Ставит АВТОПОВТОР того же сегмента после расхождения сумм.
 *
 * Почему не resolveReparsePlan, которым пользуется кнопка «Распознать
 * повторно»: он рассчитан на уже опубликованный комплект и отказывает, пока
 * корневой пакет в `processing` (blocked: 'assembly_busy'). А здесь мы ровно
 * внутри сборки — то есть через него автоповтор был бы заблокирован всегда.
 *
 * КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ queueSecondPass: документ остаётся в `queued`, а не
 * уходит в терминальный статус. Публикация комплекта ждёт этого сама —
 * segmentOutcome считает `queued`/`processing` незавершённым, и
 * tryFinalizeUpdAssembly не публикует ни одного документа группы, пока повтор
 * не закончит. Иначе комплект успел бы опубликоваться между записью результата
 * и стартом повтора, и менеджер увидел бы документ, который вот-вот изменится.
 *
 * Обратная сторона: повтор ОБЯЗАН довести документ до терминала при любом
 * исходе, включая падение и исчерпание попыток. Снимок для этого лежит в
 * second_pass.restore, а подбирает зависшее задание generation-aware recovery.
 */
async function queueSegmentRepair(args: {
  sourceDocumentId: string;
  segmentId: string;
  /** Поколение сборки корневого пакета — fencing сегментного задания. */
  assemblyGeneration: number;
  segmentGeneration: number;
  bundleGeneration: number | undefined;
  reasons: string[];
  values: Record<string, unknown>;
  /** Поколение документа: и для fencing, и для ключа повтора. */
  generation: number;
  tx: typeof db;
}): Promise<boolean> {
  const [current] = await args.tx
    .select({ secondPass: sourceDocuments.secondPass })
    .from(sourceDocuments)
    .where(generationScoped(args.sourceDocumentId, args.generation))
    .limit(1);
  // Одна попытка на поколение: третьего прохода не бывает.
  if (!current || current.secondPass != null) return false;

  await args.tx
    .update(sourceDocuments)
    .set({
      ...args.values,
      // Документ не выходит из работы — см. KDoc выше.
      status: 'queued',
      secondPass: {
        state: 'queued',
        mode: 'segment_repair',
        requestedAt: new Date().toISOString(),
        reasons: args.reasons,
        // Куда вернуть документ, если повтор не доедет до конца: терминальный
        // исход ПЕРВОГО разбора, посчитанный общим путём.
        restore: {
          status: args.values.status ?? null,
          parseErrorCode: args.values.parseErrorCode ?? null,
          parseErrorDetails: args.values.parseErrorDetails ?? null,
        },
      },
    })
    .where(generationScoped(args.sourceDocumentId, args.generation));

  await enqueueJob(args.tx, {
    queue: UPD_PARSE_QUEUE,
    jobName: 'parse',
    payload: {
      sourceDocumentId: args.sourceDocumentId,
      segmentId: args.segmentId,
      generation: args.assemblyGeneration,
      segmentGeneration: args.segmentGeneration,
      bundleGeneration: args.bundleGeneration,
      docGeneration: args.generation,
      pass: 'segment_repair',
    },
    dedupeKey: segmentRepairKeyOf(args.segmentId, args.generation),
  });
  return true;
}

/** Снимок для арбитража автоповтора сегмента: строже, чем loadParsedBaseline. */
export type SegmentRepairBaseline = {
  parsed: UpdPdfParsed;
  /** Куда вернуть документ, если кандидат проиграет или повтор упадёт. */
  restore: {
    status: SourceStatus;
    parseErrorCode: string | null;
    parseErrorDetails: Record<string, unknown> | null;
  };
};

/**
 * Снимок сохранённого разбора для арбитража повтора сегмента.
 *
 * Почему не loadParsedBaseline. Тот снимок делался для второго прохода
 * одиночного пути, где важно было не потерять шапку, и ради простоты он
 * жёстко ставит `itemsCount: null` и `supplier: null`, а `rowNo` не переносит
 * вовсе. Для арбитража это недопустимо: покрытие сравнивается по типам
 * проверок, и обеднённый baseline потерял бы `items_count` и `items_sequence`
 * — кандидат «выигрывал» бы у снимка, а не у настоящего разбора. Поставщик
 * нужен по той же причине: без него защита идентичности не смогла бы
 * отличить «кандидат дозаполнил пустое» от «кандидат подменил чужим».
 */
export async function loadSegmentRepairBaseline(
  sourceDocumentId: string,
): Promise<SegmentRepairBaseline | null> {
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

  // «Всего наименований» нигде не хранится отдельной колонкой — единственный
  // его след остался в снимке валидации, в expected проверки items_count.
  const checks = ((doc.validation as UpdValidation | null)?.checks ??
    []) as UpdValidation['checks'];
  const declaredCount = checks.find(
    (c) => c.name === 'items_count' && c.skipReason == null,
  )?.expected;

  // Куда вернуть документ, если кандидат проиграет. Берём СНИМОК, сделанный
  // при постановке повтора, а не текущие поля: сейчас документ намеренно лежит
  // в `queued` (публикация комплекта ждёт повтора), и «оставить как есть»
  // означало бы оставить его в работе навсегда — комплект не опубликуется
  // никогда, потому что segmentOutcome считает queued незавершённым.
  const savedRestore = (
    doc.secondPass as {
      restore?: {
        status?: SourceStatus | null;
        parseErrorCode?: string | null;
        parseErrorDetails?: Record<string, unknown> | null;
      } | null;
    } | null
  )?.restore;

  let supplier: UpdPdfParsed['supplier'] = null;
  if (doc.supplierDirectoryId) {
    const [row] = await db
      .select({ inn: suppliers.inn, name: suppliers.name })
      .from(suppliers)
      .where(eq(suppliers.id, doc.supplierDirectoryId))
      .limit(1);
    if (row) supplier = { inn: row.inn || null, kpp: null, name: row.name };
  }

  const num = (v: string | null): number | null => (v == null ? null : Number(v));
  return {
    parsed: {
      docNumber: doc.docNumber,
      docDate: doc.docDate ? doc.docDate.toISOString().slice(0, 10) : null,
      totalSum: num(doc.totalSum),
      vatSum: num(doc.vatSum),
      itemsCount: typeof declaredCount === 'number' ? declaredCount : null,
      supplier,
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
        // Номер из бланка — по нему валидатор проверяет целостность списка.
        rowNo: i.rowNo ?? null,
      })),
      confidence: doc.llmConfidence != null ? Number(doc.llmConfidence) : 0,
    } as UpdPdfParsed,
    restore: savedRestore?.status
      ? {
          status: savedRestore.status,
          parseErrorCode: savedRestore.parseErrorCode ?? null,
          parseErrorDetails: savedRestore.parseErrorDetails ?? null,
        }
      : {
          // Снимка нет — документ поставлен на повтор версией кода без него.
          // Тогда единственное разумное «куда вернуть» — текущие поля, но статус
          // берём терминальный: в момент повтора документ лежит в queued, и
          // вернуть его туда же значило бы подвесить комплект навсегда.
          status: 'parsed' as SourceStatus,
          parseErrorCode: doc.parseErrorCode ?? null,
          parseErrorDetails: (doc.parseErrorDetails as Record<string, unknown> | null) ?? null,
        },
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
    await handleDocumentRouterJob(job.data.bundleId, job.data.bundleGeneration ?? 0, log);
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
    await handleUpdAssemblyJob(
      job.data.bundleId,
      job.data.generation,
      job.data.bundleGeneration ?? 0,
      log,
    );
    return;
  }
  if ('bundleId' in job.data && job.data.bundleId) {
    const log = logger.child({ bundleId: job.data.bundleId, jobId: job.id });
    await handleWaybillBundleJob(job.data.bundleId, job.data.bundleGeneration ?? 0, log);
    return;
  }
  // Повторный разбор ОДНОЙ накладной пакетного пути. Отдельный обработчик:
  // parseWaybillBatch читает вложения документа, а не один файл, и результат
  // пишется в существующую строку, а не создаёт новые.
  if ('mode' in job.data && job.data.mode === 'waybill_single' && job.data.sourceDocumentId) {
    const log = logger.child({
      sourceDocumentId: job.data.sourceDocumentId,
      jobId: job.id,
      mode: 'waybill_single',
    });
    await handleWaybillSingleReparseJob(
      job.data.sourceDocumentId,
      job.data.docGeneration ?? 0,
      log,
    );
    return;
  }
  // Сегмент сборки: файла у задания нет вовсе — страницы адресует манифест,
  // поэтому проверка payload ниже пропускает его отдельно.
  const segmentJob =
    'segmentId' in job.data && job.data.segmentId && job.data.sourceDocumentId
      ? {
          segmentId: job.data.segmentId,
          generation: job.data.generation,
          dispatchGeneration: job.data.segmentGeneration ?? 0,
          bundleGeneration: job.data.bundleGeneration,
          // Ручной повтор опубликованного комплекта — см. loadSegmentContext.
          reparse: job.data.reparse === true,
        }
      : null;

  // Автоповтор сегмента: то же задание, но результат проходит арбитраж и
  // применяется, только если доказуемо лучше сохранённого разбора.
  const segmentRepairJob =
    segmentJob != null && 'pass' in job.data && job.data.pass === 'segment_repair';

  if (!job.data.sourceDocumentId || (!job.data.s3Key && !segmentJob)) {
    logger.warn({ jobId: job.id, data: job.data }, 'unknown job payload — skipping');
    return;
  }
  const sourceDocumentId = job.data.sourceDocumentId;
  /**
   * Поколение диспетчеризации, под которым поставлено ЭТО задание.
   *
   * Задание без поля считается поколением 0: у документа, которого ни разу не
   * переразбирали, `dispatch_generation` равен нулю, поэтому все существующие
   * задания продолжают работать как раньше. А после ручного повтора счётчик
   * растёт, и застрявшее старое задание уже не совпадёт — то есть не перепишет
   * свежий результат своим устаревшим.
   */
  const jobGeneration = job.data.docGeneration ?? 0;
  // Поколение растёт и при recovery; ручной повтор отличает явный флаг.
  const reparseJob = job.data.reparse === true;

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
  // У повтора сегмента снимок свой: loadParsedBaseline теряет itemsCount,
  // rowNo и поставщика, а арбитраж сравнивает именно покрытие проверок.
  const repairBaseline = segmentRepairJob
    ? await loadSegmentRepairBaseline(sourceDocumentId)
    : null;

  // Переводим в processing + считаем attempt. Пустой returning() значит одно из
  // двух: документ удалён через DELETE /:id либо его успели переразобрать, и
  // наше задание относится к прошлому поколению. Оба случая — «работать не над
  // чем», выходим молча.
  const [proc] = await db
    .update(sourceDocuments)
    .set({
      status: 'processing',
      jobAttempts: drSql`${sourceDocuments.jobAttempts} + 1`,
      ...(reparseJob
        ? {
            reparse: drSql`jsonb_set(${sourceDocuments.reparse}, '{state}', '"processing"')`,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(generationScoped(sourceDocumentId, jobGeneration))
    // validation берём здесь же: повторный разбор перезапишет его целиком, и
    // пакетные предупреждения («в файле были неразобранные страницы») иначе
    // потерялись бы — вычислить их заново по items нечем.
    .returning({
      id: sourceDocuments.id,
      kind: sourceDocuments.kind,
      validation: sourceDocuments.validation,
    });
  if (!proc) {
    log.warn({ jobGeneration }, 'source document is gone or superseded — skipping job');
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
  // Картинка ли это — по расширению ключа. Список живёт в lib/image-kind.ts:
  // пока он состоял из jpg/png/webp, файл .jfif (тот же JPEG из Outlook)
  // считался PDF и уходил в pdftoppm — «May not be a PDF file», parse_failed,
  // документ потерян.
  const imageMime = imageMimeOfKey(s3Key);
  const isImage = imageMime != null;

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
        // На повторе называем модели её же расхождение. Без этого повтор — тот
        // же запрос с той же картинкой, и ответ, скорее всего, повторится.
        // Никакой арифметики в подсказке: требование «умножь и сверь» ломало
        // чтение колонок (версии промпта v15/v16), поэтому здесь только факт.
        ...(repairBaseline ? { repairHint: buildRepairHint(repairBaseline.parsed) } : {}),
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
          // В распознавание уходит PDF ЦЕЛИКОМ, а не картинка первой страницы.
          //
          // Раньше бралось `pngPages[0]`, и у Excel-УПД, чья таблица не
          // помещается на лист, материалы со второй страницы терялись молча:
          // документ выглядел распознанным, а половины строк в нём не было.
          //
          // Дальше страницами распоряжается сам vision-путь, и он у провайдеров
          // разный: OpenRouter прогоняет PDF через prefilter (классификация
          // страниц + предел MAX_PAGES_FOR_OPENROUTER), Google AI Studio
          // принимает PDF как есть. Оба варианта лучше одной картинки.
          const pdf = await convertExcelToPdf(buffer, isXls ? 'xls' : 'xlsx');
          const r = await parseUpdVision(
            { buffer: pdf, mimeType: 'application/pdf', filename: s3Key },
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
          bundleErr instanceof VisionBudgetExceededError ||
          bundleErr instanceof VisionPayloadTooLargeError
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
                visionErr instanceof VisionBudgetExceededError ||
                visionErr instanceof VisionPayloadTooLargeError
              ) {
                throw visionErr;
              }
              // Прочие ошибки (провайдер не поддерживает PDF / сетевые
              // глюки) — некритично: оставляем text-LLM результат
              // (пустые поля), документ попадёт в partial_parse.
              log.warn({ visionErr }, 'text-LLM empty + vision retry failed — keep partial_parse');
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
                  bundleErr instanceof VisionBudgetExceededError ||
                  bundleErr instanceof VisionPayloadTooLargeError
                ) {
                  throw bundleErr;
                }
                log.warn(
                  {
                    bundleErr: bundleErr instanceof Error ? bundleErr.message : String(bundleErr),
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
                  {
                    segments: bundle.segments,
                    extracted: bundle.extracted,
                    reasons: bundle.reasons,
                  },
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
                visionErr instanceof VisionBudgetExceededError ||
                visionErr instanceof VisionPayloadTooLargeError
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
                    visionError: visionErr instanceof Error ? visionErr.message : String(visionErr),
                  },
                  processedAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(generationScoped(sourceDocumentId, jobGeneration));
              log.warn({ visionErr }, 'pdf-no-text + vision fallback failed — marked parse_failed');
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
              generation: jobGeneration,
              reparse: reparseJob,
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
    // Документ переразобрали, пока мы работали. Результат этого задания
    // относится к прошлому поколению — писать его некуда, ретраить нечего.
    if (err instanceof StaleGenerationError) {
      log.info({ jobGeneration }, 'результат задания устарел — документ уже переразобран');
      return;
    }

    // Ручной повтор не удался — возвращаем документ ровно в то состояние, в
    // котором он был до нажатия кнопки. Это главный инвариант фичи: повтор
    // может не улучшить документ, но не имеет права его ухудшить.
    //
    // Второй проход ПОВТОРА сюда тоже попадает, и это не оплошность. Обычный
    // второй проход просто оставляет документ как есть — терять ему нечего.
    // Но повтор к этому моменту уже перевёл документ в `queued`, и «оставить
    // как есть» означало бы вечное «в очереди»: первый проход упал, картинка
    // тоже, а вернуть прежний статус некому. Откат снимает и заказ второго
    // прохода — он часть той же неудавшейся попытки.
    if (reparseJob) {
      const message = err instanceof Error ? err.message : String(err);
      const rolledBack = await rollbackReparse(sourceDocumentId, jobGeneration, message, log);
      if (rolledBack) {
        await notifySourceDocumentUpdated(sourceDocumentId);
        return;
      }
      // Снимка нет (документ создан до 0100) — падаем в обычные ветки ниже.
    }

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
        .where(generationScoped(sourceDocumentId, jobGeneration));
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
    // VisionPayloadTooLargeError — fail-fast и своя ветка, а не соседняя:
    // у ошибки размера нет elapsedMs, и причина «vision_timeout» увела бы
    // разбор инцидента не туда. Повторять нечего — ни BullMQ-ретрай, ни новое
    // поколение watchdog'а не уменьшают тело запроса, а каждое поколение стоит
    // пользователю ~45 минут ожидания «в очереди».
    if (err instanceof VisionPayloadTooLargeError) {
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          // Тот же контрактный код, что у соседних fail-fast веток: enum в
          // @matcheck/contracts не расширяем, конкретика — в details.
          parseErrorCode: 'pdf_no_text',
          parseErrorDetails: {
            reason: 'vision_payload_too_large',
            actualBytes: err.actualBytes,
            limitBytes: err.limitBytes,
            message: err.message,
          },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(generationScoped(sourceDocumentId, jobGeneration));
      log.warn(
        { actualBytes: err.actualBytes, limitBytes: err.limitBytes },
        'vision payload too large — marked parse_failed without retry',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    if (err instanceof VisionTimeoutError || err instanceof VisionBudgetExceededError) {
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
        .where(generationScoped(sourceDocumentId, jobGeneration));
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
        .where(generationScoped(sourceDocumentId, jobGeneration));
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
        .where(generationScoped(sourceDocumentId, jobGeneration));
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
        .where(generationScoped(sourceDocumentId, jobGeneration));
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
  // явным критериям (upd-result-compare.ts) и при проигрыше возвращаем документ
  // к результату первого прохода.
  if (secondPassJob && baseline) {
    const decision = chooseBetterUpdResult(baseline, parsed);
    if (decision.winner === 'base') {
      // Статус возвращаем СНИМКОМ, а не «оставляем как есть».
      //
      // Перед вторым проходом документ уже переведён в `processing`, поэтому
      // закрыть попытку, не трогая статус, значит оставить его в «распознаётся»
      // навсегда: задания больше нет, а сам себя документ оттуда не выведет. На
      // бою так зависли УПД 2851 (минуту) и 2770/07 (больше суток) — оба с этим
      // же исходом, тогда как все 11 документов с исходом `replaced` проходили
      // дальше общим путём и статус получали.
      //
      // Снимок кладёт queueSecondPass в second_pass.restore. Берём статус
      // оттуда, а не считаем заново: первый проход уже вынес свой вердикт
      // (например, «суммы не сходятся»), и документ обязан вернуться именно к
      // нему.
      const [current] = await db
        .select({ secondPass: sourceDocuments.secondPass })
        .from(sourceDocuments)
        .where(generationScoped(sourceDocumentId, jobGeneration))
        .limit(1);
      const restore = (
        current?.secondPass as {
          restore?: {
            status?: SourceStatus | null;
            parseErrorCode?: string | null;
            parseErrorDetails?: Record<string, unknown> | null;
          } | null;
        } | null
      )?.restore;
      // Снимка нет только у документов, поставленных на второй проход версией
      // кода без него. Для них поведение прежнее: статус не трогаем, документ
      // подберёт восстановление — иначе мы бы гадали, чем он был до попытки.
      const restoreValues = restore?.status
        ? {
            status: restore.status,
            parseErrorCode: restore.parseErrorCode ?? null,
            parseErrorDetails: restore.parseErrorDetails ?? null,
          }
        : {};
      await db
        .update(sourceDocuments)
        .set({
          ...restoreValues,
          secondPass: {
            state: 'done',
            mode: 'vision',
            outcome: 'kept_baseline',
            reasons: decision.reasons,
            finishedAt: new Date().toISOString(),
            // Снимок переживает закрытие попытки: если документ позже всё-таки
            // зависнет, восстановлению будет к чему возвращать. Раньше объект
            // перезаписывался целиком, restore терялся, и recovery отдавал
            // документу `recovery_exhausted` вместо его настоящего исхода.
            ...(restore ? { restore } : {}),
          },
          updatedAt: new Date(),
        })
        .where(generationScoped(sourceDocumentId, jobGeneration));
      log.info(
        { reasons: decision.reasons, restored: Boolean(restore?.status) },
        'vision second pass worse than baseline — kept',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    // Победил vision — но стороны берём объединением: активный промпт v8
    // грузополучателя не запрашивает вовсе, и без слияния успешный второй
    // проход стёр бы сторону, добранную из текста на первом заходе.
    parsed = mergeParties(parsed, baseline);
    log.info({ reasons: decision.reasons }, 'vision second pass better than baseline — replacing');
  }

  // ─── Автоповтор сегмента: принимаем результат только при доказанном улучшении ──
  //
  // Стоит ДО работы со справочниками намеренно: отклонённый кандидат не должен
  // оставлять после себя ни поставщика, ни материалов. На № 53 первый разбор
  // уже завёл в справочник два одинаковых «ВРУ2.2(ПОН)» — повторять это на
  // каждой неудачной попытке нельзя.
  if (segmentRepairJob && repairBaseline) {
    const repairMode = loadEnv().UPD_SEGMENT_REPAIR;
    const verdict = decideSegmentRepair(repairBaseline.parsed, parsed);
    // В shadow победивший кандидат НЕ применяется: решение только записывается,
    // чтобы его можно было разобрать до того, как хоть один боевой документ
    // изменится.
    const applied = verdict.accept && repairMode === 'on';
    if (!applied) {
      // Документ обязан выйти из работы: перед повтором он оставлен в `queued`,
      // и без этого UPDATE комплект не опубликуется никогда — публикация ждёт
      // терминального статуса всех сегментов.
      await db
        .update(sourceDocuments)
        .set({
          status: repairBaseline.restore.status,
          parseErrorCode: repairBaseline.restore.parseErrorCode,
          parseErrorDetails: repairBaseline.restore.parseErrorDetails,
          secondPass: {
            state: 'done',
            mode: 'segment_repair',
            outcome: verdict.accept ? 'shadow_would_replace' : 'kept_baseline',
            reasons: verdict.reasons,
            candidateItems: parsed.items.length,
            baselineItems: repairBaseline.parsed.items.length,
            finishedAt: new Date().toISOString(),
            restore: repairBaseline.restore,
          },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(generationScoped(sourceDocumentId, jobGeneration));
      log.info(
        {
          mode: repairMode,
          accept: verdict.accept,
          reasons: verdict.reasons,
          baselineItems: repairBaseline.parsed.items.length,
          candidateItems: parsed.items.length,
        },
        verdict.accept
          ? 'segment repair: кандидат лучше, но режим shadow — оставлен прежний разбор'
          : 'segment repair: кандидат не лучше — оставлен прежний разбор',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      if (segmentContext) {
        await tryFinalizeUpdAssembly(segmentContext.rootId, segmentContext.generation, log, {
          subBundleId: segmentContext.subBundleId,
          bundleGeneration: segmentContext.bundleGeneration,
        });
      }
      return;
    }
    // Кандидат победил — но реквизиты остаются от первого разбора: повтор
    // затевался ради строк, а не ради шапки, и подменять уже прочитанный номер
    // или поставщика он не вправе.
    parsed = preserveDocumentIdentity(repairBaseline.parsed, parsed);
    log.info(
      {
        reasons: verdict.reasons,
        baselineItems: repairBaseline.parsed.items.length,
        candidateItems: parsed.items.length,
      },
      'segment repair: кандидат лучше — заменяем разбор',
    );
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
  // Реквизиты грузополучателя проходят проверку на подстановку: модель по
  // промпту v9 копирует ИНН и КПП покупателя даже когда наименование другое
  // (см. consigneeOwnIdentity). Скопированные — отбрасываем, иначе документ
  // покажет чужой ИНН и свяжется с чужой организацией.
  const consigneeIdentity = consigneeOwnIdentity(consignee, recipient);
  if (consignee?.inn && !consigneeIdentity.inn) {
    logger.warn(
      {
        docNumber: parsed.docNumber,
        consigneeName: consignee.name,
        consigneeInn: consignee.inn,
        recipientName: recipient?.name,
        recipientInn: recipient?.inn,
      },
      'consignee identity dropped: looks copied from buyer',
    );
  }
  // Адрес отрезаем ПОСЛЕ проверки реквизитов, и порядок здесь принципиален.
  //
  // Графу 4 печатают как «ООО "СУ-10", 127018, Город Москва, …», и vision
  // возвращает строку целиком (текстовые парсеры адрес режут давно). Обрежь мы
  // имя ДО consigneeOwnIdentity — сравнение сторон стало бы «ООО "СУ-10"» ==
  // «ООО "СУ-10"», и ИНН покупателя сохранился бы как «свой», хотя в графе 4
  // реквизитов нет вовсе. При нынешнем порядке имя с адресом честно считается
  // другой стороной, выдуманный ИНН отбрасывается, а до пользователя доезжает
  // уже чистое наименование.
  const consigneeName = nameBeforeAddress(consignee?.name);
  const consigneeId =
    consignee && consigneeIdentity.inn && consigneeName
      ? await findOrCreateCounterparty(
          { inn: consigneeIdentity.inn, kpp: consigneeIdentity.kpp, name: consigneeName },
          'customer',
        )
      : null;
  const documentParties = {
    buyerId: recipientId,
    buyerNameRaw: recipient?.name ?? null,
    consigneeId,
    consigneeNameRaw: consigneeName,
    // ИНН пишем сырым, как распознали, — ровно по той же причине, что и имя:
    // сторона без FK (графа 4 без ИНН) иначе осталась бы совсем без реквизитов,
    // а справочную запись потом правят люди, и она перестаёт отвечать на вопрос
    // «что стояло в документе». Нормализацию оставляем читателю.
    //
    // Исключение — грузополучатель: если его реквизиты скопированы у
    // покупателя, «сырое» значение перестаёт отвечать на этот вопрос (в графе 4
    // ИНН не печатают вовсе), поэтому пишем то, что осталось после проверки.
    supplierInnRaw: supplier?.inn ?? null,
    buyerInnRaw: recipient?.inn ?? null,
    consigneeInnRaw: consigneeIdentity.inn,
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

  // Сегменты ЭТОГО поколения не являются повторными загрузками друг для
  // друга. После разбора их строгие совпадения склеит tryFinalizeUpdAssembly;
  // здесь исключаем весь набор из поиска дубля, оставляя видимыми кандидаты из
  // любых других пакетов/поколений.
  const assemblyPeerIds = segmentContext
    ? (
        await db
          .select({ docId: bundleSegments.sourceDocumentId })
          .from(bundleSegments)
          .where(
            and(
              eq(bundleSegments.bundleId, segmentContext.rootId),
              eq(bundleSegments.generation, segmentContext.generation),
            ),
          )
      )
        .map((row) => row.docId)
        .filter((id): id is string => id != null)
    : [];
  const outsideCurrentAssembly =
    assemblyPeerIds.length > 0 ? notInArray(sourceDocuments.id, assemblyPeerIds) : undefined;

  // pricing='absent' — уже полноценный результат новой версии промпта, а не
  // причина для лишнего vision-прохода. При выключенном флаге это строгий
  // no-op, поэтому старые активные промпты сохраняют прежнее поведение.
  parsed = normalizeUpdNoPricingTotals(parsed, loadEnv().UPD_NO_PRICING_V1);

  // Построчный НДС, противоречащий шапке, — выдуманная моделью ставка.
  //
  // Через УПД-поток идут не только УПД: счета и товарные чеки попадают туда же,
  // а построчного налога в них нет вовсе, и модель заполняет графу сама —
  // привычными 20 % вместо действующих с 2026 года 22 %. Ставка и сумма при
  // этом согласованы друг с другом, поэтому построчные проверки подвоха не
  // видят, а с шапкой документ расходится: на счёте № 223379 — на 790 ₽.
  //
  // Стоит ДО preValidation и до ветки дубликата: обе пишут позиции, и правка
  // после них оставила бы часть документов с прежним, неверным налогом.
  parsed = normalizeLineVatAgainstHeader(parsed);

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
      // Разъехавшиеся номера позиций — такой же повод для второго прохода, как
      // несходящиеся суммы: строку либо потеряли, либо задвоили.
      rowNo: i.rowNo ?? null,
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

  // Автоповтор сегмента. Условие расхождения — hasMismatch, а НЕ
  // hasMoneyMismatch: второй исключает items_count, и документ, где в бланке
  // «Всего наименований: 3», распознано 2 строки, а итог отсутствует или
  // случайно сошёлся, повтора бы не получил — то есть ровно класс потери строк
  // прошёл бы мимо. Практического прироста это почти не даёт («Всего
  // наименований» печатают редко), но именно этот класс мы и чиним.
  //
  // Область — только первичный разбор сегмента: ручной повтор опубликованного
  // комплекта (segmentJob.reparse) сюда не входит, там нужен учёт приёмок и
  // отгрузок, которого у этой фазы нет.
  const wantSegmentRepair =
    !segmentRepairJob &&
    segmentContext != null &&
    segmentJob?.reparse !== true &&
    loadEnv().UPD_SEGMENT_REPAIR !== 'off' &&
    preValidation.hasMismatch;

  // Документ без даты: проверка на дубль по паре «поставщик + номер».
  //
  // Раньше такой документ до `parsed` не доходил вовсе, и вопрос не стоял.
  // Теперь доходит — а дедуп ниже требует дату и молча пропустил бы его мимо
  // проверки. Совпадение здесь НЕ блокирует: номера повторяются между годами,
  // и жёсткий отказ остановил бы работу из-за однофамильца. Пишем пометку —
  // менеджер видит риск в карточке, инспектор продолжает приёмку.
  let possibleDuplicateOf: string | null = null;
  if (canDedup && supplierDirectoryId && parsed.docNumber && !docDate) {
    const [twin] = await db
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.kind, proc.kind),
          eq(sourceDocuments.supplierDirectoryId, supplierDirectoryId),
          eq(sourceDocuments.docNumber, parsed.docNumber),
          inArray(sourceDocuments.status, ['parsed', 'needs_resolution']),
          outsideCurrentAssembly,
          drSql`${sourceDocuments.id} <> ${sourceDocumentId}`,
        ),
      )
      .limit(1);
    if (twin) {
      possibleDuplicateOf = twin.id;
      log.warn(
        { existingId: twin.id, docNumber: parsed.docNumber },
        'документ без даты: тот же номер у того же поставщика — помечаем как возможный дубль',
      );
    }
  }

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
          eq(sourceDocuments.kind, proc.kind),
          eq(sourceDocuments.supplierDirectoryId, supplierDirectoryId),
          eq(sourceDocuments.docNumber, parsed.docNumber),
          eq(sourceDocuments.docDate, docDate),
          inArray(sourceDocuments.status, ['parsed', 'needs_resolution']),
          outsideCurrentAssembly,
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
    } else if (existing && reparseJob) {
      // Ручной повтор упёрся в дубликат. Ветка ниже терминальна — она пишет
      // шапку и выходит ДО сохранения позиций, то есть документ остался бы с
      // новой шапкой и СТАРЫМИ позициями. Для повтора это ухудшение, поэтому
      // откатываем: документ таким и был до нажатия кнопки, а для дубликатов
      // есть свой сценарий «разрешить».
      duplicate = { id: existing.id };
      const rolledBack = await rollbackReparse(
        sourceDocumentId,
        jobGeneration,
        'duplicate_detected',
        log,
      );
      log.warn(
        { existingId: existing.id, rolledBack },
        'повтор: найден дубликат — результат не применяем',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    } else if (existing) {
      // Дубликат — ПОМЕТКА ПОВЕРХ СОХРАНЁННОГО, а не вместо него.
      //
      // Раньше эта ветка была терминальной: писала шапку и выходила `return`,
      // так что позиции, разобранные моделью, в базу не попадали вовсе. На бою
      // за месяц так потеряли разбор 28 документов из 29, прошедших этой
      // веткой (у сегментов, где пометка ставится после сохранения, потерь
      // ноль из 108). Цена ошибки при этом несимметрична: если совпадение
      // распознано неверно, восстановить данные нечем — только повторным
      // обращением к модели.
      //
      // Теперь документ идёт общим путём и сохраняется целиком, а пометка
      // ставится в той же транзакции, ниже. Заодно он получает больше полей,
      // чем писала эта ветка: номер, дату, итоги, валидацию и parseMode.
      duplicate = { id: existing.id };
      log.warn(
        { existingId: existing.id, confidence, parsedViaVision },
        'duplicate detected — сохраняем полностью, пометка ниже',
      );
      // Уведомление НЕ здесь: документ ещё не сохранён. Общий путь пошлёт его
      // после транзакции, как для всех прочих документов.
    }
  } else if (!canDedup && supplierDirectoryId && parsed.docNumber && docDate) {
    // Диагностика: distinguishable fields есть, но confidence низкая.
    // Логируем для аудита частоты срабатывания confidence-guard'а.
    log.warn(
      { confidence, parsedViaVision, docNumber: parsed.docNumber },
      'dedup skipped: confidence below MIN_DEDUP_CONFIDENCE',
    );
  }

  // Толлинг-М-15 без стоимостной части (итог прописью «Ноль»): доопределяем
  // totalSum/vatSum в 0, чтобы документ не падал в partial_parse из-за
  // недетерминизма vision (0 vs null). Для всех прочих документов — no-op.
  // См. m15-normalize.ts.
  parsed = normalizeM15ZeroTotals(parsed, 'docKind' in job.data ? job.data.docKind : undefined);

  // Валидация сумм. `let`: после синтеза итога по строкам сверку пересчитываем
  // — предупреждение, посчитанное по пустой сумме, ввело бы в заблуждение.
  let validation = validateUpdTotals(
    {
      totalSum: parsed.totalSum ?? null,
      vatSum: parsed.vatSum ?? null,
      itemsCount: parsed.itemsCount ?? null,
      // vatRate/vatSum обязательны: без них построчная сверка НДС и сверка
      // итога налога молча пропускаются. На бою они пропускались всегда —
      // из 1326 позиций за трое суток ставка распозналась у 1108, а до
      // валидатора не доезжала ни одна, и две проверки из пяти были мертвы.
      items: parsed.items.map((i) => ({
        rowNo: i.rowNo ?? null,
        qty: i.qty,
        unit: i.unit ?? null,
        price: i.price ?? null,
        sum: i.sum ?? null,
        vatRate: i.vatRate ?? null,
        vatSum: i.vatSum ?? null,
      })),
      // Стороны и сырая графа 4 — для проверки «грузополучатель повторяет
      // покупателя, а бланк этого не подтверждает».
      recipient: parsed.recipient ?? null,
      consignee: parsed.consignee ?? null,
      consigneeRaw: parsed.consigneeRaw ?? null,
    },
    // Числа пришли от модели — здесь эвристика подозрения уместна.
    { detectRecognitionWarnings: true },
  );

  // Готов ли документ к приёмке — единое правило, общее с ручной правкой на
  // портале и с бэкфиллом (см. domain/edo/upd-outcome.ts). Решают две вещи:
  // номер и ПОЛНЫЙ список материалов. Отсутствующая шапочная сумма считается
  // по строкам, отсутствующая дата не мешает, денежные расхождения становятся
  // предупреждением — но неполный список (12 позиций в документе против 3
  // распознанных) по-прежнему отказ: такая поставка приехала бы инспектору
  // как полная.
  const outcome = deriveUpdParseOutcome(
    { ...parsed, itemsCount: parsed.itemsCount ?? null },
    validation,
    { confidence, parsedViaVision },
  );

  // Итог посчитан по строкам — сверку сумм надо переснять, иначе в списке
  // останется предупреждение, посчитанное по пустой сумме.
  if (outcome.totalSumSynthesized && outcome.totalSum != null) {
    parsed = { ...parsed, totalSum: outcome.totalSum };
    validation = validateUpdTotals(
      {
        totalSum: outcome.totalSum,
        vatSum: parsed.vatSum ?? null,
        itemsCount: parsed.itemsCount ?? null,
        items: parsed.items.map((i) => ({
          rowNo: i.rowNo ?? null,
          qty: i.qty,
          unit: i.unit ?? null,
          price: i.price ?? null,
          sum: i.sum ?? null,
          vatRate: i.vatRate ?? null,
          vatSum: i.vatSum ?? null,
        })),
        recipient: parsed.recipient ?? null,
        consignee: parsed.consignee ?? null,
        consigneeRaw: parsed.consigneeRaw ?? null,
      },
      { detectRecognitionWarnings: true },
    );
  }

  const status = outcome.status;
  const parseErrorCode = outcome.parseErrorCode;
  const detailExtras = {
    // reason='low_confidence' помечает кейс «модель не уверена в
    // распознавании» — UI может предупредить «проверьте качество фото».
    ...(confidence < MIN_DEDUP_CONFIDENCE ? { reason: 'low_confidence' } : {}),
    // Тот же номер у того же поставщика, но дат нет ни у одного — сверить
    // автоматически нечем, решение за менеджером.
    ...(possibleDuplicateOf ? { possibleDuplicateOf } : {}),
  };

  // Совпадения реквизитов мало — дубликат подтверждается СОДЕРЖИМЫМ.
  //
  // Ключ «вид + поставщик + номер + дата» находит и разные отгрузки: за месяц
  // из 126 таких пар у 23 разошлись итоги, у 21 — число позиций, а в 9 случаях
  // спрятанный разбор оказался ТОЧНЕЕ оставшегося. Цена ошибки несимметрична:
  // лишняя видимая карточка — неудобство, а скрытый документ означает
  // недостачу материалов в приёмке.
  //
  // Поэтому решение трёхзначное (см. duplicate-verdict.ts), и `duplicate_upd`
  // ставится ТОЛЬКО на доказанном совпадении. Остальное остаётся видимым с
  // предупреждением.
  //
  // Считается ЗДЕСЬ, а не сразу после поиска кандидата: выше `parsed` ещё
  // проходит нормализацию нулевых итогов М-15 и синтез итога по строкам, а
  // существующий документ читается из БД уже нормализованным. Сравнение
  // сырого разбора с нормализованным давало бы ложное «не подтверждено».
  let duplicateVerdict: DuplicateVerdict | null = null;
  if (duplicate) {
    const existingParsed = await loadParsedBaseline(duplicate.id);
    duplicateVerdict = existingParsed
      ? // Хеш файла здесь не сравниваем: у вложений он почти не заполнен
        // (2 записи из 2434 за месяц), поэтому решает отпечаток содержимого.
        verdictForDuplicate(parsed, existingParsed, false)
      : { kind: 'unknown', detail: 'разбор существующего документа не читается' };
    log.info(
      { existingId: duplicate.id, verdict: duplicateVerdict.kind, detail: duplicateVerdict.detail },
      'вердикт по дубликату',
    );
  }
  // След проверки остаётся в самом документе, а не только в логе: разбираться
  // в спорной паре приходится и через недели, когда логи уже ротировались, —
  // и бэкфиллу по уже скрытым документам нужен тот же след.
  const duplicateCheck =
    duplicate && duplicateVerdict
      ? {
          comparedWith: duplicate.id,
          verdict: duplicateVerdict.kind,
          detail: duplicateVerdict.detail,
        }
      : null;
  const parseErrorDetails: Record<string, unknown> | null =
    outcome.parseErrorDetails || Object.keys(detailExtras).length > 0 || duplicateCheck
      ? {
          ...(outcome.parseErrorDetails ?? {}),
          ...detailExtras,
          ...(duplicateCheck ? { duplicateCheck } : {}),
        }
      : null;

  // Совпали реквизиты, но не содержимое — след для человека.
  //
  // Документ остаётся обычным и доезжает до планшета, однако рядом с ним в
  // списке окажется похожий. Без пометки это выглядит сбоем; с ней видно, что
  // система совпадение заметила и сознательно не стала прятать документ.
  if (duplicate && duplicateVerdict && duplicateVerdict.kind !== 'confirmed') {
    validation = {
      ...validation,
      warnings: [
        ...(validation.warnings ?? []),
        { name: 'duplicate_unconfirmed' as const, scope: 'document' as const },
      ],
    };
  }

  // Граница записи: дальше validation уходит в базу и перетирает прежний
  // снимок. Пакетные предупреждения относятся к нарезке файла, а не к числам
  // документа, — валидатор их не вычисляет, поэтому переносим руками.
  validation = mergePersistentUpdWarnings(proc.validation, validation);

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
    // Чем документ разобран. Читает это только повтор: он обязан пойти ТЕМ ЖЕ
    // путём, а по типу документа его не вывести — kind='transport_waybill'
    // одинаков и у М-15, и у ТН из пакетного разбора.
    parseMode,
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
    // То же для повтора сегмента: дошёл сюда — значит выиграл арбитраж.
    // Без отметки recovery посчитал бы попытку незавершённой и поставил заново.
    ...(segmentRepairJob
      ? {
          secondPass: {
            state: 'done',
            mode: 'segment_repair',
            outcome: 'replaced',
            finishedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
  // Материалы заводим ДО транзакции: findOrCreateMaterial ходит в справочник на
  // каждую позицию, и внутри транзакции это растянуло бы её на все вставки.
  // Справочник идемпотентен, поэтому откат транзакции ему не вредит.
  const itemRows =
    parsed.items.length > 0
      ? await Promise.all(
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
            // Номер из бланка сохраняем рядом с нашим порядковым: по нему
            // склейка отличает второй экземпляр УПД от её продолжения, а
            // валидатор после склейки видит задвоенную строку.
            rowNo: it.rowNo ?? null,
          })),
        )
      : [];

  // Шапка и позиции — ОДНОЙ транзакцией.
  //
  // Раньше это были три отдельных запроса (шапка, delete позиций, insert), и
  // падение между ними оставляло документ без позиций. Для первой загрузки это
  // почти незаметно (терять было нечего), но для повтора — ровно тот исход,
  // ради предотвращения которого кнопка и делается.
  let secondPassQueued = false;
  let segmentRepairQueued = false;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as typeof db;

    if (wantSegmentRepair && segmentContext && segmentJob) {
      segmentRepairQueued = await queueSegmentRepair({
        sourceDocumentId,
        segmentId: segmentJob.segmentId,
        assemblyGeneration: segmentContext.generation,
        segmentGeneration: segmentJob.dispatchGeneration,
        bundleGeneration: segmentContext.bundleGeneration,
        reasons: preValidation.checks.filter((c) => !c.ok).map((c) => c.name),
        values: headerValues,
        generation: jobGeneration,
        tx: txDb,
      });
    }

    if (wantSecondPass) {
      secondPassQueued = await queueSecondPass({
        sourceDocumentId,
        s3Key,
        reasons: weakReasons,
        values: headerValues,
        generation: jobGeneration,
        reparse: reparseJob,
        tx: txDb,
      });
    }

    if (!secondPassQueued && !segmentRepairQueued) {
      const [saved] = await txDb
        .update(sourceDocuments)
        .set(headerValues)
        .where(generationScoped(sourceDocumentId, jobGeneration))
        .returning({ id: sourceDocuments.id });
      // Документ переразобрали, пока мы работали, — наш результат устарел.
      if (!saved) throw new StaleGenerationError();
    }

    await txDb
      .delete(sourceDocumentItems)
      .where(eq(sourceDocumentItems.sourceDocumentId, sourceDocumentId));
    if (itemRows.length > 0) await txDb.insert(sourceDocumentItems).values(itemRows);

    // Дубликат — предупреждение ПОВЕРХ сохранённого результата: позиции и
    // реквизиты остаются, решает человек. Раньше так вёл себя только собранный
    // документ, а обычный терял позиции целиком (см. ветку выше).
    //
    // Скрывается только ДОКАЗАННОЕ совпадение. При `different` и `unknown`
    // документ остаётся обычным: статус и код ошибки не трогаем, чтобы он
    // доехал до планшета наравне с прочими.
    if (duplicate && duplicateVerdict?.kind === 'confirmed') {
      await txDb
        .update(sourceDocuments)
        .set({
          status: 'needs_resolution',
          parseErrorCode: 'duplicate_upd',
          parseErrorDetails: {
            existingId: duplicate.id,
            docNumber: parsed.docNumber,
            docDate: parsed.docDate,
            // Чем именно подтверждено: хешем файла или отпечатком содержимого.
            // Без этого спорную пометку нечем перепроверить постфактум.
            duplicateCheck,
          },
          updatedAt: new Date(),
        })
        .where(generationScoped(sourceDocumentId, jobGeneration));
    }

    // Ручной повтор дошёл до конца — гасим диагностику прошлого разбора и
    // закрываем попытку. Именно здесь, а не в маршруте: до этого момента
    // прежние parse_error*/validation обязаны оставаться на месте, иначе
    // неудачный повтор стёр бы их без замены.
    if (reparseJob) {
      await txDb
        .update(sourceDocuments)
        .set({
          reparse: drSql`jsonb_set(jsonb_set(${sourceDocuments.reparse}, '{state}', '"succeeded"'), '{finishedAt}', to_jsonb(now()::text))`,
        })
        .where(generationScoped(sourceDocumentId, jobGeneration));
    }

    // Позиции документа только что переписаны заново, с новыми id. Набор
    // документов машины при этом прежний, поэтому форма на планшете не увидит
    // расхождения по составу — сигналом, что содержимое поменялось, служат
    // group_revision машины и version самого документа. В той же транзакции,
    // что и сама правка: иначе планшет успел бы забрать документ до бампа.
    //
    // Не bumpGroupRevision: он вырождается в no-op для пакета, машиной не
    // являющегося, и одиночный документ оставался с прежним version — сверка
    // такую копию не находила (52 документа на бою, см. helper).
    await markSourceDocumentContentChanged(txDb, sourceDocumentId);

    // Разбор изменил статус и реквизиты, а значит мог изменить и видимость —
    // как самого документа, так и его соседей по машине: пока он был в
    // processing, вся машина была скрыта, и теперь могла открыться целиком.
    // Событие пишется только на фактический переход, повтор ничего не добавит.
    await recordVisibilityTransitions(txDb, {
      documentIds: [sourceDocumentId],
      reason: 'разбор документа завершён',
    });
  });

  // Подрядчика по ИНН покупателя больше не подставляем. Подстановка жила ради
  // одного: без получателя документ висел «Черновиком» и не уезжал на планшет.
  // Теперь у приёмки получатель не обязателен ни для «Обработано», ни для
  // выдачи инспектору (см. getDocumentDisplayStatus и mobile-visibility), а
  // планшет показывает грузополучателя из самого документа. Оставшийся эффект
  // был вредным: в поле «Получатель» появлялся покупатель из шапки — для
  // поставки субподрядчику это генподрядчик, то есть заведомо чужой подрядчик.
  if (secondPassQueued) {
    log.warn(
      { reasons: weakReasons, parseMode },
      'weak parse — vision second pass queued as separate job',
    );
  }
  if (segmentRepairQueued) {
    log.info(
      {
        mode: loadEnv().UPD_SEGMENT_REPAIR,
        failed: preValidation.checks.filter((c) => !c.ok).map((c) => c.name),
        items: parsed.items.length,
        totalSum: parsed.totalSum,
      },
      'segment repair: расхождение валидации — повтор поставлен отдельным заданием',
    );
  }

  log.info({ itemsCount: parsed.items.length, status, parseErrorCode }, 'upd parsed successfully');
  await notifySourceDocumentUpdated(sourceDocumentId);

  // Комплект мог стать готовым именно сейчас. Вызов здесь, а не в вызывающем
  // коде: у handleJob несколько ранних выходов, и публикация не должна
  // зависеть от того, каким из них закончился разбор — за остальные отвечает
  // finally в обработчике очереди и ветка worker.on('failed').
  if (segmentContext) {
    await tryFinalizeUpdAssembly(segmentContext.rootId, segmentContext.generation, log, {
      subBundleId: segmentContext.subBundleId,
      bundleGeneration: segmentContext.bundleGeneration,
    });
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

class StaleBundleAttemptError extends Error {
  constructor(bundleId: string, generation: number) {
    super(`bundle attempt is stale: ${bundleId}@${generation}`);
    this.name = 'StaleBundleAttemptError';
  }
}

async function fenceBundleAttempt(
  tx: typeof db,
  bundleId: string,
  generation: number,
): Promise<void> {
  const [current] = await tx
    .select({ id: sourceBundles.id })
    .from(sourceBundles)
    .where(and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, generation)))
    .for('update')
    .limit(1);
  if (!current) throw new StaleBundleAttemptError(bundleId, generation);
}

/**
 * Второй проход накладных промптом формы 1-Т. Возвращает результат, если он
 * что-то нашёл, и null во всех остальных случаях — тогда вызывающий остаётся
 * ровно с тем исходом, который получил бы и без нас.
 *
 * Общая для пакетного разбора и для повтора одной накладной: оба зовут
 * parseWaybillBatch активным промптом (формы 2116 и ОС-2) и оба получают на
 * форме 1-Т пустой список — значит и лечение у них одно.
 *
 * `originalFiles` — вложения ДО рендера под предел первого прохода: у второго
 * прохода свой, больший предел страниц, и рендерит он от оригиналов.
 */
async function secondPassWaybill1t(
  originalFiles: WaybillInputImage[],
  ctx: { sourceDocumentId: string | null; bundleId: string | null },
  log: WorkerLog,
): Promise<ParseWaybillBatchResult | null> {
  if (!loadEnv().WAYBILL_1T_FALLBACK) return null;
  return runWaybill1tPass(originalFiles, ctx, log);
}

/**
 * Разбор промптом формы 1-Т. Без проверки флагов: КОГДА его звать, решают
 * вызывающие — прицельный маршрут (WAYBILL_1T_ROUTE) или второй проход после
 * пустого результата (WAYBILL_1T_FALLBACK).
 */
async function runWaybill1tPass(
  originalFiles: WaybillInputImage[],
  ctx: { sourceDocumentId: string | null; bundleId: string | null },
  log: WorkerLog,
): Promise<ParseWaybillBatchResult | null> {
  try {
    const files1t =
      (await getDefaultProviderKind()) === 'openrouter'
        ? await expandPdfAttachmentsForOpenRouter(
            originalFiles,
            WAYBILL_1T_MAX_PAGES_FOR_OPENROUTER,
          )
        : originalFiles;
    const second = await parseWaybillBatch(files1t, {
      ...ctx,
      promptDocKind: 'transport_waybill_1t',
    });
    if (second.parsed.documents.length === 0) {
      log.info('второй проход 1-Т тоже не нашёл документа');
      return null;
    }
    log.info(
      { documents: second.parsed.documents.length, pages: files1t.length },
      'форма 1-Т распознана вторым проходом',
    );
    return second;
  } catch (err) {
    // Второй проход — доп. попытка, а не обязательный этап: его сбой не
    // должен отнимать у файла тот исход, который он получил бы и без нас.
    log.warn({ err }, 'второй проход 1-Т не удался — идём прежним путём');
    return null;
  }
}

/** Расширение Excel-книги для конвертера, либо null — если файл не Excel. */
function excelExtOf(mime: string, filename: string): 'xls' | 'xlsx' | null {
  const m = (mime || '').toLowerCase();
  const name = (filename || '').toLowerCase();
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.xls')) return 'xls';
  if (m.includes('spreadsheetml')) return 'xlsx';
  if (m.includes('ms-excel')) return 'xls';
  return null;
}

async function handleWaybillBundleJob(
  bundleId: string,
  bundleGeneration: number,
  log: WorkerLog,
): Promise<void> {
  // Берём bundle и проверяем что он ещё актуален.
  const [bundle] = await db
    .update(sourceBundles)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(
      and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, bundleGeneration)),
    )
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
      .where(
        and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, bundleGeneration)),
      );
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
      .where(
        and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, bundleGeneration)),
      );
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

  // Накладная, присланная книгой Excel. Промпт накладных принимает картинки и
  // PDF, книгу — нет, поэтому конвертируем той же связкой, что и УПД-путь.
  // Раньше такие файлы сюда не доезжали вовсе: роутер отдавал их УПД-промпту,
  // и тот честно возвращал ноль позиций («это транспортная накладная, а не
  // счёт-фактура»). Сбой конвертации не роняет пакет: файл идёт как есть,
  // модель его не опознает, и документ станет обычным «не распознано».
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const excelExt = excelExtOf(file.mimeType, file.filename);
    if (!excelExt) continue;
    try {
      const pdf = await convertExcelToPdf(file.buffer, excelExt);
      files[i] = {
        buffer: pdf,
        mimeType: 'application/pdf',
        filename: `${file.filename}.pdf`,
      };
    } catch (err) {
      log.warn({ err, file: file.filename }, 'накладная: excel→pdf не удался, файл идёт как есть');
    }
  }

  // Копия исходных вложений: `files` ниже перезаписывается отрендеренными
  // страницами под предел первого прохода, а второму проходу (форма 1-Т)
  // нужен свой, больший предел — значит рендерить он будет от оригиналов.
  const originalFiles: WaybillInputImage[] = [...files];
  const providerKind = await getDefaultProviderKind();

  // Накладные через OpenRouter: vision принимает только image/* (не PDF) —
  // конвертируем PDF-вложения в PNG-страницы ПЕРЕД parseWaybillBatch. Gemini
  // читает PDF нативно, для него не трогаем. Ошибка рендера пробрасывается во
  // внешний catch → bundle помечается parse_failed без BullMQ-retry.
  if (providerKind === 'openrouter') {
    const expanded = await expandPdfAttachmentsForOpenRouter(files);
    files.length = 0;
    files.push(...expanded);
  }

  let parsed;
  let llmProviderId: string | null = null;
  // Каким промптом разобран пакет — запоминаем в документах: повторный разбор
  // обязан идти тем же путём, иначе он выберет «свой» документ по batchIndex
  // из ЧУЖОГО набора и перепишет не ту строку.
  let promptKind: string | null = null;

  // Прицельный маршрут формы 1-Т.
  //
  // Активный промпт накладных знает ТН-2116 и ОС-2, а 1-Т по инструкции обязан
  // игнорировать. На практике он её всё-таки читает — по колонкам чужой формы:
  // в количество попадает графа «Кол-во мест» (боевая ТТН 16 674: 14 вместо
  // 1260 шт), в цену — количество, а денежным итогом документа становится
  // число из графы «Количество». Файл с признаками бланка 1-Т отдаём его
  // собственному промпту сразу, не тратя вызов на чужой.
  //
  // Только ОДНОРОДНЫЙ пакет: вложения пакета прикрепляются ко всем созданным
  // документам, и увести смешанную пачку целиком к промпту 1-Т значило бы
  // потерять лежащие рядом ТН-2116 и ОС-2. На бою у всех разобранных 1-Т в
  // пакете ровно один файл.
  if (loadEnv().WAYBILL_1T_ROUTE) {
    const flags = await Promise.all(
      originalFiles.map((f) => detectWaybill1t(f.buffer, f.mimeType)),
    );
    if (flags.length > 0 && flags.every(Boolean)) {
      const routed = await runWaybill1tPass(
        originalFiles,
        { sourceDocumentId: techId, bundleId },
        log,
      );
      if (routed) {
        parsed = routed.parsed;
        llmProviderId = routed.llmProviderId;
        promptKind = 'transport_waybill_1t';
        log.info({ documents: parsed.documents.length }, 'форма 1-Т распознана своим промптом');
      }
    }
  }

  if (!parsed) {
    try {
      const r = await parseWaybillBatch(files, { sourceDocumentId: techId, bundleId });
      parsed = r.parsed;
      llmProviderId = r.llmProviderId;
    } catch (err) {
      log.error({ err }, 'waybill batch parse failed, will retry');
      throw err;
    }
  }

  // Фотография формы 1-Т: текстового слоя нет, детектор молчит — но модель
  // сама пометила форму в ответе. Тогда пере-разбираем пакет её собственным
  // промптом. Боевой случай: ТТН № 16, снятая на телефон, получила qty
  // 1 260 000 вместо 1260 шт.
  //
  // Только пакет из ОДНОГО файла: у пачки перезапуск целиком отнял бы разбор у
  // лежащих рядом ТН-2116 и ОС-2.
  if (
    loadEnv().WAYBILL_1T_ROUTE &&
    promptKind == null &&
    originalFiles.length === 1 &&
    parsed.documents.length > 0 &&
    parsed.documents.every((d) => d.form === 'tn_1t')
  ) {
    const routed = await runWaybill1tPass(
      originalFiles,
      { sourceDocumentId: techId, bundleId },
      log,
    );
    if (routed && routed.parsed.documents.length > 0) {
      parsed = routed.parsed;
      llmProviderId = routed.llmProviderId;
      promptKind = 'transport_waybill_1t';
      log.info('форма 1-Т опознана моделью — пере-разобрали своим промптом');
    }
  }

  // Второй проход: товарно-транспортная накладная формы № 1-Т.
  //
  // Активный промпт накладных знает ровно две формы — 2116 и ОС-2 — и по
  // собственной инструкции обязан игнорировать всё прочее. Форма 1-Т
  // (Госкомстат №78, ОКУД 0345009) в его перечне отсутствует, поэтому боевые
  // ТТН получают пустой список: у «Товарно-транспортная накладная № БП-1414»
  // шесть вызовов подряд вернули ноль документов. Здесь мы даём такому файлу
  // прицельный разбор СВОИМ промптом, в структуре накладной, — а не через
  // общий УПД-промпт, который накладные тоже велено игнорировать.
  //
  // Первый проход при этом не меняется ни на символ: сюда мы попадаем, только
  // когда он уже вернул ноль документов, и на его предел страниц не влияем.
  if (parsed.documents.length === 0) {
    const second = await secondPassWaybill1t(
      originalFiles,
      { sourceDocumentId: techId, bundleId },
      log,
    );
    if (second) {
      parsed = second.parsed;
      llmProviderId = second.llmProviderId ?? llmProviderId;
    }
  }

  // Waybill-промпт строго понимает только ТН-2116 и ОС-2. Пустой ответ не
  // доказывает, что файл не документ: старый роутер отправлял сюда ТОРГ-12 и
  // реализации товаров по одному слову «Грузоотправитель». Даём такому файлу
  // один шанс в общем УПД-пути, сохраняя kind='transport_waybill' — в UI он
  // по-прежнему остаётся «Накладной».
  if (parsed.documents.length === 0) {
    const [original] = await db
      .select({ s3Key: sourceDocumentAttachments.s3Key })
      .from(sourceDocumentAttachments)
      .where(
        and(
          eq(sourceDocumentAttachments.sourceDocumentId, techId),
          eq(sourceDocumentAttachments.role, 'original'),
        ),
      )
      .limit(1);
    const reason = 'ТН и ОС-2 не найдены — пробуем общий разбор товарного документа';

    // Без оригинала общий путь запустить невозможно. Это единственная ветка,
    // где остаётся no_waybill_found: реального файла нет, повторять нечего.
    if (!original) {
      await db.transaction(async (tx) => {
        await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
        await tx
          .update(sourceDocuments)
          .set({
            status: 'parse_failed',
            parseErrorCode: 'no_waybill_found',
            parseErrorDetails: { message: reason },
            llmProviderId,
            llmConfidence: '0',
            processedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(sourceDocuments.id, techId));
        await tx
          .update(sourceBundles)
          .set({
            status: 'parse_failed',
            parseErrorCode: 'no_waybill_found',
            parseErrorMessage: 'в пакете не найден оригинальный файл для fallback',
            updatedAt: new Date(),
          })
          .where(eq(sourceBundles.id, bundleId));
        await markSubBundleItemsFailed(tx as unknown as typeof db, bundleId, reason);
      });
      log.warn('no waybill found and no original available for UPD fallback');
      return;
    }

    const docGeneration = 0;
    const dedupeKey = dispatchKeyOf(techId, docGeneration);
    await db.transaction(async (tx) => {
      await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
      await tx
        .update(sourceDocuments)
        .set({
          isTechnical: false,
          status: 'queued',
          parseErrorCode: null,
          parseErrorDetails: null,
          queuedAt: new Date(),
          processedAt: null,
          jobId: dedupeKey,
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, techId));
      await enqueueJob(tx as unknown as typeof db, {
        queue: UPD_PARSE_QUEUE,
        jobName: 'parse',
        payload: {
          sourceDocumentId: techId,
          s3Key: original.s3Key,
          docGeneration,
        },
        dedupeKey,
      });
      // Как и у обычного одиночного УПД, пакет отражает факт маршрутизации, а
      // финальный статус распознавания живёт в source_documents.
      await tx
        .update(sourceBundles)
        .set({
          status: 'parsed',
          docCount: 1,
          parseErrorCode: null,
          parseErrorMessage: null,
          updatedAt: new Date(),
        })
        .where(eq(sourceBundles.id, bundleId));
      await markSubBundleItemDocumented(tx as unknown as typeof db, bundleId, techId, reason);
    });
    log.warn('no waybill found — queued common document fallback');
    await notifySourceDocumentUpdated(techId);
    return;
  }

  // Создаём N source_documents по одному на каждый элемент массива.
  // Атачменты пакета прикрепляем к каждому из них (все ко всем) —
  // оператор в карточке любого документа видит весь пакет.
  const created: { id: string; docNumber: string | null; form: string }[] = [];
  for (const [index, doc] of parsed.documents.entries()) {
    const newId = await createSourceDocumentFromWaybill({
      doc,
      bundleId,
      bundle,
      bundleGeneration,
      llmProviderId,
      // Позиция в ответе модели. Нужна повторному распознаванию: по ней он
      // находит «свой» документ, когда в одном файле их несколько. Номер для
      // этого не годится — неверно распознанный номер и есть повод для повтора.
      batchIndex: index,
      waybillPromptKind: promptKind,
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
    await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
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
    await tx
      .update(sourceBundles)
      .set({ status: 'parsed', docCount: created.length, updatedAt: new Date() })
      .where(
        and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, bundleGeneration)),
      );
  });

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

async function recordImportItemForAttempt(
  bundleId: string,
  bundleGeneration: number,
  file: RouterInputFile,
  outcome: ImportItemOutcome,
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db;
    await fenceBundleAttempt(tx, bundleId, bundleGeneration);
    await recordImportItem(tx, bundleId, file, outcome);
  });
}

async function recordRecognitionEvidence(args: {
  bundleId: string;
  sourceDocumentId?: string | null;
  generation: number;
  evidenceType: 'file_classification' | 'page_classification' | 'assembly_rollback';
  payload: Record<string, unknown>;
}): Promise<void> {
  await db.insert(recognitionEvidenceEvents).values({
    bundleId: args.bundleId,
    sourceDocumentId: args.sourceDocumentId ?? null,
    generation: args.generation,
    evidenceType: args.evidenceType,
    payload: args.payload,
  });
}

/**
 * Журнал одного vision-вызова классификации страниц сборки.
 *
 * Одиночный путь такую запись делает давно (upd-vision.parser), а сборка — нет:
 * сырой ответ модели там просто выбрасывался, и разобрать инцидент «почему
 * страница названа оборотом» было нечем. Пишем её и здесь.
 *
 * source_document_id на этом этапе НЕТ: документы сегментов ещё не созданы, а
 * классификация относится к пакету целиком. Поэтому адрес пакета кладём в
 * responseParsed — иначе запись не связать ни с чем.
 *
 * Ошибку вставки глушим: журнал не может быть причиной развала сборки.
 */
async function recordAssemblyClassifyCall(args: {
  bundleId: string;
  generation: number;
  subBundleId: string | null;
  providerId: string;
  model: string;
  chunkIndex: number;
  pageCount: number;
  raw: string | null;
  classification: PageClassification[];
  promptTokens: number | null;
  completionTokens: number | null;
  finishReason: string | null;
  latencyMs: number;
  log: WorkerLog;
}): Promise<void> {
  try {
    await db.insert(llmCalls).values({
      sourceDocumentId: null,
      providerId: args.providerId,
      promptId: null,
      docKind: 'upd_page_classify',
      model: args.model,
      requestMessages: [
        {
          role: 'user',
          content: `[upd assembly page classify: bundle=${args.bundleId}, generation=${args.generation}, chunk=${args.chunkIndex}, pages=${args.pageCount}]`,
        },
      ],
      requestSchema: null,
      responseRaw: args.raw,
      responseParsed: {
        bundleId: args.bundleId,
        generation: args.generation,
        subBundleId: args.subBundleId,
        chunkIndex: args.chunkIndex,
        pageCount: args.pageCount,
        finishReason: args.finishReason,
        classification: args.classification,
      } as object,
      promptTokens: args.promptTokens,
      completionTokens: args.completionTokens,
      latencyMs: args.latencyMs,
    });
  } catch (err) {
    args.log.warn(
      { err: err instanceof Error ? err.message : String(err), chunk: args.chunkIndex },
      'сборка УПД: не удалось записать журнал классификации страниц',
    );
  }
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
 * Инвариант видимости: по каждому принятому файлу заводим документ, если его
 * так и не появилось.
 *
 * Ошибка по одному файлу не должна ронять разбор всей пачки и не должна
 * прерывать проход по остальным: инвариант перепроверяется периодически
 * (repairStuckJobs), поэтому здесь достаточно записать её в лог.
 *
 * Возвращает число заведённых документов — router считает их в docCount пакета.
 */
async function ensureDocumentsForBundleFiles(
  bundleId: string,
  bundleGeneration: number,
  bundle: typeof sourceBundles.$inferSelect,
  log: WorkerLog,
): Promise<number> {
  let created = 0;
  try {
    const rows = await selectRowsWithoutDocument(db, { bundleId });
    for (const row of rows) {
      try {
        const res = await ensureDocumentForRegistryRow({
          db,
          row,
          bundle,
          reason: stubReasonForRow(row),
          expectedDispatchGeneration: bundleGeneration,
        });
        if (res.action === 'created' || res.action === 'promoted') {
          created++;
          log.info(
            { file: row.filename, documentId: res.documentId, how: res.action },
            'файл без документа → показан',
          );
        } else if (res.action === 'missing_object') {
          log.warn(
            { file: row.filename, s3Key: row.s3Key },
            'файл без документа: объекта нет в S3',
          );
        }
      } catch (err) {
        log.error({ err, file: row.filename }, 'не удалось завести документ по файлу');
      }
    }
  } catch (err) {
    log.error({ err, bundleId }, 'проверка «у каждого файла есть документ» не выполнена');
  }
  return created;
}

/**
 * Инвариант завершённости: пакет не считается разобранным, пока в реестре есть
 * строки «в процессе». Ошибку глушим — она не повод валить разбор, тот же
 * инвариант перепроверяется периодически (repairStuckJobs).
 */
async function closeStaleRegistryItems(
  bundleId: string,
  bundleGeneration: number,
  log: WorkerLog,
  opts?: { reason?: string },
): Promise<void> {
  try {
    const stale = await finalizeStaleRegistryItems(db, bundleId, {
      ...opts,
      expectedDispatchGeneration: bundleGeneration,
    });
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
export async function handleDocumentRouterJob(
  bundleId: string,
  bundleGenerationOrLog: number | WorkerLog,
  maybeLog?: WorkerLog,
): Promise<void> {
  const bundleGeneration = typeof bundleGenerationOrLog === 'number' ? bundleGenerationOrLog : 0;
  const log = typeof bundleGenerationOrLog === 'number' ? maybeLog! : bundleGenerationOrLog;
  const [bundle] = await db
    .update(sourceBundles)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(
      and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, bundleGeneration)),
    )
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
      .where(
        and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, bundleGeneration)),
      );
    log.warn('router bundle: нечего разбирать — parse_failed');
    return;
  }

  // Дата поставки здесь НЕ вычисляется: она читается из БД внутри каждой
  // транзакции создания документа (resolveMachineExpectedDate). Значение,
  // снятое со строки пакета один раз на весь разбор, устаревало ровно так же,
  // как объект: менеджер правит дату, задание в этот момент ждёт fence — и
  // документ ложился со старым днём, разводя машину по датам.

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
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db;
      await fenceBundleAttempt(tx, bundleId, bundleGeneration);
      await rawTx
        .delete(bundleImportItems)
        .where(
          and(eq(bundleImportItems.bundleId, bundleId), isNull(bundleImportItems.uploadGeneration)),
        );
    });
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
      await recordImportItemForAttempt(bundleId, bundleGeneration, a, {
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
        await recordImportItemForAttempt(bundleId, bundleGeneration, a, {
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
        cls = await classifyFile(buffer, a.mimeType ?? '', a.filename, {
          excelRouting: loadEnv().EXCEL_VISION_ROUTING,
          // Отдельный рубильник: этот маршрут работает по тексту, после
          // структурной пробы, и трогает только книги, которые иначе стали бы
          // заглушкой «не распознано» (см. lib/env.ts).
          excelWaybillTextRoute: loadEnv().EXCEL_WAYBILL_TEXT_ROUTE,
        });
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
        // Excel классификатору изображения не показать — сначала рендерим книгу
        // в PDF тем же конвертером, что и разбор. Только под флагом: без него
        // книга с сигналом 'excel:not-upd' идёт в заглушку, как раньше.
        const excelExt = excelExtOf(a.mimeType ?? '', a.filename);
        const excelRouting = excelExt != null && loadEnv().EXCEL_VISION_ROUTING;
        let visionBuffer: Buffer | null = buffer;
        let visionMime = a.mimeType ?? '';
        if (excelExt != null) {
          visionBuffer = null;
          if (excelRouting) {
            try {
              visionBuffer = await convertExcelToPdf(buffer, excelExt);
              visionMime = 'application/pdf';
            } catch (err) {
              log.warn({ err, file: a.filename }, 'excel→pdf для доклассификации не удался');
            }
          }
        }

        const vc = visionBuffer
          ? await classifyImageKind(visionBuffer, visionMime, { sourceDocumentId: null })
          : null;
        if (vc && vc.confidence >= 0.6 && vc.kind !== 'unknown') {
          // Excel умеет только УПД-путь: parseWaybillBatch принимает изображения
          // и PDF, а книгу не примет. Поэтому для Excel любой товарный вердикт
          // модели означает «отдать в общий разбор», где уже отработает связка
          // «структурный парсер → Excel→PDF→Vision».
          const routedKind = excelRouting && vc.kind !== 'supplementary' ? 'upd' : vc.kind;
          cls = {
            ...cls,
            detectedKind: routedKind,
            // Уверенность тоже от модели: раньше в журнал уезжало исходное 0
            // или 0.3 — число, к принятому решению отношения не имеющее.
            confidence: vc.confidence,
            signals: [
              ...cls.signals,
              `vision-kind:${vc.kind}:${vc.confidence.toFixed(2)}`,
              ...(routedKind !== vc.kind ? [`excel-routed:${routedKind}`] : []),
            ],
          };
        }
      }

      // Накладная (по тексту ИЛИ по vision-доклассификации) → waybill-парсер.
      // Подтверждённое УПД — в УПД-flow (ветка else): парсер сам покрывает
      // Excel (parseUpdXlsx), текстовый PDF (parseUpdPdf) и скан/фото/битый
      // текстовый слой (parseUpdVision). Благодаря этому сканы, фото и PDF с
      // «битыми» глифами 1С НЕ теряются, а распознаются. Главное — на КАЖДЫЙ
      // файл создаётся видимая строка (12 загрузил → 12 строк).
      await recordRecognitionEvidence({
        bundleId,
        generation: bundleGeneration,
        evidenceType: 'file_classification',
        payload: {
          registryItemId: a.registryItemId,
          uploadGeneration: bundle.activeUploadGeneration,
          filename: a.filename,
          detectedKind: cls.detectedKind,
          confidence: cls.confidence,
          needsVision: cls.needsVision,
          parserUsed: cls.parserUsed,
          signals: cls.signals,
        },
      });

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
          await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
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
            siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
            expectedDate: await resolveMachineExpectedDate(tx as unknown as Db, bundleId),
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
        await recordImportItemForAttempt(bundleId, bundleGeneration, a, {
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
          await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
          await tx.insert(sourceDocuments).values({
            id: docId,
            kind: 'transport_waybill',
            direction: bundle.direction,
            origin: bundleOrigin,
            status: 'queued',
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            recipientSource: manualRecipientSource(bundle),
            siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
            expectedDate: await resolveMachineExpectedDate(tx as unknown as Db, bundleId),
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
        await createWaybillSubBundle({
          bundleId,
          bundleGeneration,
          bundle,
          bundleOrigin,
          file: a,
          detectedKind: cls.detectedKind,
          confidence: cls.confidence,
          signals: cls.signals,
          reason: 'накладная → waybill-парсер',
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
        await createSingleUpdDocument({
          bundleId,
          bundleGeneration,
          bundle,
          bundleOrigin,
          file: a,
          cls,
        });
        createdCount++;
      }
    } catch (err) {
      if (err instanceof StaleBundleAttemptError) {
        log.info({ bundleId, bundleGeneration }, 'router: устаревшая попытка остановлена');
        return;
      }
      log.error(
        { err: err instanceof Error ? err.message : String(err), file: a.filename },
        'router: ошибка обработки файла — помечаем failed, продолжаем',
      );
      await recordImportItemForAttempt(bundleId, bundleGeneration, a, {
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
        bundleGeneration,
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
            bundleGeneration,
            bundle,
            bundleOrigin,
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
      await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
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
  await closeStaleRegistryItems(bundleId, bundleGeneration, log);

  // Инвариант видимости: у каждого принятого файла есть документ. Ветки выше
  // его местами не создают — зона «Дополнительные документы», сертификат,
  // сорвавшееся скачивание, исключение по файлу, строка, не дошедшая до
  // разбора. Такой файл лежит в S3, а менеджер видит «ничего не пришло».
  // Проверка одна на все ветки: латать каждую по отдельности ненадёжно, седьмая
  // появится со следующей фичей.
  const documented = await ensureDocumentsForBundleFiles(bundleId, bundleGeneration, bundle, log);
  createdCount += documented;

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
    .where(
      and(eq(sourceBundles.id, bundleId), eq(sourceBundles.dispatchGeneration, bundleGeneration)),
    );
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
    mime.startsWith('image/') || mime === 'application/pdf' || /\.(jpe?g|png|webp|pdf)$/i.test(name)
  );
}

/**
 * Разворачивает файл в waybill-flow: дочерний пакет + служебный документ +
 * задание разбора накладной. Это тот же путь, которым идёт «Загрузить
 * накладные», и единственный способ отдать файл парсеру накладных.
 *
 * Вынесено из router, потому что вызывающих стало два: сам router и откат
 * сборки. До этого откат умел только `createSingleUpdDocument`, то есть любой
 * файл — даже целиком состоящий из страниц транспортной накладной — уезжал в
 * УПД-парсер с видом «УПД».
 */
async function createWaybillSubBundle(args: {
  bundleId: string;
  bundleGeneration: number;
  bundle: typeof sourceBundles.$inferSelect;
  bundleOrigin: NonNullable<typeof sourceBundles.$inferSelect.origin>;
  file: RouterInputFile;
  detectedKind: string;
  confidence: number;
  signals: string[];
  /** Причина в реестре: у отката она своя. */
  reason: string;
}): Promise<string> {
  const {
    bundleId,
    bundleGeneration,
    bundle,
    bundleOrigin,
    file: a,
    detectedKind,
    confidence,
    signals,
    reason,
  } = args;
  const subHash = createHash('sha256')
    .update(`router:${bundleId}:${bundle.activeUploadGeneration}:${a.s3Key}`)
    .digest('hex');
  const subId = randomUUID();
  const subTechId = randomUUID();
  const subJobId = bundleDispatchKeyOf(subId, 0);
  await db.transaction(async (tx) => {
    await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
    // Дата машины — из БД и ОДИН раз на всю транзакцию: пакет и его
    // служебная запись обязаны получить одно значение, а строка пакета,
    // прочитанная до транзакции, могла устареть (менеджер как раз правил
    // дату). То же соображение, что и у resolveMachineSiteId.
    const machineExpected = await resolveMachineExpectedDate(tx as unknown as Db, bundleId);
    await tx.insert(sourceBundles).values({
      id: subId,
      bundleHash: subHash,
      kind: 'waybill',
      direction: bundle.direction,
      // Дочерний пакет наследует происхождение родителя — иначе накладная
      // из письма после разбора выглядела бы загруженной вручную.
      origin: bundle.origin,
      parentBundleId: bundleId,
      siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
      contractorId: bundle.contractorId,
      recipientMolId: bundle.recipientMolId,
      expectedDate: machineExpected,
      status: 'queued',
      jobId: subJobId,
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
      siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
      expectedDate: machineExpected,
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
      payload: { bundleId: subId, bundleGeneration: 0 },
      dedupeKey: subJobId,
    });
    await recordImportItem(tx as unknown as typeof db, bundleId, a, {
      detectedKind,
      confidence: confidence.toString(),
      parserUsed: 'parseWaybillBatch',
      status: 'created',
      createdDocumentIds: [],
      // Итоговый документ появится в ДОЧЕРНЕМ пакете, поэтому связь на
      // него явная: по bundle_id родителя его не найти.
      subBundleId: subId,
      reason,
      metadata: { signals, subBundleId: subId },
    });
  });
  return subId;
}

/** Одиночный путь «файл = документ»: документ, вложение, задание, реестр. */
async function createSingleUpdDocument(args: {
  bundleId: string;
  bundleGeneration: number;
  bundle: typeof sourceBundles.$inferSelect;
  bundleOrigin: NonNullable<typeof sourceBundles.$inferSelect.origin>;
  file: RouterInputFile;
  cls: FileClassification;
  /** Пакет попытки может отличаться от пакета создаваемого документа при rollback. */
  attemptBundleId?: string;
  attemptBundleGeneration?: number;
  /** Причина в реестре: у отката она своя. */
  reasonOverride?: string;
}): Promise<string> {
  const { bundleId, bundleGeneration, bundle, bundleOrigin, file: a, cls } = args;
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
    await fenceBundleAttempt(
      tx as unknown as typeof db,
      args.attemptBundleId ?? bundleId,
      args.attemptBundleGeneration ?? bundleGeneration,
    );
    await tx.insert(sourceDocuments).values({
      id: docId,
      kind: 'upd',
      direction: bundle.direction,
      origin: bundleOrigin,
      status: 'queued',
      contractorId: bundle.contractorId,
      recipientMolId: bundle.recipientMolId,
      recipientSource: manualRecipientSource(bundle),
      siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
      expectedDate: await resolveMachineExpectedDate(tx as unknown as Db, bundleId),
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
  bundleGeneration: number;
  bundle: typeof sourceBundles.$inferSelect;
  bundleOrigin: NonNullable<typeof sourceBundles.$inferSelect.origin>;
  candidates: { file: RouterInputFile; cls: FileClassification }[];
  log: WorkerLog;
}): Promise<void> {
  const { bundleId, bundleGeneration, bundle, bundleOrigin, candidates, log } = args;
  const root = await resolveRootBundle(db, bundleId);
  if (!root) throw new Error('сборка УПД: не найден корневой пакет');
  const generation = root.activeUploadGeneration;

  const subHash = createHash('sha256').update(`assembly:${root.id}:${generation}`).digest('hex');

  const subId = randomUUID();
  const techId = randomUUID();
  const assemblyJobId = assemblyDispatchKeyOf(subId, 0);

  await db.transaction(async (tx) => {
    await fenceBundleAttempt(tx as unknown as typeof db, bundleId, bundleGeneration);
    // Дата машины — из БД и один раз на транзакцию: дочерний пакет и его
    // служебная запись обязаны совпасть, а значение из памяти могло устареть,
    // пока задание ждало fence (см. resolveMachineExpectedDate).
    const machineExpected = await resolveMachineExpectedDate(tx as unknown as Db, bundleId);
    const inserted = await tx
      .insert(sourceBundles)
      .values({
        id: subId,
        bundleHash: subHash,
        kind: 'upd',
        direction: bundle.direction,
        origin: bundle.origin,
        parentBundleId: bundleId,
        siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
        contractorId: bundle.contractorId,
        recipientMolId: bundle.recipientMolId,
        expectedDate: machineExpected,
        status: 'queued',
        jobId: assemblyJobId,
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
      siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
      expectedDate: machineExpected,
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
      payload: { bundleId: subId, mode: 'upd_assembly', generation, bundleGeneration: 0 },
      dedupeKey: assemblyJobId,
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
  subBundleId: string;
  bundleGeneration: number;
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
  job: {
    segmentId: string;
    generation: number;
    dispatchGeneration: number;
    bundleGeneration?: number;
    reparse?: boolean;
  },
): Promise<SegmentJobContext | null> {
  const [seg] = await db
    .select()
    .from(bundleSegments)
    .where(eq(bundleSegments.id, job.segmentId))
    .limit(1);
  if (!seg) return null; // манифест снят откатом
  if (seg.generation !== job.generation) return null;
  if (seg.dispatchGeneration !== job.dispatchGeneration) return null;
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

  const [attemptBundle] = await db
    .select({
      id: sourceBundles.id,
      dispatchGeneration: sourceBundles.dispatchGeneration,
    })
    .from(sourceDocuments)
    .innerJoin(sourceBundles, eq(sourceBundles.id, sourceDocuments.bundleId))
    .where(eq(sourceDocuments.id, sourceDocumentId))
    .limit(1);
  if (!attemptBundle) return null;
  if (
    job.bundleGeneration !== undefined &&
    attemptBundle.dispatchGeneration !== job.bundleGeneration
  )
    return null;
  // Ручной повтор опубликованного комплекта проверяется иначе.
  //
  // Проверки ниже стерегут ОДНО: «сборка ещё идёт, и задание не опоздало». Для
  // повтора это условие ложно по определению — комплект давно опубликован, а
  // документ перестал быть техническим. Но то, ради чего проверки существуют —
  // что манифест принадлежит этому документу и относится к активному поколению
  // пакета, — уже подтверждено выше и остаётся в силе. Единственное, что
  // добавляется: не вмешиваться, пока комплект пересобирают.
  if (job.reparse) {
    if (root.status === 'processing') return null;
  } else {
    // Сравнение с ЭТИМ поколением, а не с null — третье место с той же
    // ошибкой, что уже исправлена в гейте сборки и в tryFinalizeUpdAssembly.
    //
    // `published !== null` означает «пакет когда-либо публиковался». Повторная
    // отправка того же комплекта поднимает активное поколение, а published
    // остаётся на прошлом номере, — и задания сегментов НОВОГО поколения
    // отбрасывались здесь как «неактуальные». Пакет навсегда застревал в
    // processing: сегменты не разбирались, публиковать было нечего, документы
    // не появлялись ни на портале, ни на планшете. В логе это видно строкой
    // «сегмент сборки: задание неактуально — пропускаем».
    if (root.published === job.generation) return null;
    if (root.status !== 'processing') return null;

    const [doc] = await db
      .select({ id: sourceDocuments.id, isTechnical: sourceDocuments.isTechnical })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, sourceDocumentId))
      .limit(1);
    // Документ уже опубликован (isTechnical снят) — значит комплект закрыт, а
    // это задание опоздало.
    if (!doc || !doc.isTechnical) return null;
  }

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
    subBundleId: attemptBundle.id,
    bundleGeneration: attemptBundle.dispatchGeneration,
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
      pages.push(await imageToVisionPage(buf));
    }
  }
  if (pages.length === 0) throw new Error('сегмент: не удалось собрать ни одной страницы');
  return pages;
}

/** Ключи OpenRouter для классификации страниц. null — работать нечем. */
async function resolveOpenRouterCreds(): Promise<{
  // Нужен только журналу: llm_calls.provider_id ссылается на llm_providers,
  // а без него запись классификации сборки не связать с провайдером.
  providerId: string;
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
      providerId: provider.id,
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
    const rendered = isPdf ? await renderPdf(buffer, {}) : [await imageToVisionPage(buffer)];
    for (const [idx, full] of rendered.entries()) {
      if (pages.length >= maxTotalPages) {
        throw new Error(`пакет содержит больше ${maxTotalPages} страниц — сборка не запускается`);
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

// Отметка правила нарезки в улике. Меняется вместе с правилом, а не с кодом
// вообще: по ней на бою отличают пакеты, нарезанные прежним «по типу
// страницы», от нарезанных с учётом номера документа.
const ASSEMBLY_PLANNER_VERSION = 'page_type_v1';

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
  bundleGenerationOrLog: number | WorkerLog,
  maybeLog?: WorkerLog,
): Promise<void> {
  const bundleGeneration = typeof bundleGenerationOrLog === 'number' ? bundleGenerationOrLog : 0;
  const log = typeof bundleGenerationOrLog === 'number' ? maybeLog! : bundleGenerationOrLog;
  const [sub] = await db
    .select()
    .from(sourceBundles)
    .where(
      and(
        eq(sourceBundles.id, subBundleId),
        eq(sourceBundles.dispatchGeneration, bundleGeneration),
      ),
    )
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
    // Сравнение с ЭТИМ поколением, а не с null.
    //
    // `publishedGeneration !== null` означало «пакет когда-либо публиковался»,
    // и после первой же публикации сборка отказывалась работать навсегда.
    // Повторная отправка того же комплекта поднимает активное поколение, но
    // published остаётся на прошлом номере — гейт видел «не null» и выходил
    // ЗДЕСЬ, единственной веткой, которая не проходит через rollbackUpdAssembly.
    // Файлы оставались без разбора и получали заглушки «не распознано».
    //
    // Та же форма сравнения уже используется в tryFinalizeUpdAssembly — там она
    // изначально была написана верно, разъехались только эти два места.
    if (root.publishedGeneration === generation) {
      return { ok: false as const, reason: 'поколение уже опубликовано' };
    }
    const [claimed] = await tx
      .update(sourceBundles)
      .set({ status: 'processing', updatedAt: new Date() })
      .where(
        and(
          eq(sourceBundles.id, subBundleId),
          eq(sourceBundles.dispatchGeneration, bundleGeneration),
        ),
      )
      .returning({ id: sourceBundles.id });
    if (!claimed) return { ok: false as const, reason: 'поколение задания устарело' };
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
        bundleGeneration,
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
        bundleGeneration,
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
        bundleGeneration,
        reason: `не удалось подготовить страницы: ${err instanceof Error ? err.message : String(err)}`,
        log,
      });
      return;
    }

    // Классификация порциями. Смещение номеров обязательно: classifyPages в
    // каждом вызове нумерует страницы заново с единицы и про предыдущие порции
    // ничего не знает.
    const splitMode = loadEnv().UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER;
    const chunks: PageClassification[][] = [];
    const chunkSizes: number[] = [];
    // Метаданные каждой порции — для улики: по ним видно, обрезан ли ответ,
    // сколько стоил вызов и сколько он занял.
    const chunkMeta: Array<{
      chunkIndex: number;
      pageCount: number;
      finishReason: string | null;
      promptTokens: number | null;
      completionTokens: number | null;
      latencyMs: number;
      rawLength: number | null;
    }> = [];
    try {
      for (let i = 0; i < pages.length; i += ASSEMBLY_CLASSIFY_CHUNK) {
        const slice = pages.slice(i, i + ASSEMBLY_CLASSIFY_CHUNK);
        const chunkIndex = chunks.length;
        const startedAt = Date.now();
        const res = await classifyPages({
          apiBaseUrl: creds.apiBaseUrl,
          apiKey: creds.apiKey,
          model: creds.model,
          thumbs: slice.map((p) => p.thumb),
          // Номера спрашиваем и в shadow: без них теневой план ничем не
          // отличался бы от применяемого и не сказал бы ничего нового.
          // Промпт передаётся ЯВНО и только здесь — одиночный путь и
          // prefilter остаются на прежнем тексте при любом значении флага.
          ...(splitMode === 'off'
            ? {}
            : {
                prompt: PAGE_CLASSIFY_WITH_NUMBER_PROMPT,
                maxTokens: loadEnv().UPD_ASSEMBLY_CLASSIFY_MAX_TOKENS,
              }),
        });
        const latencyMs = Date.now() - startedAt;
        chunks.push(res.classification);
        chunkSizes.push(slice.length);
        chunkMeta.push({
          chunkIndex,
          pageCount: slice.length,
          finishReason: res.finishReason,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          latencyMs,
          rawLength: res.raw?.length ?? null,
        });
        await recordAssemblyClassifyCall({
          bundleId: rootId,
          generation,
          subBundleId,
          providerId: creds.providerId,
          model: creds.model,
          chunkIndex,
          pageCount: slice.length,
          raw: res.raw,
          classification: res.classification,
          promptTokens: res.promptTokens,
          completionTokens: res.completionTokens,
          finishReason: res.finishReason,
          latencyMs,
          log,
        });
      }
    } catch (err) {
      await rollbackUpdAssembly({
        rootId,
        subBundleId,
        generation,
        bundleGeneration,
        reason: `классификация страниц не удалась: ${err instanceof Error ? err.message : String(err)}`,
        log,
      });
      return;
    }

    const classification = mergeClassificationChunks(chunks, chunkSizes);
    // Карта «страница → файл» нужна перестановке: переставлять можно только
    // файлы целиком, порядок листов внутри PDF задан самим документом.
    const pageOwners = new Map(pages.map((page) => [page.globalPage, page.ref.inputOrder]));
    const plan = planUpdSegments(classification, pages.length, MAX_PAGES_FOR_OPENROUTER_SEGMENT, {
      pageOwners,
      reorder: loadEnv().UPD_ASSEMBLY_REORDER_V1,
      splitByDocNumber: splitMode === 'on',
    });
    // В shadow считаем ВТОРОЙ план — тот, что получился бы с разрезами по
    // номеру, — и записываем расхождение. Применяется по-прежнему первый:
    // решение о включении принимается по накопленным расхождениям, а не на
    // боевом трафике вслепую.
    const shadowPlan =
      splitMode === 'shadow'
        ? planUpdSegments(classification, pages.length, MAX_PAGES_FOR_OPENROUTER_SEGMENT, {
            pageOwners,
            reorder: loadEnv().UPD_ASSEMBLY_REORDER_V1,
            splitByDocNumber: true,
          })
        : null;
    await recordRecognitionEvidence({
      bundleId: rootId,
      generation,
      evidenceType: 'page_classification',
      payload: {
        subBundleId,
        bundleGeneration,
        classification,
        pageMap: pages.map((page) => ({ globalPage: page.globalPage, ...page.ref })),
        segments: plan.segments,
        confident: plan.confident,
        reasons: plan.reasons,
        // Страницы, исключённые как чужие. Единственное место, где они вообще
        // сохраняются: аудит нумерации читает их отсюда при публикации.
        droppedPages: plan.droppedPages,
        // Каким правилом нарезан пакет. Флаг в env кэшируется и действует
        // только на новые манифесты, поэтому после его переключения понять
        // происхождение конкретной нарезки можно лишь по этой отметке.
        plannerVersion: splitMode === 'on' ? 'doc_number_v1' : ASSEMBLY_PLANNER_VERSION,
        splitMode,
        chunks: chunkMeta,
        ...(shadowPlan
          ? {
              shadow: {
                segments: shadowPlan.segments,
                confident: shadowPlan.confident,
                reasons: shadowPlan.reasons,
              },
              diff: {
                segmentsApplied: plan.segments.length,
                segmentsShadow: shadowPlan.segments.length,
                confidentApplied: plan.confident,
                confidentShadow: shadowPlan.confident,
                // Где именно теневой план поставил бы границу — это и есть
                // список для ручной сверки с исходным PDF перед включением.
                wouldSplit: shadowPlan.segments
                  .filter((seg) => seg.reasons[0] === 'opened_by_doc_number_change')
                  .map((seg) => ({
                    atPage: seg.pages[0] ?? null,
                    segmentIndex: seg.segmentIndex,
                    docNumber: seg.docNumber ?? null,
                  })),
                numbersRead: classification.filter((c) => c.docNumber != null).length,
                numbersReadMain: classification.filter(
                  (c) => c.type === 'upd_main' && c.docNumber != null,
                ).length,
                pagesMain: classification.filter((c) => c.type === 'upd_main').length,
                pagesTotal: pages.length,
              },
            }
          : {}),
      },
    });
    if (!plan.confident) {
      await rollbackUpdAssembly({
        rootId,
        subBundleId,
        generation,
        bundleGeneration,
        reason: `нарезке нельзя доверять: ${plan.reasons.join('; ')}`,
        log,
      });
      return;
    }

    // Манифест пишется целиком или не пишется вовсе. Посегментная вставка
    // «кто успел» склеила бы результаты двух классификаций в один гибридный
    // комплект — с чужими страницами внутри документа.
    const written = await db.transaction(async (tx) => {
      await fenceBundleAttempt(tx as unknown as typeof db, subBundleId, bundleGeneration);
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
          // Номер, увиденный классификатором на страницах сегмента. Колонка
          // существует с миграции 0096 и до сих пор пустовала; теперь по ней
          // сверяют, тот ли документ извлёк парсер, и видят номер, которому
          // не нашлось карточки.
          docNumber: seg.docNumber ?? null,
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
    const dedupeKey = segmentDispatchKeyOf(seg.id, 0);
    await db.transaction(async (tx) => {
      await fenceBundleAttempt(tx as unknown as typeof db, subBundleId, bundleGeneration);
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
        siteId: await resolveMachineSiteId(tx as unknown as Db, subBundleId),
        expectedDate: await resolveMachineExpectedDate(tx as unknown as Db, subBundleId),
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
        payload: {
          sourceDocumentId: docId,
          segmentId: seg.id,
          generation,
          segmentGeneration: 0,
          docGeneration: 0,
          bundleGeneration,
        },
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
 * Склеивает сегменты, которые после распознавания оказались одной УПД.
 * Исходные строки не удаляются: лишние документы остаются техническими и
 * архивируются с mergedInto, поэтому результат обратим и полностью аудируем.
 */
/**
 * «Всего наименований», прочитанное из бланка, — из сохранённого снимка
 * валидации сегмента.
 *
 * Колонки под это число нет: оно живёт только внутри результата распознавания
 * и попадает в validation.checks как ожидание проверки items_count. После
 * склейки взять его больше неоткуда, а без него проверка полноты списка
 * сравнивает число строк само с собой.
 */
function declaredItemsCountOf(validation: unknown): number | null {
  if (validation == null || typeof validation !== 'object') return null;
  const checks = (validation as { checks?: unknown }).checks;
  if (!Array.isArray(checks)) return null;
  for (const check of checks) {
    if (check == null || typeof check !== 'object') continue;
    const row = check as { name?: unknown; expected?: unknown };
    if (row.name !== 'items_count') continue;
    return typeof row.expected === 'number' ? row.expected : null;
  }
  return null;
}

async function consolidateAssemblyDocuments(
  tx: typeof db,
  segments: Array<{
    id: string;
    segmentIndex: number;
    docId: string | null;
    pageRefs: unknown;
  }>,
  docs: Array<{
    id: string;
    status: string;
    parseErrorCode: string | null;
    parseErrorDetails: Record<string, unknown> | null;
    supplierDirectoryId: string | null;
    docNumber: string | null;
    docDate: Date | null;
    totalSum: string | null;
    vatSum: string | null;
    validation: unknown;
    llmConfidence: string | null;
  }>,
): Promise<string[]> {
  const orderedSegments = [...segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const initialDocIds = orderedSegments
    .map((segment) => segment.docId)
    .filter((id): id is string => id != null);
  if (initialDocIds.length < 2) return initialDocIds;

  const [items, attachments] = await Promise.all([
    tx
      .select()
      .from(sourceDocumentItems)
      .where(inArray(sourceDocumentItems.sourceDocumentId, initialDocIds))
      .orderBy(sourceDocumentItems.lineNo),
    tx
      .select()
      .from(sourceDocumentAttachments)
      .where(inArray(sourceDocumentAttachments.sourceDocumentId, initialDocIds)),
  ]);
  const docById = new Map(docs.map((doc) => [doc.id, doc]));
  // Рубильник фазы: при выключенном работает прежнее правило склейки — то, что
  // сейчас на бою. UPD_ASSEMBLY_V1 для этого не годится, он включает сборку
  // страниц целиком.
  const copyDedup = loadEnv().UPD_ASSEMBLY_COPY_DEDUP_V1;
  const plan = copyDedup ? planAssemblyDocumentMerges : planAssemblyDocumentMergesLegacy;
  const actions = plan(
    initialDocIds.flatMap((id) => {
      const doc = docById.get(id);
      return doc
        ? [
            {
              id,
              supplierDirectoryId: doc.supplierDirectoryId,
              docNumber: doc.docNumber,
              docDate: doc.docDate,
              declaredTotal: doc.totalSum,
              items: items
                .filter((item) => item.sourceDocumentId === id)
                .map((item) => ({
                  id: item.id,
                  nameRaw: item.nameRaw,
                  qty: item.qty,
                  sum: item.sum,
                  unit: item.unit,
                  price: item.price,
                  rowNo: item.rowNo,
                })),
            },
          ]
        : [];
    }),
  );
  if (actions.length === 0) return initialDocIds;

  const publishedIds = new Set(initialDocIds);
  for (const action of actions) {
    const groupIds = new Set(action.documentIds);
    const keeper = docById.get(action.keeperId)!;
    const selectedItemIds = new Set(action.itemIds);
    const keptItems = items.filter((item) => selectedItemIds.has(item.id));
    const keeperItems = keptItems.filter((item) => item.sourceDocumentId === action.keeperId);
    const missingItems = keptItems.filter((item) => item.sourceDocumentId !== action.keeperId);

    // Planner оставляет по одной строке на (имя, количество, сумма). Строки
    // первого сегмента уже у keeper; дописываем только уникальные продолжения.
    if (missingItems.length > 0) {
      await tx.insert(sourceDocumentItems).values(
        missingItems.map((item, index) => {
          const { id: _id, sourceDocumentId: _docId, lineNo: _lineNo, ...values } = item;
          return {
            ...values,
            sourceDocumentId: action.keeperId,
            lineNo: keeperItems.length + index + 1,
          };
        }),
      );
    }

    // Все уникальные оригиналы остаются доступны из канонической карточки;
    // исходные junction-строки скрытых документов сохраняются для аудита.
    const keeperAttachmentKeys = new Set(
      attachments
        .filter((row) => row.sourceDocumentId === action.keeperId)
        .map((row) => JSON.stringify([row.s3Key, row.role])),
    );
    const attachmentsToCopy = new Map<string, (typeof attachments)[number]>();
    for (const attachment of attachments.filter((row) => groupIds.has(row.sourceDocumentId))) {
      const key = JSON.stringify([attachment.s3Key, attachment.role]);
      if (!keeperAttachmentKeys.has(key) && !attachmentsToCopy.has(key)) {
        attachmentsToCopy.set(key, attachment);
      }
    }
    if (attachmentsToCopy.size > 0) {
      await tx.insert(sourceDocumentAttachments).values(
        [...attachmentsToCopy.values()].map((attachment) => {
          const {
            id: _id,
            sourceDocumentId: _docId,
            createdAt: _createdAt,
            ...values
          } = attachment;
          return { ...values, sourceDocumentId: action.keeperId };
        }),
      );
    }

    // У частей с разными строками keeper должен помнить страницы всех частей,
    // иначе ручной reparse позднее увидел бы только первый кусок документа.
    if (!action.identicalItems) {
      const refs = new Map<
        string,
        { registryItemId: string | null; inputOrder: number; pageInFile: number }
      >();
      for (const segment of orderedSegments.filter((row) => row.docId && groupIds.has(row.docId))) {
        for (const ref of segment.pageRefs as Array<{
          registryItemId: string | null;
          inputOrder: number;
          pageInFile: number;
        }>) {
          const key = JSON.stringify([ref.registryItemId, ref.inputOrder, ref.pageInFile]);
          if (!refs.has(key)) refs.set(key, ref);
        }
      }
      const keeperSegment = orderedSegments.find((row) => row.docId === action.keeperId)!;
      await tx
        .update(bundleSegments)
        .set({ pageRefs: [...refs.values()], updatedAt: new Date() })
        .where(eq(bundleSegments.id, keeperSegment.id));
    }

    // Итог документа. У КОПИЙ он уже прочитан из шапки («Всего к оплате») и
    // одинаков в обоих экземплярах — подменять его суммой строк нельзя: именно
    // это и уничтожало проверку, потому что после подмены она сравнивала число
    // само с собой и сходилась даже на задвоенном составе. Сумма строк
    // остаётся источником только там, где строки РАЗНЫЕ (части документа).
    const sumsOf = (pick: (item: (typeof keptItems)[number]) => string | null): number | null => {
      if (keptItems.length === 0) return null;
      if (!keptItems.every((item) => pick(item) != null)) return null;
      return keptItems.reduce((acc, item) => acc + Number(pick(item)), 0);
    };
    const keeperTotal = keeper.totalSum == null ? null : Number(keeper.totalSum);
    const keeperVat = keeper.vatSum == null ? null : Number(keeper.vatSum);
    const sumFromLines = action.relation === 'copies' ? null : sumsOf((item) => item.sum);
    const vatFromLines = action.relation === 'copies' ? null : sumsOf((item) => item.vatSum);
    const totalSum = !action.identicalItems && sumFromLines != null ? sumFromLines : keeperTotal;
    const vatSum = !action.identicalItems && vatFromLines != null ? vatFromLines : keeperVat;

    // «Всего наименований» из бланка. Отдельной колонки под него нет, поэтому
    // поднимаем из снимков валидации сегментов: у копий число одно и то же, у
    // частей берём максимум — меньшее заведомо описывает лишь часть списка.
    const declaredItemsCount = (() => {
      const values = action.documentIds
        .map((id) => docById.get(id)?.validation)
        .map((v) => declaredItemsCountOf(v))
        .filter((n): n is number => n != null);
      return values.length > 0 ? Math.max(...values) : null;
    })();

    const validationItems = keptItems.map((item) => ({
      // Номер из бланка возвращает проверку целостности списка: без него
      // items_sequence уходит в skip ровно там, где строку задвоили.
      rowNo: item.rowNo ?? null,
      qty: Number(item.qty),
      unit: item.unit ?? null,
      price: item.price == null ? null : Number(item.price),
      sum: item.sum == null ? null : Number(item.sum),
      vatRate: item.vatRate == null ? null : Number(item.vatRate),
      vatSum: item.vatSum == null ? null : Number(item.vatSum),
    }));
    // Граница записи: склейка перезапишет validation победителя. Пакетные
    // предупреждения (неразобранные страницы, неучтённый номер) относятся ко
    // ВСЕМУ пакету, поэтому переносим их из прежнего снимка победителя —
    // иначе склейка двух экземпляров стирала бы след о потере.
    const validation = mergePersistentUpdWarnings(
      (keeper.validation ?? null) as UpdValidation | null,
      validateUpdTotals(
        { totalSum, vatSum, itemsCount: declaredItemsCount, items: validationItems },
        // Позиции собраны из распознанных сегментов — эвристика применима.
        { detectRecognitionWarnings: true },
      ),
    );
    // Исход считает общее правило системы, а не отдельная ветка склейки:
    // денежное расхождение оставляет документ обработанным и вешает жёлтую
    // плашку, а в «требует решения» уводит только неполнота (нет номера, нет
    // позиций, список короче заявленного). Раньше здесь этой проверки не было
    // вовсе — собранный документ всегда выглядел готовым.
    const outcome = deriveUpdParseOutcome(
      {
        items: validationItems,
        docNumber: keeper.docNumber,
        totalSum,
        itemsCount: declaredItemsCount,
        confidence: keeper.llmConfidence == null ? null : Number(keeper.llmConfidence),
      },
      validation,
      { parsedViaVision: true },
    );
    const siblingDuplicate =
      keeper.parseErrorCode === 'duplicate_upd' &&
      typeof keeper.parseErrorDetails?.existingId === 'string' &&
      groupIds.has(keeper.parseErrorDetails.existingId);
    const CLEARED = { status: 'parsed' as const, parseErrorCode: null, parseErrorDetails: null };
    // Дубликат-сосед и разошедшиеся суммы — не ошибки склейки: первый и есть
    // второй экземпляр, который мы только что свели, вторые после сведения
    // могли сойтись. Дальше исход считает общее правило системы — но только
    // при включённом рубильнике: с выключенным поведение обязано остаться
    // прежним, а раньше статус здесь не пересчитывался вовсе.
    const resolvedValidation =
      keeper.parseErrorCode === 'validation_mismatch' && !validation.hasMismatch;
    const statusPatch = !copyDedup
      ? siblingDuplicate || resolvedValidation
        ? CLEARED
        : {}
      : siblingDuplicate
        ? CLEARED
        : {
            status: outcome.status,
            parseErrorCode: outcome.parseErrorCode,
            parseErrorDetails: outcome.parseErrorDetails,
          };
    await tx
      .update(sourceDocuments)
      .set({
        totalSum: totalSum == null ? null : totalSum.toFixed(2),
        vatSum: vatSum == null ? null : vatSum.toFixed(2),
        validation,
        ...statusPatch,
        updatedAt: new Date(),
      })
      .where(eq(sourceDocuments.id, action.keeperId));

    // Никакого физического удаления: технические строки остаются уликой,
    // наружу не публикуются и явно указывают своего канонического победителя.
    if (action.droppedDocumentIds.length > 0) {
      await tx
        .update(sourceDocuments)
        .set({
          isTechnical: true,
          status: 'archived',
          parseErrorCode: null,
          parseErrorDetails: { mergedInto: action.keeperId },
          updatedAt: new Date(),
        })
        .where(inArray(sourceDocuments.id, action.droppedDocumentIds));
      for (const id of action.droppedDocumentIds) publishedIds.delete(id);
    }
  }
  return initialDocIds.filter((id) => publishedIds.has(id));
}

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
 * Аудит нумерации пакета: помечает документы, если файл мог потерять документ.
 *
 * Два признака, оба — пометки, а НЕ блокировки:
 *
 *  - в пакете были страницы, уверенно опознанные как чужой документ
 *    (накладная, сертификат): в сегменты они не идут, и до сих пор исчезали
 *    бесследно;
 *  - номера документов пакета образуют ряд с дыркой (4304…4309 без 4308) —
 *    ровно так выглядит документ, чью шапку классификатор принял за оборот
 *    предыдущего.
 *
 * Статус, parse_error_code, hasMismatch и видимость документа не меняются:
 * инспектор обязан получить материалы на планшет в любом случае, а разбирается
 * с сомнением менеджер на портале.
 *
 * Ошибку глушим: аудит не может быть причиной несостоявшейся публикации.
 */
async function auditAssemblyNumbers(
  tx: typeof db,
  args: {
    rootId: string;
    generation: number;
    docIds: string[];
    /** Номера, увиденные классификатором на страницах (манифест сегментов). */
    manifestNumbers?: string[];
    log: WorkerLog;
  },
): Promise<void> {
  const { rootId, generation, docIds, manifestNumbers = [], log } = args;
  if (docIds.length === 0) return;
  try {
    const docs = await tx
      .select({
        id: sourceDocuments.id,
        docNumber: sourceDocuments.docNumber,
        validation: sourceDocuments.validation,
      })
      .from(sourceDocuments)
      .where(inArray(sourceDocuments.id, docIds));

    // Список выброшенных страниц знает только планировщик, а к моменту
    // публикации плана уже нет — читаем его из улики того же поколения.
    const [evidence] = await tx
      .select({ payload: recognitionEvidenceEvents.payload })
      .from(recognitionEvidenceEvents)
      .where(
        and(
          eq(recognitionEvidenceEvents.bundleId, rootId),
          eq(recognitionEvidenceEvents.generation, generation),
          eq(recognitionEvidenceEvents.evidenceType, 'page_classification'),
        ),
      )
      .orderBy(desc(recognitionEvidenceEvents.createdAt))
      .limit(1);
    const dropped = (
      (evidence?.payload as { droppedPages?: Array<{ page: number; type: string }> } | null)
        ?.droppedPages ?? []
    ).filter((d) => Number.isInteger(d?.page));

    const gaps = findNumberGaps(docs.map((d) => d.docNumber));

    const warnings: UpdWarning[] = [];
    if (dropped.length > 0) {
      warnings.push({
        name: 'dropped_pages_not_parsed',
        scope: 'document',
        details: {
          pages: dropped.map((d) => d.page),
          pageKinds: [...new Set(dropped.map((d) => d.type))],
        },
      });
    }
    if (gaps.length > 0) {
      warnings.push({
        name: 'sibling_number_gap',
        scope: 'document',
        details: {
          docNumbers: gaps.flatMap((g) => g.missing.map((n) => `${g.prefix}${n}`)),
        },
      });
    }

    // Прямой признак потери, в отличие от дырки в ряду: на страницах файла
    // напечатан номер, которому не нашлось ни одного распознанного документа.
    // Так выглядит и съеденный сегментом документ, и разрез не по границе.
    //
    // Работает только когда классификатор возвращает номера (расширенный
    // промпт); при выключенном рубильнике манифест пуст, и проверка молчит.
    const unaccounted = manifestNumbers.filter(
      (manifestNumber) =>
        !docs.some((d) => !differentDocNumber(manifestNumber, d.docNumber)),
    );
    if (unaccounted.length > 0) {
      warnings.push({
        name: 'page_doc_number_unaccounted',
        scope: 'document',
        details: { docNumbers: [...new Set(unaccounted)] },
      });
    }

    // Одинаковый номер у двух опубликованных документов пакета. Склейка их не
    // свела — значит разошлись поставщик или дата, и это законно: один номер
    // у разных поставщиков не редкость. Но точно так же выглядит разрез не по
    // границе документа, поэтому помечаем, не вмешиваясь в состав пакета.
    const byNumber = new Map<string, number>();
    for (const d of docs) {
      const normalized = normalizeDocNumber(d.docNumber);
      if (normalized == null) continue;
      byNumber.set(normalized, (byNumber.get(normalized) ?? 0) + 1);
    }
    const repeated = [...byNumber.entries()].filter(([, n]) => n > 1).map(([number]) => number);
    if (repeated.length > 0) {
      warnings.push({
        name: 'sibling_number_duplicate',
        scope: 'document',
        details: { docNumbers: repeated },
      });
    }
    if (warnings.length === 0) return;

    // Пометка вешается на ВСЕ документы пакета: сомнение относится к файлу
    // целиком, и менеджер должен увидеть его из любой карточки, а не угадывать,
    // в какой именно спрятан след.
    for (const doc of docs) {
      const previous = doc.validation;
      const next: UpdValidation = previous ?? {
        hasMismatch: false,
        checkedAt: new Date().toISOString(),
        checks: [],
      };
      const existing = next.warnings ?? [];
      const missing = warnings.filter((w) => !existing.some((e) => e.name === w.name));
      if (missing.length === 0) continue;
      await tx
        .update(sourceDocuments)
        .set({
          validation: { ...next, warnings: [...existing, ...missing] },
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, doc.id));
    }
    log.info(
      { dropped: dropped.length, gaps: gaps.length, docs: docs.length },
      'сборка УПД: аудит нумерации отметил пакет',
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), rootId, generation },
      'сборка УПД: аудит нумерации не выполнен',
    );
  }
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
  attempt?: { subBundleId: string; bundleGeneration: number },
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
    if (root.status === 'parse_failed') {
      return { action: 'none' as const, reason: 'пакет завершён с ошибкой' };
    }
    if (attempt) {
      const [sub] = await tx
        .select({
          parentBundleId: sourceBundles.parentBundleId,
          dispatchGeneration: sourceBundles.dispatchGeneration,
        })
        .from(sourceBundles)
        .where(eq(sourceBundles.id, attempt.subBundleId))
        .for('update');
      if (
        !sub ||
        sub.parentBundleId !== rootId ||
        sub.dispatchGeneration !== attempt.bundleGeneration
      )
        return { action: 'none' as const, reason: 'поколение assembly-задания устарело' };
    }

    // Уже опубликовано — второй раз ни статусы не трогаем, ни group_revision
    // не бампаем: ревизия означает «состав изменился», а он не менялся.
    if (root.publishedGeneration === generation) {
      return { action: 'none' as const, reason: 'уже опубликовано' };
    }

    const segments = await tx
      .select({
        id: bundleSegments.id,
        segmentIndex: bundleSegments.segmentIndex,
        confidence: bundleSegments.confidence,
        docId: bundleSegments.sourceDocumentId,
        pageRefs: bundleSegments.pageRefs,
        // Номер, увиденный классификатором. Нужен аудиту: если парсер извлёк
        // из сегмента другой номер, значит границу провели не там.
        manifestDocNumber: bundleSegments.docNumber,
      })
      .from(bundleSegments)
      .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)))
      .orderBy(bundleSegments.segmentIndex);
    if (segments.length === 0) return { action: 'none' as const, reason: 'манифест пуст' };

    // `fallback` — сегмент, открытый НЕ шапкой: продолжение без начала либо
    // непонятная страница сама по себе. Публиковать такое нельзя, границы
    // документов недостоверны.
    //
    // `uncertain` публикуем: в манифест он попадает только после того, как
    // planUpdSegments признал нарезку надёжной, а это возможно единственным
    // способом — сегмент начат распознанной шапкой, и «неуверенность» вызвана
    // прикреплённой страницей (оборот, приложение). Существующие манифесты от
    // этого не меняются: до правки uncertain до манифеста не доходил вовсе,
    // пакет откатывался раньше.
    if (segments.some((s) => s.confidence === 'fallback')) {
      return { action: 'rollback' as const, reason: 'в манифесте есть сегменты без шапки' };
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
        parseErrorDetails: sourceDocuments.parseErrorDetails,
        supplierDirectoryId: sourceDocuments.supplierDirectoryId,
        docNumber: sourceDocuments.docNumber,
        docDate: sourceDocuments.docDate,
        totalSum: sourceDocuments.totalSum,
        vatSum: sourceDocuments.vatSum,
        // Снимок валидации сегмента — единственное место, где сохранилось
        // «Всего наименований» из бланка: отдельной колонки под него нет.
        // После склейки без него проверка полноты списка сравнивает число
        // строк само с собой и сходится всегда.
        validation: sourceDocuments.validation,
        llmConfidence: sourceDocuments.llmConfidence,
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

    // Совпавшие реквизиты внутри поколения означают части/копии одной УПД,
    // а не повторную загрузку. До этой точки все сегменты терминальны, но ещё
    // технические, поэтому состав можно изменить атомарно.
    const publishedDocIds = await consolidateAssemblyDocuments(
      tx as unknown as typeof db,
      segments,
      docs,
    );

    // ── публикация ──────────────────────────────────────────────────────────
    const now = new Date();
    // Аудит нумерации — до публикации, но ПОСЛЕ склейки: считать пропуски по
    // ещё не сведённым экземплярам одной УПД бессмысленно.
    //
    // Ничего не блокирует и не меняет статусы: документ с материалами обязан
    // доехать до планшета, даже если к пакету есть вопросы. Задача пометки —
    // показать менеджеру на портале, что файл стоит открыть глазами.
    if (loadEnv().UPD_ASSEMBLY_NUMBER_AUDIT) {
      await auditAssemblyNumbers(tx as unknown as typeof db, {
        rootId,
        generation,
        docIds: publishedDocIds,
        manifestNumbers: segments
          .map((seg) => seg.manifestDocNumber)
          .filter((n): n is string => n != null),
        log,
      });
    }

    // Публикуем сегменты И бампаем сиблингов группы — иначе накладная, уже
    // видимая до публикации, навсегда осталась бы на планшете отдельной
    // карточкой. Подробнее — в KDoc publishGroupDocuments.
    await publishGroupDocuments(tx, rootId, publishedDocIds, now);
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

    // Публикация — момент, когда машина целиком становится видимой. Пишем
    // переходы по ВСЕЙ группе, а не только по сегментам: накладная и М-15
    // создаются на корневом пакете раньше публикации и до этой секунды были
    // скрыты вместе с недособранной машиной.
    await recordVisibilityTransitions(tx, {
      groupId: rootId,
      reason: 'комплект машины опубликован',
    });

    return {
      action: 'publish' as const,
      docIds: publishedDocIds,
      reason: 'комплект готов',
    };
  });

  if (decision.action === 'none') {
    log.info({ reason: decision.reason }, 'сборка УПД: публикация отложена');
    return;
  }
  if (decision.action === 'rollback') {
    const sub = attempt
      ? { id: attempt.subBundleId, generation: attempt.bundleGeneration }
      : (
          await db
            .select({ id: sourceBundles.id, generation: sourceBundles.dispatchGeneration })
            .from(sourceBundles)
            .where(and(eq(sourceBundles.parentBundleId, rootId), eq(sourceBundles.kind, 'upd')))
            .limit(1)
        )[0];
    await rollbackUpdAssembly({
      rootId,
      subBundleId: sub?.id ?? null,
      generation,
      bundleGeneration: sub?.generation,
      reason: decision.reason,
      log,
    });
    return;
  }

  // Дочерний пакет отработал: закрываем его и убираем служебную запись, чтобы
  // у него не осталось ни одного technical-документа.
  await finishAssemblySubBundle(rootId, 'parsed', log, attempt);
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
  bundleGeneration?: number;
  reason: string;
  log: WorkerLog;
}): Promise<void> {
  const { rootId, subBundleId, bundleGeneration, generation, reason, log } = args;

  // Опубликованное поколение не откатываем НИКОГДА. Ниже идёт hard DELETE
  // документов сегментов без записи в entity_deletions — это осознанно, но
  // верно ровно до публикации: до неё документы технические и наружу не
  // выходили. После публикации тот же DELETE оставил бы на планшетах фантомы
  // (tombstone нет, значит удаление не доедет), а если по документу уже создана
  // приёмка — упёрся бы в FK delivery_sources ... ON DELETE RESTRICT и порвал
  // транзакцию, оставив пакет висеть в processing.
  //
  // Гвард именно здесь, а не только у вызывающих: путь worker.on('failed')
  // зовёт откат вслепую, не заглядывая в published_generation.
  //
  // Сравнение с ЭТИМ поколением, а не с null: `!= null` запрещал откат любого
  // поколения после первой публикации. Комплект, пересобираемый вторым заходом,
  // при сбое не мог откатиться на «файл = документ» и оставался без документов
  // вовсе — при том что публиковалось ПРЕДЫДУЩЕЕ поколение, а не это.
  const [publishedCheck] = await db
    .select({ publishedGeneration: sourceBundles.publishedGeneration })
    .from(sourceBundles)
    .where(eq(sourceBundles.id, rootId));
  if (publishedCheck?.publishedGeneration === generation) {
    log.warn(
      { reason, subBundleId, publishedGeneration: publishedCheck.publishedGeneration },
      'сборка УПД: откат отклонён — поколение уже опубликовано',
    );
    return;
  }

  log.warn({ reason, subBundleId }, 'сборка УПД: откат на «файл = документ»');
  await recordRecognitionEvidence({
    bundleId: rootId,
    generation,
    evidenceType: 'assembly_rollback',
    payload: { subBundleId, bundleGeneration: bundleGeneration ?? null, reason },
  });

  // 1. Снимаем манифест и технические документы. Задания сегментов, ещё не
  //    доставленные в очередь, забираем сразу: fencing их всё равно обезвредит,
  //    но холостое задание занимает слот воркера с CONCURRENCY=1 и остаётся в
  //    outbox мусором. Уже доставленные (строки в outbox нет) отсекутся
  //    проверками loadSegmentContext.
  const removedDocIds = await db.transaction(async (tx) => {
    if (subBundleId && bundleGeneration !== undefined) {
      await fenceBundleAttempt(tx as unknown as typeof db, subBundleId, bundleGeneration);
    }
    const segments = await tx
      .select({
        id: bundleSegments.id,
        docId: bundleSegments.sourceDocumentId,
        dispatchGeneration: bundleSegments.dispatchGeneration,
        jobId: sourceDocuments.jobId,
      })
      .from(bundleSegments)
      .leftJoin(sourceDocuments, eq(sourceDocuments.id, bundleSegments.sourceDocumentId))
      .where(and(eq(bundleSegments.bundleId, rootId), eq(bundleSegments.generation, generation)));
    const docIds = segments.map((s) => s.docId).filter((v): v is string => v !== null);
    if (segments.length > 0) {
      await tx.delete(jobOutbox).where(
        inArray(
          jobOutbox.dedupeKey,
          segments.map((s) => s.jobId ?? segmentDispatchKeyOf(s.id, s.dispatchGeneration)),
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
    (r) =>
      r.s3Key !== null &&
      (subBundleId ? r.subBundleId === subBundleId : r.effectiveStatus === null),
  );

  // Кому на самом деле принадлежит файл. Классификация страниц уже сделана —
  // грех её не спросить: иначе целиком-накладная уедет в УПД-парсер только
  // потому, что нарезке не поверили.
  const rollbackKindMode = loadEnv().UPD_ASSEMBLY_ROLLBACK_KIND;
  let kindByFile = new Map<string, 'transport_waybill' | 'supplementary'>();
  if (rollbackKindMode !== 'off') {
    try {
      const [evidence] = await db
        .select({ payload: recognitionEvidenceEvents.payload })
        .from(recognitionEvidenceEvents)
        .where(
          and(
            eq(recognitionEvidenceEvents.bundleId, rootId),
            eq(recognitionEvidenceEvents.generation, generation),
            eq(recognitionEvidenceEvents.evidenceType, 'page_classification'),
          ),
        )
        .orderBy(desc(recognitionEvidenceEvents.createdAt))
        .limit(1);
      const payload = evidence?.payload as {
        classification?: PageClassification[];
        pageMap?: Array<{ globalPage: number; registryItemId: string | null }>;
      } | null;
      if (payload?.classification && payload.pageMap) {
        kindByFile = rollbackKindsByFile(payload.classification, payload.pageMap);
      }
      if (kindByFile.size > 0) {
        // След пишется в обоих режимах: в shadow это единственный результат
        // работы, а в on по нему видно, почему файл ушёл не в УПД.
        await recordRecognitionEvidence({
          bundleId: rootId,
          generation,
          evidenceType: 'assembly_rollback',
          payload: {
            subBundleId,
            mode: rollbackKindMode,
            routing: [...kindByFile.entries()].map(([registryItemId, kind]) => ({
              registryItemId,
              kind,
            })),
          },
        });
      }
    } catch (err) {
      // Не смогли определить вид — значит откат идёт как раньше. Молчаливая
      // деградация здесь безопаснее отказа: документы всё равно создадутся.
      log.warn(
        { err: err instanceof Error ? err.message : String(err), rootId },
        'сборка УПД: не удалось определить вид файлов для отката',
      );
      kindByFile = new Map();
    }
  }

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
      const routedKind = rollbackKindMode === 'on' ? kindByFile.get(r.id) : undefined;
      if (routedKind === 'transport_waybill') {
        // Тот же путь, что у «Загрузить накладные»: дочерний пакет и парсер
        // накладных. Одной смены detectedKind было бы мало —
        // createSingleUpdDocument всё равно создаёт kind='upd' и ставит
        // задание в очередь УПД.
        await createWaybillSubBundle({
          bundleId: rootId,
          bundleGeneration: rootBundle.dispatchGeneration,
          bundle: rootBundle,
          bundleOrigin: rootBundle.origin ?? 'manual_pdf',
          file,
          detectedKind: 'transport_waybill',
          confidence: 0,
          signals: ['assembly:rollback', 'assembly:rollback:kind=transport_waybill'],
          reason: `сборка отменена (${reason}) → накладная в waybill-парсер`,
        });
        continue;
      }
      if (routedKind === 'supplementary') {
        // Сертификат и паспорт качества не распознаются нигде: у них нет
        // своего парсера, и штатный исход — строка реестра со статусом
        // skipped. Раньше такой файл уезжал в УПД-парсер пустым черновиком.
        await recordImportItemForAttempt(rootId, rootBundle.dispatchGeneration, file, {
          detectedKind: 'supplementary',
          confidence: '0',
          parserUsed: 'none',
          status: 'skipped',
          createdDocumentIds: [],
          reason: `сборка отменена (${reason}) → сопроводительный документ`,
          metadata: { signals: ['assembly:rollback', 'assembly:rollback:kind=supplementary'] },
        });
        continue;
      }
      const docId = await createSingleUpdDocument({
        bundleId: rootId,
        bundleGeneration: rootBundle.dispatchGeneration,
        attemptBundleId: subBundleId ?? rootId,
        attemptBundleGeneration:
          subBundleId && bundleGeneration !== undefined
            ? bundleGeneration
            : rootBundle.dispatchGeneration,
        bundle: rootBundle,
        bundleOrigin: rootBundle.origin ?? 'manual_pdf',
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

  await finishAssemblySubBundle(
    rootId,
    'parse_failed',
    log,
    subBundleId && bundleGeneration !== undefined ? { subBundleId, bundleGeneration } : undefined,
  );
  await recountGroupDocCount(rootId);

  // Корневой пакет обязан выйти из `processing` здесь и сейчас.
  //
  // Router ставит ему `processing`, когда запускает сборку (см. handleDocumentRouterJob),
  // рассчитывая, что до терминала его доведёт публикация. Откат публикацией не
  // заканчивается, а собственного закрытия у него не было — пакет оставался в
  // `processing` навсегда: repairStuckJobs ищет только `queued` и такой пакет не
  // подбирает никто. На боевой БД так зависли 7 пакетов, и это ровно все откаты
  // сборки при 8 успешных публикациях.
  //
  // `requireUnpublished` — против гонки с параллельной публикацией: пока откат
  // разворачивал файлы, та могла успеть объявить поколение опубликованным, и
  // отбирать у неё статус нельзя.
  const finalized = await finalizeBundleTerminalState(db, rootId, {
    requireUnpublished: true,
    // Именно откатываемое поколение: без него условие означало бы «пакет
    // когда-либо публиковался», и повторная загрузка в уже публиковавшийся
    // пакет не закрывалась бы откатом — он висел бы в processing.
    generation,
    itemReason: 'файл не дошёл до разбора (сборка отменена)',
    parseErrorCode: 'assembly_rolled_back',
  });
  log.info(
    {
      removed: removedDocIds.length,
      created: createdIds.length,
      bundle: finalized.outcome,
      ...(finalized.skipReason ? { skipped: finalized.skipReason } : {}),
    },
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
  attempt?: { subBundleId: string; bundleGeneration: number },
): Promise<void> {
  const subs = attempt
    ? await db
        .select({ id: sourceBundles.id })
        .from(sourceBundles)
        .where(
          and(
            eq(sourceBundles.id, attempt.subBundleId),
            eq(sourceBundles.parentBundleId, rootId),
            eq(sourceBundles.kind, 'upd'),
          ),
        )
    : await db
        .select({ id: sourceBundles.id })
        .from(sourceBundles)
        .where(and(eq(sourceBundles.parentBundleId, rootId), eq(sourceBundles.kind, 'upd')));
  for (const sub of subs) {
    await db.transaction(async (tx) => {
      if (attempt) {
        await fenceBundleAttempt(
          tx as unknown as typeof db,
          attempt.subBundleId,
          attempt.bundleGeneration,
        );
      }
      await tx.delete(sourceDocuments).where(
        and(
          eq(sourceDocuments.bundleId, sub.id),
          eq(sourceDocuments.isTechnical, true),
          // Удаляется только служебная запись самого sub-bundle. Архивные
          // sibling-сегменты после склейки остаются техническими, но связаны
          // с манифестом и хранят полный аудит исходного распознавания.
          drSql`not exists (
              select 1 from bundle_segments bs where bs.source_document_id = ${sourceDocuments.id}
            )`,
        ),
      );
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
  bundleGeneration: number;
  llmProviderId: string | null;
  /** Позиция документа в ответе модели — постоянная привязка для повтора. */
  batchIndex?: number;
  /** Каким промптом разобран пакет: повтор обязан идти тем же. */
  waybillPromptKind?: string | null;
  attachments: {
    s3Key: string;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
  }[];
}): Promise<string> {
  const { doc, bundleId, bundleGeneration, bundle, llmProviderId, attachments } = args;

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
  // остаются null и заполняются лишь в ветках внешних форм.
  let supplierInnRaw: string | null = null;
  let consigneeInnRaw: string | null = null;
  // 1-Т идёт здесь же, а не отдельной веткой: у неё те же внешние стороны —
  // грузоотправитель и грузополучатель с ИНН, только напечатаны они в шапке
  // товарного раздела, а не в нумерованных разделах формы 2116. Разделять
  // ветки значило бы продублировать поиск поставщика в справочнике; забыть
  // же добавить сюда новую форму — оставить документ без поставщика вовсе.
  if (doc.form === 'tn_2116' || doc.form === 'tn_1t') {
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

  const id = randomUUID();
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db;
    await fenceBundleAttempt(tx, bundleId, bundleGeneration);
    await tx.insert(sourceDocuments).values({
      id,
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
      siteId: await resolveMachineSiteId(tx as unknown as Db, bundleId),
      docNumber: doc.docNumber ?? null,
      docDate,
      totalSum: doc.totalSum != null ? doc.totalSum.toString() : null,
      expectedDate: await resolveMachineExpectedDate(tx as unknown as Db, bundleId),
      // Наследуем от пакета: накладная из письма остаётся почтовой.
      origin: bundle.origin ?? 'manual_pdf',
      llmProviderId,
      llmConfidence: doc.confidence.toString(),
      parsedAt: new Date(),
      processedAt: new Date(),
      // Пакетный разбор накладных: и режим, и позиция в пачке нужны повтору,
      // чтобы пойти тем же путём и записать результат в нужную строку.
      parseMode: 'waybill_batch',
      batchIndex: args.batchIndex ?? null,
      waybillPromptKind: args.waybillPromptKind ?? null,
      bundleId,
      createdByUserId: bundle.createdByUserId,
    });

    // Дублируем attachments на каждый созданный документ. S3-файл общий
    // (один объект в bucket), а в junction-таблице — новые строки.
    if (attachments.length > 0) {
      await tx.insert(sourceDocumentAttachments).values(
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
      await tx.insert(sourceDocumentItems).values(rows);
    }
  });
  return id;
}

/**
 * Повторное распознавание ОДНОЙ накладной пакетного пути (ТН/ОС-2).
 *
 * Пакетный разбор устроен «файл → N документов», и повторить его целиком нельзя:
 * технической записи пакета давно нет, а новый прогон создал бы вторую пачку
 * документов вместо обновления существующей. Поэтому здесь тот же парсер
 * применяется к вложениям ОДНОГО документа, а результат сопоставляется с ним.
 *
 * Порядок сопоставления и почему он такой:
 *   1. batch_index — позиция документа в ответе модели при создании. Единственный
 *      способ, устойчивый к неверно распознанному номеру, — а это ровно тот
 *      случай, ради которого повтор и запускают. Работает, когда модель вернула
 *      столько же документов, сколько было в прошлый раз.
 *   2. один документ в ответе — сопоставлять не с чем.
 *   3. совпадение номера и даты — для записей, созданных до появления
 *      batch_index (на бою таких три).
 *   4. не сопоставили → полный откат: документ остаётся ровно таким, каким был.
 */
async function handleWaybillSingleReparseJob(
  sourceDocumentId: string,
  jobGeneration: number,
  log: WorkerLog,
): Promise<void> {
  const [doc] = await db
    .select()
    .from(sourceDocuments)
    .where(generationScoped(sourceDocumentId, jobGeneration))
    .limit(1);
  if (!doc) {
    log.warn({ jobGeneration }, 'накладная исчезла или переразобрана — пропускаем задание');
    return;
  }

  const [marked] = await db
    .update(sourceDocuments)
    .set({
      status: 'processing',
      jobAttempts: drSql`${sourceDocuments.jobAttempts} + 1`,
      reparse: drSql`jsonb_set(${sourceDocuments.reparse}, '{state}', '"processing"')`,
      updatedAt: new Date(),
    })
    .where(generationScoped(sourceDocumentId, jobGeneration))
    .returning({ id: sourceDocuments.id });
  if (!marked) return;

  try {
    const attachments = await db
      .select()
      .from(sourceDocumentAttachments)
      .where(
        and(
          eq(sourceDocumentAttachments.sourceDocumentId, sourceDocumentId),
          eq(sourceDocumentAttachments.role, 'original'),
        ),
      );
    const files: WaybillInputImage[] = [];
    for (const a of attachments) {
      const buf = await getObject(a.s3Key);
      files.push({ buffer: buf, mimeType: a.mimeType ?? 'image/jpeg', filename: a.filename });
    }
    if (files.length === 0) throw new Error('нет исходных файлов накладной');

    // Копия до рендера: второму проходу нужен свой предел страниц, а `files`
    // ниже перезаписывается страницами под предел первого — см. пакетный путь.
    const originalFiles: WaybillInputImage[] = [...files];

    // Тот же препроцессинг, что и в пакетном разборе: OpenRouter принимает
    // только image/*, поэтому PDF разворачиваем в страницы-PNG.
    if ((await getDefaultProviderKind()) === 'openrouter') {
      const expanded = await expandPdfAttachmentsForOpenRouter(files);
      files.length = 0;
      files.push(...expanded);
    }

    // Документ, созданный промптом формы 1-Т, повторяем ТЕМ ЖЕ промптом.
    // Активный промпт вернул бы другой набор документов, и выбор «своего» по
    // batch_index попал бы в чужую накладную из того же файла.
    const routed1t =
      doc.waybillPromptKind === 'transport_waybill_1t'
        ? await runWaybill1tPass(originalFiles, { sourceDocumentId, bundleId: null }, log)
        : null;
    const first =
      routed1t ??
      (await parseWaybillBatch(files, {
        sourceDocumentId,
        // Пакета здесь нет: разбирается один документ, а не загрузка целиком.
        bundleId: null,
      }));
    let parsed = first.parsed;
    let llmProviderId = first.llmProviderId;

    // Повтор идёт тем же активным промптом, что и первичный разбор, — значит на
    // форме 1-Т получает тот же пустой список. Без второго прохода «распознать
    // заново» для 1-Т всегда упирается в откат ниже, и документ, созданный с
    // чужим номером (у боевой ТТН в номер попал код по ОКПО), починить нечем.
    if (parsed.documents.length === 0) {
      const second = await secondPassWaybill1t(
        originalFiles,
        { sourceDocumentId, bundleId: null },
        log,
      );
      if (second) {
        parsed = second.parsed;
        llmProviderId = second.llmProviderId ?? llmProviderId;
      }
    }

    const picked = pickReparsedWaybill(parsed.documents, doc);
    if (!picked) {
      const rolledBack = await rollbackReparse(
        sourceDocumentId,
        jobGeneration,
        'ambiguous_source',
        log,
      );
      log.warn(
        { found: parsed.documents.length, batchIndex: doc.batchIndex, rolledBack },
        'повтор накладной: не удалось сопоставить результат с документом',
      );
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }

    const kind = picked.form === 'os2' ? 'os2_transfer' : 'transport_waybill';
    const itemRows = await Promise.all(
      picked.items.map(async (it, idx) => ({
        sourceDocumentId,
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

    await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      const [saved] = await txDb
        .update(sourceDocuments)
        .set({
          kind,
          status: 'parsed',
          parseError: null,
          parseErrorCode: null,
          parseErrorDetails: null,
          docNumber: picked.docNumber ?? null,
          docDate: parseLlmDocDate(picked.docDate),
          totalSum: picked.totalSum != null ? picked.totalSum.toString() : null,
          llmProviderId,
          llmConfidence: picked.confidence.toString(),
          parseMode: 'waybill_batch',
          processedAt: new Date(),
          reparse: drSql`jsonb_set(jsonb_set(${sourceDocuments.reparse}, '{state}', '"succeeded"'), '{finishedAt}', to_jsonb(now()::text))`,
          updatedAt: new Date(),
        })
        .where(generationScoped(sourceDocumentId, jobGeneration))
        .returning({ id: sourceDocuments.id });
      if (!saved) throw new StaleGenerationError();

      await txDb
        .delete(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, sourceDocumentId));
      if (itemRows.length > 0) await txDb.insert(sourceDocumentItems).values(itemRows);

      // Шапка и позиции заменены — планшет обязан забрать накладную заново.
      // Раньше этот путь бампа не звал ВООБЩЕ (в отличие от общего пути
      // распознавания), поэтому после успешного повтора version оставался
      // прежним и сверка устаревшую копию не находила: на бою так осталось
      // 18 накладных. После проверки `saved`, иначе устаревшее поколение
      // добавило бы инкремент поверх уже актуальной версии.
      await markSourceDocumentContentChanged(txDb, sourceDocumentId);
    });

    log.info({ itemsCount: picked.items.length, form: picked.form }, 'накладная распознана заново');
    await notifySourceDocumentUpdated(sourceDocumentId);
  } catch (err) {
    if (err instanceof StaleGenerationError) {
      log.info({ jobGeneration }, 'результат задания устарел — документ уже переразобран');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await rollbackReparse(sourceDocumentId, jobGeneration, message, log);
    log.warn({ err: message }, 'повтор накладной не удался — документ возвращён в прежний вид');
    await notifySourceDocumentUpdated(sourceDocumentId);
  }
}

/** Какой из распознанных документов относится к этой строке. См. порядок выше. */
function pickReparsedWaybill(
  documents: WaybillDocument[],
  doc: { batchIndex: number | null; docNumber: string | null; docDate: Date | null },
): WaybillDocument | null {
  if (documents.length === 0) return null;
  if (doc.batchIndex != null && doc.batchIndex < documents.length) {
    return documents[doc.batchIndex] ?? null;
  }
  if (documents.length === 1) return documents[0] ?? null;

  const sameNumber = documents.filter(
    (d) =>
      (d.docNumber ?? null) === doc.docNumber && sameDay(parseLlmDocDate(d.docDate), doc.docDate),
  );
  return sameNumber.length === 1 ? sameNumber[0]! : null;
}

function sameDay(a: Date | null, b: Date | null): boolean {
  if (a == null || b == null) return a === b;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

async function handleS3Cleanup(job: Job<S3CleanupJobData>): Promise<void> {
  const { s3Keys } = job.data;
  const log = logger.child({ jobId: job.id, queue: S3_CLEANUP_QUEUE });
  if (!s3Keys || s3Keys.length === 0) return;

  // Удаляем только то, что больше никому не принадлежит. Один объект в бакете
  // штатно делят несколько документов (пачка накладных, страницы одного PDF в
  // сборке УПД, слияние дубликатов), а в очередь уходят ВСЕ ключи удалённого
  // документа — без этой проверки удаление одной накладной из пачки стирало бы
  // файл у живых соседей: строка вложения осталась бы, а объекта в S3 уже нет.
  //
  // Проверка здесь, а не в момент постановки: этот обработчик — единственный
  // потребитель очереди, и он срабатывает позже, поэтому закрывает и случай
  // «ссылка на тот же ключ появилась уже после enqueue».
  const deletable = await selectUnreferencedS3Keys(db, s3Keys);
  const skipped = new Set(s3Keys).size - deletable.length;
  if (deletable.length === 0) {
    log.info({ total: s3Keys.length, skipped }, 's3 cleanup skipped — ключи ещё используются');
    return;
  }

  const results = await Promise.allSettled(deletable.map((k) => deleteObject(k)));
  let failed = 0;
  results.forEach((r, idx) => {
    if (r.status === 'rejected') {
      failed += 1;
      log.warn({ err: r.reason, s3Key: deletable[idx] }, 's3 delete failed');
    }
  });
  // Если все ключи зафейлились — это похоже на проблему с S3-доступом
  // в целом, имеет смысл повторить задачу. Если часть успешна — БД и
  // так уже консистентна, считаем успехом. Счёт идёт от списка к удалению:
  // пропущенные по ссылкам — не ошибка, и ретраить из-за них нечего.
  if (failed === deletable.length) {
    throw new Error(`all ${failed} s3 deletions failed`);
  }
  log.info(
    { total: s3Keys.length, deleted: deletable.length - failed, skipped, failed },
    's3 cleanup done',
  );
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
            .select({
              rootId: bundleSegments.bundleId,
              generation: bundleSegments.generation,
              subBundleId: sourceDocuments.bundleId,
            })
            .from(bundleSegments)
            .innerJoin(sourceDocuments, eq(sourceDocuments.id, bundleSegments.sourceDocumentId))
            .where(eq(bundleSegments.id, job.data.segmentId))
            .limit(1);
          if (seg) {
            await tryFinalizeUpdAssembly(
              seg.rootId,
              seg.generation,
              logger,
              job.data.bundleGeneration !== undefined && seg.subBundleId
                ? { subBundleId: seg.subBundleId, bundleGeneration: job.data.bundleGeneration }
                : undefined,
            );
          }
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
    ...UPD_PARSE_WORKER_OPTIONS,
  },
);

// Второй воркер — асинхронная чистка S3-объектов при удалении документов.
// Концурренси выше — операции лёгкие (один DELETE-запрос к S3 на ключ).
const S3_CLEANUP_CONCURRENCY = 4;
const s3CleanupWorker = new Worker<S3CleanupJobData>(S3_CLEANUP_QUEUE, handleS3Cleanup, {
  connection,
  concurrency: S3_CLEANUP_CONCURRENCY,
});

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
        .where(
          and(
            eq(sourceBundles.id, subId),
            eq(sourceBundles.dispatchGeneration, job.data.bundleGeneration ?? 0),
          ),
        )
        .limit(1);
      if (sub?.parentId) {
        await rollbackUpdAssembly({
          rootId: sub.parentId,
          subBundleId: subId,
          generation: job.data.generation,
          bundleGeneration: job.data.bundleGeneration ?? 0,
          reason: `задание сборки не выполнилось: ${err.message}`,
          log: logger,
        });
      }
      return;
    }

    // Ручной повтор исчерпал попытки. Документ возвращается в состояние до
    // нажатия кнопки — и это раньше веток ниже: и сегмент, и одиночный документ
    // при повторе обязаны откатываться, а не получать parse_failed поверх
    // ранее нормально распознанных данных. Откат сам сверяет поколение и
    // ничего не делает, если документ уже переразобрали снова.
    const failedDocGeneration =
      'docGeneration' in job.data && typeof job.data.docGeneration === 'number'
        ? job.data.docGeneration
        : 0;
    if ('reparse' in job.data && job.data.reparse === true && job.data.sourceDocumentId) {
      const docId = job.data.sourceDocumentId;
      const rolledBack = await rollbackReparse(
        docId,
        failedDocGeneration,
        `повтор не выполнился: ${err.message}`,
        logger.child({ sourceDocumentId: docId }),
      );
      if (rolledBack) {
        await notifySourceDocumentUpdated(docId);
        return;
      }
    }

    // Автоповтор сегмента исчерпал попытки. Документ возвращается к разбору
    // ПЕРВОГО захода, а не получает parse_failed: первый результат был
    // пригодным (просто с расхождением сумм), и терять его из-за неудачи
    // необязательного уточнения нельзя — иначе распознанная УПД исчезла бы с
    // портала и планшета. Ветка стоит раньше общей сегментной по той же
    // причине, по которой раньше стоит откат ручного повтора.
    if (
      'pass' in job.data &&
      job.data.pass === 'segment_repair' &&
      job.data.sourceDocumentId &&
      job.data.segmentId
    ) {
      const docId = job.data.sourceDocumentId;
      const [cur] = await db
        .select({ secondPass: sourceDocuments.secondPass })
        .from(sourceDocuments)
        .where(generationScoped(docId, failedDocGeneration))
        .limit(1);
      const restore = (
        cur?.secondPass as {
          restore?: {
            status?: SourceStatus | null;
            parseErrorCode?: string | null;
            parseErrorDetails?: Record<string, unknown> | null;
          } | null;
        } | null
      )?.restore;
      if (restore?.status) {
        await db
          .update(sourceDocuments)
          .set({
            status: restore.status,
            parseErrorCode: restore.parseErrorCode ?? null,
            parseErrorDetails: restore.parseErrorDetails ?? null,
            secondPass: {
              state: 'done',
              mode: 'segment_repair',
              outcome: 'failed',
              reasons: [err.message],
              finishedAt: new Date().toISOString(),
              restore,
            },
            processedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(generationScoped(docId, failedDocGeneration));
        logger.warn(
          { sourceDocumentId: docId, err: err.message },
          'segment repair: попытка не выполнилась — восстановлен прежний разбор',
        );
        await notifySourceDocumentUpdated(docId);
        const [seg] = await db
          .select({
            rootId: bundleSegments.bundleId,
            generation: bundleSegments.generation,
            subBundleId: sourceDocuments.bundleId,
          })
          .from(bundleSegments)
          .innerJoin(sourceDocuments, eq(sourceDocuments.id, bundleSegments.sourceDocumentId))
          .where(eq(bundleSegments.id, job.data.segmentId))
          .limit(1);
        if (seg) {
          await tryFinalizeUpdAssembly(
            seg.rootId,
            seg.generation,
            logger,
            job.data.bundleGeneration !== undefined && seg.subBundleId
              ? { subBundleId: seg.subBundleId, bundleGeneration: job.data.bundleGeneration }
              : undefined,
          );
        }
        return;
      }
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
        // Поколение сверяем и здесь: пока задание доживало свои ретраи,
        // документ могли переразобрать вручную, и свежий результат не должен
        // получить parse_failed от старой попытки.
        .where(generationScoped(docId, failedDocGeneration));
      const [seg] = await db
        .select({
          rootId: bundleSegments.bundleId,
          generation: bundleSegments.generation,
          subBundleId: sourceDocuments.bundleId,
        })
        .from(bundleSegments)
        .innerJoin(sourceDocuments, eq(sourceDocuments.id, bundleSegments.sourceDocumentId))
        .where(eq(bundleSegments.id, job.data.segmentId))
        .limit(1);
      if (seg) {
        await tryFinalizeUpdAssembly(
          seg.rootId,
          seg.generation,
          logger,
          job.data.bundleGeneration !== undefined && seg.subBundleId
            ? { subBundleId: seg.subBundleId, bundleGeneration: job.data.bundleGeneration }
            : undefined,
        );
      }
      return;
    }

    if ('bundleId' in job.data && job.data.bundleId) {
      const bundleId = job.data.bundleId;
      const [failedAttempt] = await db
        .update(sourceBundles)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'internal_error',
          parseErrorMessage: err.message,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceBundles.id, bundleId),
            eq(sourceBundles.dispatchGeneration, job.data.bundleGeneration ?? 0),
          ),
        )
        .returning({ id: sourceBundles.id });
      if (!failedAttempt) return;
      // Строки самого пакета, не дошедшие до терминального решения (краш
      // router-job в середине пачки), тоже нельзя оставлять «в процессе».
      await closeStaleRegistryItems(bundleId, job.data.bundleGeneration ?? 0, logger, {
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
      // У дочернего пакета накладной техническая запись — единственное, что
      // связывает файл с интерфейсом: оригинал висит именно на ней. Ретраи
      // исчерпаны, распознавать больше нечем — показываем её человеку, иначе
      // файл исчезнет совсем.
      //
      // Только для waybill-пакета: у корневого router-пакета техническая запись
      // штатно удаляется в конце разбора, а у дочернего пакета СБОРКИ под
      // техническими документами лежат сегменты — их снимает rollbackUpdAssembly,
      // и показывать их поштучно нельзя (комплект публикуется целиком).
      const [failedBundle] = await db
        .select({ kind: sourceBundles.kind })
        .from(sourceBundles)
        .where(eq(sourceBundles.id, bundleId))
        .limit(1);
      const [original] = tech
        ? await db
            .select({ id: sourceDocumentAttachments.id })
            .from(sourceDocumentAttachments)
            .where(
              and(
                eq(sourceDocumentAttachments.sourceDocumentId, tech.id),
                eq(sourceDocumentAttachments.role, 'original'),
              ),
            )
            .limit(1)
        : [];
      const showTech = Boolean(tech && original && failedBundle?.kind === 'waybill');
      const itemReason = `разбор накладной не удался: ${err.message}`;

      if (tech) {
        await db
          .update(sourceDocuments)
          .set({
            isTechnical: !showTech,
            status: showTech ? 'needs_resolution' : 'parse_failed',
            parseErrorCode: showTech ? 'not_processed' : 'internal_error',
            parseErrorDetails: { message: err.message },
            processedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(sourceDocuments.id, tech.id));
        await notifySourceDocumentUpdated(tech.id);
      }
      // Пакет мог быть дочерним (накладная из router'а): без отметки
      // родительская строка реестра осталась бы в created и файл исчез бы из
      // виду. Если техническая запись стала видимой — исход строки «документ
      // есть», иначе «провалился». Для не-дочернего пакета обновлять нечего:
      // запрос ничего не найдёт.
      if (showTech && tech) {
        try {
          await markSubBundleItemDocumented(db, bundleId, tech.id, itemReason);
        } catch (markErr) {
          logger.error({ err: markErr, bundleId }, 'не удалось отметить строку реестра документом');
        }
      } else {
        await markSubBundleItemFailed(bundleId, itemReason, logger);
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
  void processS3CleanupOutbox().catch((err) => logger.error({ err }, 's3 cleanup outbox failed'));
  setInterval(() => {
    void processS3CleanupOutbox().catch((err) => logger.error({ err }, 's3 cleanup outbox failed'));
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
      queueClient: queue,
      // loadEnv кеширует разобранное окружение, поэтому смена режима требует
      // перезапуска воркера — как и у остальных рубильников проекта.
      mode: loadEnv().RECOGNITION_RECOVERY_MODE,
    }).catch((err) => logger.error({ err }, 'stuck jobs repair failed'));
  runRepair();
  setInterval(runRepair, STUCK_INTERVAL_MS).unref();
}, 60 * 1000).unref();
