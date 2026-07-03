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
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { logger } from './lib/logger.js';
import { db } from './db/client.js';
import {
  counterparties,
  materials,
  sourceBundles,
  sourceDocuments,
  sourceDocumentItems,
  suppliers,
} from './db/schema.js';
import { sql as drSql } from 'drizzle-orm';
import { matchOrCreateSupplier } from './domain/sourceDocuments/supplierMatcher.js';
import {
  buildQueueConnection,
  S3_CLEANUP_QUEUE,
  UPD_PARSE_QUEUE,
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
import { normalizeM15ZeroTotals } from './domain/edo/m15-normalize.js';
import {
  getExcelVisionFallbackReasons,
  mergeExcelStructuralWithVision,
} from './domain/edo/excel-vision-fallback.js';
import { publishSseEvent } from './domain/sse/redis-bridge.js';
import { sourceDocumentAttachments, bundleImportItems } from './db/schema.js';
import { createHash } from 'node:crypto';
import { classifyFile } from './domain/edo/document-router.js';
import { classifyImageKind } from './domain/edo/vision-classifier.js';
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

async function handleJob(job: Job<UpdParseJobData>): Promise<void> {
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
  if ('bundleId' in job.data && job.data.bundleId) {
    const log = logger.child({ bundleId: job.data.bundleId, jobId: job.id });
    await handleWaybillBundleJob(job.data.bundleId, log);
    return;
  }
  if (!job.data.sourceDocumentId || !job.data.s3Key) {
    logger.warn({ jobId: job.id, data: job.data }, 'unknown job payload — skipping');
    return;
  }
  const { sourceDocumentId, s3Key } = job.data;
  const log = logger.child({ sourceDocumentId, jobId: job.id });

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
  let buffer: Buffer;
  try {
    buffer = await getObject(s3Key);
  } catch (err) {
    log.error({ err, s3Key }, 's3 getObject failed');
    throw err;
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
  try {
    if (job.data.docKind === 'm15') {
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
          } else {
            throw err;
          }
        }
      }
    }
  } catch (err) {
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
    if (existing) {
      duplicate = { id: existing.id };
      await db
        .update(sourceDocuments)
        .set({
          status: 'needs_resolution',
          parseErrorCode: 'duplicate_upd',
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
          llmProviderId,
          llmConfidence: parsed.confidence.toString(),
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn(
        { existingId: existing.id, confidence, parsedViaVision },
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

  if (duplicate) return;

  // Толлинг-М-15 без стоимостной части (итог прописью «Ноль»): доопределяем
  // totalSum/vatSum в 0, чтобы документ не падал в partial_parse из-за
  // недетерминизма vision (0 vs null). Для всех прочих документов — no-op.
  // См. m15-normalize.ts.
  parsed = normalizeM15ZeroTotals(parsed, job.data.docKind);

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
  await db
    .update(sourceDocuments)
    .set({
      status,
      parseErrorCode,
      parseErrorDetails,
      supplierId: null,
      supplierDirectoryId,
      recipientId,
      docNumber: parsed.docNumber ?? null,
      docDate,
      totalSum: parsed.totalSum != null ? parsed.totalSum.toString() : null,
      vatSum: parsed.vatSum != null ? parsed.vatSum.toString() : null,
      llmProviderId,
      llmConfidence: parsed.confidence.toString(),
      validation,
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sourceDocuments.id, sourceDocumentId));

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

  log.info(
    { itemsCount: parsed.items.length, status, parseErrorCode },
    'upd parsed successfully',
  );
  await notifySourceDocumentUpdated(sourceDocumentId);
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
  const [tech] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.bundleId, bundleId))
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
  // продублированы в реальные source_documents.
  await db.delete(sourceDocuments).where(eq(sourceDocuments.id, techId));

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

// Единый вход «Загрузить документы» (router). Классифицирует КАЖДЫЙ файл пачки
// и разворачивает его в СУЩЕСТВУЮЩИЙ проверенный flow:
//   - УПД → одиночная очередь {sourceDocumentId, s3Key} (как «Загрузить УПД»);
//   - накладная (ТН/ОС-2) → отдельный waybill-bundle {bundleId} (как
//     «Загрузить накладные»).
// Router сам документы НЕ парсит и НЕ создаёт «с нуля» — переиспользует рабочий
// код, поэтому данные не портятся. Каждое решение пишется в bundle_import_items
// (журнал). Неуверенные / vision-требующие / m15 / unknown → status='needs_review'
// БЕЗ создания операционных документов (Этап 4 добавит vision-доклассификацию).
async function handleDocumentRouterJob(bundleId: string, log: WorkerLog): Promise<void> {
  const [bundle] = await db
    .update(sourceBundles)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(eq(sourceBundles.id, bundleId))
    .returning();
  if (!bundle) {
    log.warn('router bundle is gone — skipping');
    return;
  }

  const [tech] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.bundleId, bundleId))
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
    log.warn('router bundle has no technical source_document — parse_failed');
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
    log.warn('router bundle: нет attachments — parse_failed');
    return;
  }

  const bundleExpected =
    bundle.expectedDate instanceof Date
      ? bundle.expectedDate
      : bundle.expectedDate
        ? new Date(bundle.expectedDate)
        : null;

  // Идемпотентность журнала: при повторной обработке этого bundle (BullMQ
  // retry или повторная загрузка того же набора файлов — bundleHash совпадает)
  // старые записи bundle_import_items надо убрать, иначе они НАКАПЛИВАЮТСЯ и
  // import-result показывает дубли (1 файл → 2-3-4 строки, в т.ч. с reason от
  // прежних версий кода). Чистим перед заполнением.
  await db.delete(bundleImportItems).where(eq(bundleImportItems.bundleId, bundleId));

  let createdCount = 0;
  let failedCount = 0;

  for (const a of attachments) {
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
        await db.insert(bundleImportItems).values({
          bundleId,
          sourceFilename: a.filename,
          parserUsed: 'none',
          status: 'failed',
          reason: 'не удалось скачать файл из S3',
        });
        failedCount++;
        continue;
      }

      let cls = await classifyFile(buffer, a.mimeType ?? '', a.filename);

      // Vision-доклассификация типа: если детерминированно тип не определён
      // (фото/скан/битый PDF без маркера в имени → detectedKind='unknown',
      // needsVision) — спрашиваем модель, что это за документ по изображению.
      // Так фото М-15/накладной не уходит по умолчанию в УПД (кейс «Су-10
      // Алюспэйс»). Лёгкий запрос (1 картинка, ≤200 токенов). При неуверенности
      // (< 0.6) / ошибке classifyImageKind вернёт null или unknown → cls не
      // меняется, файл идёт прежним путём (УПД-vision) — уже работающие сканы
      // УПД не затрагиваются.
      if (cls.detectedKind === 'unknown' && cls.needsVision) {
        const vc = await classifyImageKind(buffer, a.mimeType ?? '', { sourceDocumentId: null });
        if (vc && vc.confidence >= 0.6 && vc.kind !== 'unknown') {
          cls = {
            ...cls,
            detectedKind: vc.kind,
            signals: [...cls.signals, `vision-kind:${vc.kind}:${vc.confidence.toFixed(2)}`],
          };
        }
      }

      // Накладная (по тексту ИЛИ по vision-доклассификации) → waybill-парсер.
      // ВСЁ ОСТАЛЬНОЕ — в УПД-flow (ветка else): УПД-парсер сам покрывает
      // Excel (parseUpdXlsx), текстовый PDF (parseUpdPdf) и скан/фото/битый
      // текстовый слой (parseUpdVision). Благодаря этому сканы, фото и PDF с
      // «битыми» глифами 1С НЕ теряются, а распознаются. Главное — на КАЖДЫЙ
      // файл создаётся видимая строка (12 загрузил → 12 строк).
      const isWaybill =
        cls.detectedKind === 'transport_waybill' || cls.detectedKind === 'os2_transfer';

      if (cls.detectedKind === 'm15') {
        // М-15 (накладная на отпуск материалов). Создаём документ типа
        // «Накладная» (transport_waybill — новых enum не вводим) и ставим
        // одиночный job с docKind:'m15' → handleJob распознает его vision'ом по
        // форме М-15. Изолировано: УПД/ТН/ОС-2 не затрагиваются.
        const [doc] = await db
          .insert(sourceDocuments)
          .values({
            kind: 'transport_waybill',
            direction: bundle.direction,
            origin: 'manual_pdf',
            status: 'queued',
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            siteId: bundle.siteId,
            expectedDate: bundleExpected,
            originalFilename: a.filename,
            queuedAt: new Date(),
            parsedAt: new Date(),
            createdByUserId: bundle.createdByUserId,
          })
          .returning({ id: sourceDocuments.id });
        const docId = doc!.id;
        await db.insert(sourceDocumentAttachments).values({
          sourceDocumentId: docId,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: 'original',
        });
        const job = await queue.add('parse', {
          sourceDocumentId: docId,
          s3Key: a.s3Key,
          docKind: 'm15',
        });
        if (job.id) {
          await db
            .update(sourceDocuments)
            .set({ jobId: job.id })
            .where(eq(sourceDocuments.id, docId));
        }
        await db.insert(bundleImportItems).values({
          bundleId,
          sourceFilename: a.filename,
          detectedKind: 'm15',
          confidence: cls.confidence.toString(),
          parserUsed: 'parseUpdVision',
          status: 'created',
          createdDocumentIds: [docId],
          reason: 'М-15 (отпуск материалов) → распознавание по форме М-15',
          metadata: { signals: cls.signals, needsVision: cls.needsVision },
        });
        createdCount++;
      } else if (isWaybill) {
        // Разворачиваем в waybill-flow: отдельный под-bundle на этот файл
        // (тот же путь, что «Загрузить накладные»).
        const subHash = createHash('sha256').update(`router:${bundleId}:${a.s3Key}`).digest('hex');
        const [subBundle] = await db
          .insert(sourceBundles)
          .values({
            bundleHash: subHash,
            kind: 'waybill',
            direction: bundle.direction,
            siteId: bundle.siteId,
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            expectedDate: bundle.expectedDate,
            status: 'queued',
            createdByUserId: bundle.createdByUserId,
          })
          .returning({ id: sourceBundles.id });
        const subId = subBundle!.id;
        const [subTech] = await db
          .insert(sourceDocuments)
          .values({
            kind: 'transport_waybill',
            direction: bundle.direction,
            origin: 'manual_pdf',
            status: 'queued',
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            siteId: bundle.siteId,
            expectedDate: bundleExpected,
            originalFilename: a.filename,
            queuedAt: new Date(),
            bundleId: subId,
            createdByUserId: bundle.createdByUserId,
          })
          .returning({ id: sourceDocuments.id });
        await db.insert(sourceDocumentAttachments).values({
          sourceDocumentId: subTech!.id,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: 'original',
        });
        await queue.add('parse', { bundleId: subId });
        await db.insert(bundleImportItems).values({
          bundleId,
          sourceFilename: a.filename,
          detectedKind: cls.detectedKind,
          confidence: cls.confidence.toString(),
          parserUsed: 'parseWaybillBatch',
          status: 'created',
          createdDocumentIds: [],
          reason: 'накладная → waybill-парсер',
          metadata: { signals: cls.signals, subBundleId: subId },
        });
        createdCount++;
      } else {
        // УПД-flow (одиночный, тот же путь, что «Загрузить УПД»). Сюда попадают:
        //  - УПД (Excel / текстовый PDF) — детерминированно;
        //  - сканы, фото, PDF с битым текстовым слоем (needsVision) — handleJob
        //    распознает их через parseUpdVision;
        //  - m15 / unknown — пробуем распознать; в худшем случае выйдет черновик
        //    (partial_parse), но строка не пропадёт и оригинал останется для
        //    ручной доработки.
        const [doc] = await db
          .insert(sourceDocuments)
          .values({
            kind: 'upd',
            direction: bundle.direction,
            origin: 'manual_pdf',
            status: 'queued',
            contractorId: bundle.contractorId,
            recipientMolId: bundle.recipientMolId,
            siteId: bundle.siteId,
            expectedDate: bundleExpected,
            originalFilename: a.filename,
            queuedAt: new Date(),
            parsedAt: new Date(),
            createdByUserId: bundle.createdByUserId,
          })
          .returning({ id: sourceDocuments.id });
        const docId = doc!.id;
        await db.insert(sourceDocumentAttachments).values({
          sourceDocumentId: docId,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: 'original',
        });
        const job = await queue.add('parse', { sourceDocumentId: docId, s3Key: a.s3Key });
        if (job.id) {
          await db
            .update(sourceDocuments)
            .set({ jobId: job.id })
            .where(eq(sourceDocuments.id, docId));
        }
        const reason =
          cls.detectedKind === 'upd' && !cls.needsVision
            ? cls.updInvoiceCount && cls.updInvoiceCount >= 2
              ? `УПД-пачка (${cls.updInvoiceCount} счёт-фактур) → агрегат`
              : 'УПД → одиночный парсер'
            : cls.needsVision
              ? 'скан/фото/неясный текст → распознавание через vision'
              : 'тип неоднозначен → попытка распознавания';
        await db.insert(bundleImportItems).values({
          bundleId,
          sourceFilename: a.filename,
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
        createdCount++;
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err), file: a.filename },
        'router: ошибка обработки файла — помечаем failed, продолжаем',
      );
      await db
        .insert(bundleImportItems)
        .values({
          bundleId,
          sourceFilename: a.filename,
          parserUsed: 'none',
          status: 'failed',
          reason: 'внутренняя ошибка обработки файла',
        })
        .catch(() => undefined);
      failedCount++;
    }
  }

  // Техническая запись router-bundle больше не нужна — её attachments
  // переиспользованы по s3Key в развёрнутых документах (паттерн как у waybill).
  await db.delete(sourceDocuments).where(eq(sourceDocuments.id, techId));
  await db
    .update(sourceBundles)
    .set({ status: 'parsed', kind: 'mixed', docCount: createdCount, updatedAt: new Date() })
    .where(eq(sourceBundles.id, bundleId));
  log.info({ created: createdCount, failed: failedCount }, 'router bundle classified');
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
  //   - consignee (грузополучатель) → операционный contractor через
  //     counterparties, как было раньше.
  //   - ОС-2 (внутреннее перемещение) — обе стороны внутренние, supplier_id
  //     остаётся NULL.
  let supplierDirectoryId: string | null = null;
  let recipientId: string | null = null;
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
    }
    if (doc.consignee?.inn && doc.consignee?.name) {
      recipientId = await findOrCreateCounterparty(
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
      recipientId,
      contractorId: bundle.contractorId,
      recipientMolId: bundle.recipientMolId,
      siteId: bundle.siteId,
      docNumber: doc.docNumber ?? null,
      docDate,
      totalSum: doc.totalSum != null ? doc.totalSum.toString() : null,
      expectedDate: bundleExpected,
      origin: 'manual_pdf',
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

async function recoverStaleProcessing(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  const stale = await db
    .select({ id: sourceDocuments.id })
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
  // Точечная постановка джобов: для каждой записи берём S3-ключ из её
  // attachments (роль original) и кладём в очередь заново.
  for (const s of stale) {
    const [att] = await db.execute(
      drSql`select s3_key from source_document_attachments
            where source_document_id = ${s.id} and role = 'original'
            order by created_at desc limit 1`,
    );
    const s3Key = (att as { s3_key?: string } | undefined)?.s3_key;
    if (s3Key) {
      // Воркер сам кладёт в свою очередь — connection переиспользуется.
      await queue.add('parse', { sourceDocumentId: s.id, s3Key });
    }
  }
  logger.warn({ count: stale.length }, 'recovered stale processing documents');
}

const connection = buildQueueConnection();

// Лёгкий клиент к собственной очереди, чтобы recovery мог положить
// потерянные джобы обратно.
const queue = new Queue<UpdParseJobData>(UPD_PARSE_QUEUE, { connection });

const worker = new Worker<UpdParseJobData>(UPD_PARSE_QUEUE, handleJob, {
  connection,
  concurrency: CONCURRENCY,
});

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
  try {
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
      // Помечаем и техническую source_document, если она ещё жива.
      const [tech] = await db
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.bundleId, bundleId))
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
});

s3CleanupWorker.on('completed', (job) => {
  logger.info({ jobId: job.id, queue: S3_CLEANUP_QUEUE }, 's3 cleanup job completed');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  await worker.close().catch(() => undefined);
  await s3CleanupWorker.close().catch(() => undefined);
  await queue.close().catch(() => undefined);
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
