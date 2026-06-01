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
  sourceDocuments,
  sourceDocumentItems,
} from './db/schema.js';
import { sql as drSql } from 'drizzle-orm';
import {
  buildQueueConnection,
  S3_CLEANUP_QUEUE,
  UPD_PARSE_QUEUE,
  type S3CleanupJobData,
  type UpdParseJobData,
} from './plugins/queue.js';
import { deleteObject, getObject } from './domain/storage/s3.signer.js';
import { parseUpdPdf, PdfNoTextError } from './domain/edo/upd-pdf.parser.js';
import {
  parseTransportWaybill,
  type TransportWaybillInputImage,
} from './domain/edo/transport-waybill.parser.js';
import { cleanupPhotoOrphans } from './domain/jobs/photo-orphan-cleanup.js';
import { validateUpdTotals } from './domain/edo/upd-validation.js';
import { publishSseEvent } from './domain/sse/redis-bridge.js';
import { sourceDocumentAttachments } from './db/schema.js';
import type { UpdPdfParsed } from '@matcheck/contracts';

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
  const { sourceDocumentId, s3Key } = job.data;
  const log = logger.child({ sourceDocumentId, jobId: job.id });

  // Переводим в processing + считаем attempt. Если кто-то уже удалил
  // документ через DELETE /:id, returning() вернёт пустой массив — выходим.
  // returning().kind определяет, какой парсер запускать: УПД (текстовый
  // pdf-parse + LLM) или Транспортная накладная (vision-LLM с inline_data).
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

  if (proc.kind === 'transport_waybill') {
    await handleTransportWaybillJob(sourceDocumentId, log);
    return;
  }

  // ─── Дальше — старый УПД-флоу (kind='upd'/'request') ─────────────────────
  let buffer: Buffer;
  try {
    buffer = await getObject(s3Key);
  } catch (err) {
    log.error({ err, s3Key }, 's3 getObject failed');
    throw err;
  }

  let parsed: UpdPdfParsed;
  let llmProviderId: string | null = null;
  try {
    const r = await parseUpdPdf(buffer, { sourceDocumentId });
    parsed = r.parsed;
    llmProviderId = r.llmProviderId;
  } catch (err) {
    if (err instanceof PdfNoTextError) {
      await db
        .update(sourceDocuments)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'pdf_no_text',
          parseErrorDetails: { textLength: err.textLength },
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn({ textLength: err.textLength }, 'pdf has no text — marked parse_failed');
      await notifySourceDocumentUpdated(sourceDocumentId);
      return;
    }
    log.error({ err }, 'parse failed, will retry');
    throw err;
  }

  // Контрагенты.
  const supplier = parsed.supplier;
  const supplierId =
    supplier && supplier.inn && supplier.name
      ? await findOrCreateCounterparty(
          { inn: supplier.inn, kpp: supplier.kpp ?? null, name: supplier.name },
          'supplier',
        )
      : null;
  const recipient = parsed.recipient;
  const recipientId =
    recipient && recipient.inn && recipient.name
      ? await findOrCreateCounterparty(
          { inn: recipient.inn, kpp: recipient.kpp ?? null, name: recipient.name },
          'customer',
        )
      : null;

  // Проверка дубля. Считаем дублем УПД с тем же (supplier, docNumber,
  // docDate), уже принятый или ожидающий разрешения. Свою собственную
  // запись из выборки исключаем.
  const docDate = parsed.docDate ? new Date(parsed.docDate) : null;
  let duplicate: { id: string } | null = null;
  if (supplierId && parsed.docNumber && docDate) {
    const [existing] = await db
      .select({
        id: sourceDocuments.id,
        supplierName: counterparties.name,
      })
      .from(sourceDocuments)
      .leftJoin(counterparties, eq(sourceDocuments.supplierId, counterparties.id))
      .where(
        and(
          eq(sourceDocuments.kind, 'upd'),
          eq(sourceDocuments.supplierId, supplierId),
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
          // supplierId/recipientId важны для последующего показа в UI.
          supplierId,
          recipientId,
          llmProviderId,
          llmConfidence: parsed.confidence.toString(),
          processedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, sourceDocumentId));
      log.warn({ existingId: existing.id }, 'duplicate detected — needs_resolution');
      await notifySourceDocumentUpdated(sourceDocumentId);
    }
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
  const status: 'parsed' | 'needs_resolution' = hasMismatch ? 'needs_resolution' : 'parsed';
  const parseErrorCode: 'validation_mismatch' | null = hasMismatch ? 'validation_mismatch' : null;
  const parseErrorDetails = hasMismatch
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

  // Запись шапки.
  await db
    .update(sourceDocuments)
    .set({
      status,
      parseErrorCode,
      parseErrorDetails,
      supplierId,
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

// ─── Транспортная накладная: vision-LLM пайплайн ─────────────────────────
//
// Берём ВСЕ attachments записи (юзер мог приложить ТН лицевую + оборотную
// + паспорт качества + рукописную накладную), отдаём пакет в Gemini vision.
// Модель сама классифицирует и извлекает данные только из печатной ТН;
// found=false → ставим parse_failed, иначе сохраняем шапку и items.
async function handleTransportWaybillJob(
  sourceDocumentId: string,
  // Minimal logger-интерфейс: child() возвращает структурный pino-логер,
  // его полный тип не передаётся через границу функции без обобщения.
  // Берём только методы, которые реально вызываем.
  log: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  },
): Promise<void> {
  const attachments = await db
    .select()
    .from(sourceDocumentAttachments)
    .where(eq(sourceDocumentAttachments.sourceDocumentId, sourceDocumentId));
  if (attachments.length === 0) {
    await db
      .update(sourceDocuments)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'parse_failed',
        parseErrorDetails: { message: 'нет приложенных файлов' },
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceDocuments.id, sourceDocumentId));
    log.warn('transport_waybill: нет attachments — parse_failed');
    await notifySourceDocumentUpdated(sourceDocumentId);
    return;
  }

  const files: TransportWaybillInputImage[] = [];
  for (const a of attachments) {
    try {
      const buf = await getObject(a.s3Key);
      files.push({ buffer: buf, mimeType: a.mimeType ?? 'image/jpeg', filename: a.filename });
    } catch (err) {
      log.warn({ err, s3Key: a.s3Key }, 'transport_waybill: skip attachment, getObject failed');
    }
  }
  if (files.length === 0) {
    throw new Error('transport_waybill: не удалось скачать ни одного attachment');
  }

  let parsed;
  let llmProviderId: string | null = null;
  try {
    const r = await parseTransportWaybill(files, { sourceDocumentId });
    parsed = r.parsed;
    llmProviderId = r.llmProviderId;
  } catch (err) {
    log.error({ err }, 'transport_waybill parse failed, will retry');
    throw err;
  }

  // ТН в пакете не найдена → parse_failed с понятным кодом.
  if (!parsed.found) {
    await db
      .update(sourceDocuments)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'no_transport_waybill_found',
        parseErrorDetails: { confidence: parsed.confidence },
        llmProviderId,
        llmConfidence: parsed.confidence.toString(),
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceDocuments.id, sourceDocumentId));
    log.warn('transport_waybill not found in package');
    await notifySourceDocumentUpdated(sourceDocumentId);
    return;
  }

  // Контрагенты: ИНН опционален у ТН (может быть размыт/обрезан).
  // Без ИНН не создаём, чтобы не плодить дубли по разному написанию.
  const shipperId =
    parsed.shipper?.inn && parsed.shipper?.name
      ? await findOrCreateCounterparty(
          { inn: parsed.shipper.inn, kpp: null, name: parsed.shipper.name },
          'supplier',
        )
      : null;
  const consigneeId =
    parsed.consignee?.inn && parsed.consignee?.name
      ? await findOrCreateCounterparty(
          { inn: parsed.consignee.inn, kpp: null, name: parsed.consignee.name },
          'customer',
        )
      : null;

  const docDate = parsed.docDate ? new Date(parsed.docDate) : null;

  await db
    .update(sourceDocuments)
    .set({
      status: 'parsed',
      parseErrorCode: null,
      parseErrorDetails: null,
      supplierId: shipperId,
      // Грузополучатель в ТН — это «Подрядчик» в нашей терминологии,
      // но в schema у нас есть recipient_id (=customer counterparty).
      // Используем именно его — это то, кому документ адресован.
      recipientId: consigneeId,
      docNumber: parsed.docNumber ?? null,
      docDate,
      llmProviderId,
      llmConfidence: parsed.confidence.toString(),
      processedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sourceDocuments.id, sourceDocumentId));

  await db
    .delete(sourceDocumentItems)
    .where(eq(sourceDocumentItems.sourceDocumentId, sourceDocumentId));
  if (parsed.items.length > 0) {
    const rows = await Promise.all(
      parsed.items.map(async (it, idx) => ({
        sourceDocumentId,
        materialId: await findOrCreateMaterial(it.nameRaw, it.unit ?? null),
        nameRaw: it.nameRaw,
        qty: it.qty != null ? it.qty.toString() : '0',
        unit: it.unit && it.unit.trim() ? it.unit.trim() : 'шт',
        // Финансы в ТН не указываются (это перевозочный документ,
        // не отгрузочный) — оставляем NULL.
        price: null,
        sum: null,
        vatRate: null,
        vatSum: null,
        volumeM3: null,
        massKg: null,
        volumeConfidence: null,
        groupName: null,
        lineNo: idx + 1,
      })),
    );
    await db.insert(sourceDocumentItems).values(rows);
  }

  log.info(
    { itemsCount: parsed.items.length, docNumber: parsed.docNumber },
    'transport_waybill parsed successfully',
  );
  await notifySourceDocumentUpdated(sourceDocumentId);
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
  if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
    try {
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
    } catch (e) {
      logger.error({ err: e }, 'failed to mark document as parse_failed');
    }
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

