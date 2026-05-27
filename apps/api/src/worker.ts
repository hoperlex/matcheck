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
import { cleanupPhotoOrphans } from './domain/jobs/photo-orphan-cleanup.js';
import { validateUpdTotals } from './domain/edo/upd-validation.js';
import type { UpdPdfParsed } from '@matcheck/contracts';

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
  const [proc] = await db
    .update(sourceDocuments)
    .set({
      status: 'processing',
      jobAttempts: drSql`${sourceDocuments.jobAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(sourceDocuments.id, sourceDocumentId))
    .returning({ id: sourceDocuments.id });
  if (!proc) {
    log.warn('source document is gone — skipping job');
    return;
  }

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

