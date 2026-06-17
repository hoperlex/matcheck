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
import { parseUpdPdf, PdfNoTextError } from './domain/edo/upd-pdf.parser.js';
import { parseUpdVision } from './domain/edo/upd-vision.parser.js';
import { parseUpdXlsx } from './domain/edo/upd-xlsx.parser.js';

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
import { cleanupPhotoOrphans } from './domain/jobs/photo-orphan-cleanup.js';
import { validateUpdTotals } from './domain/edo/upd-validation.js';
import { publishSseEvent } from './domain/sse/redis-bridge.js';
import { sourceDocumentAttachments } from './db/schema.js';
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

const CONCURRENCY = 2;
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
  // Очередь UPD_PARSE_QUEUE обслуживает два вида job: УПД (sourceDocumentId+s3Key)
  // и накладные batch (bundleId). См. UpdParseJobData в plugins/queue.ts.
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
  //   pdf c текстом → parseUpdPdf (pdf-parse → LLM text).
  //   pdf-скан      → parseUpdPdf бросит PdfNoTextError →
  //                   fallback на parseUpdVision (Gemini Vision).
  //   jpg/png/webp  → сразу parseUpdVision.
  //
  // Vision pipeline переиспользует тот же UpdPdfParsedSchema, что и
  // текстовый — на уровне DTO они взаимозаменяемы, контракт
  // SourceDocumentSchema не трогается.
  const isXlsx = /\.xlsx?$/i.test(s3Key);
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
    if (isXlsx) {
      parsed = await parseUpdXlsx(buffer);
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
      // PDF — сначала быстрый text-pipeline.
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
            // Vision не сработал (провайдер не поддерживает PDF /
            // сетевая ошибка). Не критично: оставляем text-LLM
            // результат (пустые поля) — документ попадёт в
            // partial_parse как раньше. Пользователь дополнит руками.
            log.warn(
              { visionErr },
              'text-LLM empty + vision retry failed — keep partial_parse',
            );
          }
        }
      } catch (err) {
        if (err instanceof PdfNoTextError) {
          // PDF-скан без текстового слоя — fallback на Vision. Раньше
          // здесь сразу шёл parse_failed, и пользователь видел тупик.
          log.warn(
            { textLength: err.textLength },
            'pdf has no text — falling back to vision LLM',
          );
          try {
            const r = await parseUpdVision(
              { buffer, mimeType: 'application/pdf', filename: s3Key },
              { sourceDocumentId },
            );
            parsed = r.parsed;
            llmProviderId = r.llmProviderId;
            parsedViaVision = true;
          } catch (visionErr) {
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
  } catch (err) {
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
        qty: it.qty.toString(),
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

