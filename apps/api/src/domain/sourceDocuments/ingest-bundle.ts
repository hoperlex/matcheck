// Приём пакета документов: общее ядро для кнопки менеджера и публичной
// страницы поставщика.
//
// Раньше вся эта логика (хеши, идемпотентность, S3, техническая запись,
// постановка в очередь) жила внутри HTTP-хендлера `/upload-documents`. Второй
// канал приёма скопировал бы её целиком, и следующая правка распознавания
// делалась бы дважды. Роуты теперь отвечают только за разбор запроса и коды
// ответа.
//
// Два канала различаются двумя параметрами, а не двумя реализациями:
//
//   dispatch     как задание попадает в BullMQ. `direct` — прежний
//                queue.add после коммита (внутренний путь, поведение не
//                менялось). `outbox` — строка в job_outbox в ТОЙ ЖЕ
//                транзакции: недоступность Redis не оставляет пакет висеть
//                в queued навсегда, доставку повторит consumer воркера.
//
//   concurrency  `legacy` — прежний поиск/перезапуск. `reserve` — протокол
//                резервирования против одновременных запросов: публичный вход
//                открыт всем, две вкладки с одним комплектом реальны.

import { and, eq, isNull, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  counterparties,
  ingestEvents,
  s3CleanupOutbox,
  sites,
  sourceBundles,
  sourceDocumentAttachments,
  sourceDocuments,
} from '../../db/schema.js';
import { bundleDispatchKeyOf, enqueueJob, type JobQueue } from '../jobs/job-outbox.js';
import { buildS3Key } from '../storage/s3.path.js';
import { putObject } from '../storage/s3.signer.js';
import { UPD_PARSE_QUEUE } from '../../plugins/queue.js';
import {
  contentHashOf,
  expectedDateKeyOf,
  fileHashOf,
  idempotencyKeyOf,
  safeName,
} from './bundle-key.js';

export type IngestFile = { filename: string; mimeType: string; buffer: Buffer };

/** Анкета публичной отправки. Данные недоверенные — только аудит и показ. */
export type PublicSubmission = {
  submitterName: string;
  submitterPhone: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Судьба файлов ИМЕННО ЭТОЙ отправки по входному фильтру. */
  manifest: Array<{ filename: string; accepted: boolean; reason?: string }>;
  /** Непрозрачный идентификатор обращения, который увидит поставщик. */
  ticket: string;
};

export type IngestBundleDeps = {
  db: Db;
  /** Нужна только при dispatch:'direct'. */
  queue: JobQueue;
  log: { error: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
};

export type IngestBundleParams = {
  files: IngestFile[];
  direction: 'inbound' | 'outbound';
  siteId: string;
  contractorId?: string | null;
  recipientMolId?: string | null;
  /** 'YYYY-MM-DD' */
  expectedDate?: string | null;
  actorUserId: string | null;
  dispatch: 'direct' | 'outbox';
  concurrency: 'legacy' | 'reserve';
  publicSubmission?: PublicSubmission | null;
};

export type IngestBundleResult =
  | { outcome: 'created'; bundleId: string; ticket: string | null }
  | { outcome: 'reused'; bundleId: string; status: string; ticket: string | null }
  /** Те же байты, но другой объект/дата/получатель — чужой пакет не отдаём. */
  | { outcome: 'cross_scope'; existingBundleId: string }
  | { outcome: 's3_unavailable'; bundleId: string };

/**
 * Сколько пакет без документов считается «в работе», а не осиротевшим.
 *
 * Между созданием пакета и вставкой технической записи лежит заливка в S3 —
 * десятки секунд на пачке фото. Без этого окна второй одновременный запрос
 * увидел бы пакет без документов, счёл бы его брошенным и залил бы всё заново.
 */
const ORPHAN_GRACE_MS = 60_000;

type BundleRow = typeof sourceBundles.$inferSelect;

/** Совпадает ли scope существующего пакета с текущей загрузкой. */
function scopeMatches(bundle: BundleRow, params: IngestBundleParams): boolean {
  return (
    bundle.siteId === params.siteId &&
    bundle.direction === params.direction &&
    (bundle.contractorId ?? null) === (params.contractorId ?? null) &&
    (bundle.recipientMolId ?? null) === (params.recipientMolId ?? null) &&
    expectedDateKeyOf(bundle.expectedDate) === (params.expectedDate ?? null)
  );
}

async function hasDocuments(db: Db, bundleId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.bundleId, bundleId))
    .limit(1);
  return !!row;
}

/** Событие приёма публичной отправки. Новая отправка — новое событие и тикет. */
async function recordPublicSubmission(
  db: Db,
  bundleId: string,
  submission: PublicSubmission,
): Promise<void> {
  await db.insert(ingestEvents).values({
    bundleId,
    channel: 'public',
    publicTicket: submission.ticket,
    submitterName: submission.submitterName,
    submitterPhone: submission.submitterPhone,
    submitterIp: submission.ip,
    submitterUserAgent: submission.userAgent,
    submissionManifest: submission.manifest,
  });
}

/**
 * Ставит ключи в очередь отложенного удаления.
 *
 * Вызывается, когда файлы уже в S3, а запись о них создать не удалось: без
 * этого объекты остались бы в бакете навсегда, никем не связанные.
 */
async function scheduleS3Cleanup(
  db: Db,
  bundleId: string,
  keys: string[],
  log: IngestBundleDeps['log'],
): Promise<void> {
  if (keys.length === 0) return;
  try {
    await db.insert(s3CleanupOutbox).values(
      keys.map((s3Key) => ({ s3Key, entityType: 'source-documents', entityId: bundleId })),
    );
  } catch (err) {
    // Последний рубеж: сироты в S3 хуже, чем шумная строка в логе, но
    // ронять из-за них ответ клиенту тоже незачем.
    log.warn({ err, bundleId, keys: keys.length }, 'не удалось запланировать чистку S3');
  }
}

export async function ingestDocumentsBundle(
  deps: IngestBundleDeps,
  params: IngestBundleParams,
): Promise<IngestBundleResult> {
  const { db, log } = deps;
  const { files, direction, siteId, publicSubmission } = params;
  const contractorId = params.contractorId ?? null;
  const recipientMolId = params.recipientMolId ?? null;
  const expectedDate = params.expectedDate ?? null;
  const reserve = params.concurrency === 'reserve';

  const contentHash = contentHashOf(files.map((f) => fileHashOf(f.buffer)));
  const idempotencyKey = idempotencyKeyOf({
    siteId,
    direction,
    contractorId,
    recipientMolId,
    expectedDate,
    contentHash,
  });

  // ─── 1. Поиск существующего пакета ────────────────────────────────────────
  //
  // Сначала по scoped-ключу. Если не нашли — по содержимому: до перевода
  // writers ключ не заполнялся, поэтому у всех ранее загруженных пакетов он
  // NULL, и поиск только по ключу принял бы свой же пакет за чужой scope.
  let existing: BundleRow | undefined;
  const [byKey] = await db
    .select()
    .from(sourceBundles)
    .where(eq(sourceBundles.idempotencyKey, idempotencyKey))
    .limit(1);
  existing = byKey;

  if (!existing) {
    const [byHash] = await db
      .select()
      .from(sourceBundles)
      .where(eq(sourceBundles.bundleHash, contentHash))
      .limit(1);
    if (byHash) {
      if (!scopeMatches(byHash, params)) {
        return { outcome: 'cross_scope', existingBundleId: byHash.id };
      }
      // Свой scope, ключа просто ещё нет — дозаполняем и переиспользуем.
      if (!byHash.idempotencyKey) {
        await db
          .update(sourceBundles)
          .set({ idempotencyKey, contentHash })
          .where(and(eq(sourceBundles.id, byHash.id), isNull(sourceBundles.idempotencyKey)));
      }
      existing = byHash;
    }
  }

  // ─── 2. Пакет уже есть и разобран — новой работы нет ──────────────────────
  if (existing && (await hasDocuments(db, existing.id))) {
    if (publicSubmission) await recordPublicSubmission(db, existing.id, publicSubmission);
    return {
      outcome: 'reused',
      bundleId: existing.id,
      status: existing.status,
      ticket: publicSubmission?.ticket ?? null,
    };
  }

  // ─── 3. Резервирование пакета ─────────────────────────────────────────────
  const now = new Date();
  const bundleValues = {
    kind: 'mixed' as const,
    direction,
    siteId,
    contractorId,
    recipientMolId,
    expectedDate: expectedDate ? new Date(expectedDate) : null,
    status: 'queued' as const,
    parseErrorCode: null,
    parseErrorMessage: null,
    docCount: 0,
  };

  let bundle: BundleRow;
  let generation: number;

  if (existing) {
    // Пакет есть, документов нет: либо его бросили (сбой воркера, ручная
    // чистка), либо параллельный запрос прямо сейчас льёт файлы в S3.
    const restart = reserve
      ? await db
          .update(sourceBundles)
          .set({
            ...bundleValues,
            idempotencyKey,
            contentHash,
            dispatchGeneration: drSql`${sourceBundles.dispatchGeneration} + 1`,
            createdByUserId: params.actorUserId ?? existing.createdByUserId,
            updatedAt: now,
          })
          .where(
            and(
              eq(sourceBundles.id, existing.id),
              drSql`${sourceBundles.updatedAt} < now() - make_interval(secs => ${ORPHAN_GRACE_MS / 1000})`,
            ),
          )
          .returning()
      : await db
          .update(sourceBundles)
          .set({
            ...bundleValues,
            idempotencyKey,
            contentHash,
            createdByUserId: params.actorUserId ?? existing.createdByUserId,
            updatedAt: now,
          })
          .where(eq(sourceBundles.id, existing.id))
          .returning();

    const [updated] = restart;
    if (!updated) {
      // CAS не сработал: пакет свежий, значит им занят кто-то другой.
      // Повторная заливка тех же файлов только удвоила бы работу.
      if (publicSubmission) await recordPublicSubmission(db, existing.id, publicSubmission);
      return {
        outcome: 'reused',
        bundleId: existing.id,
        status: existing.status,
        ticket: publicSubmission?.ticket ?? null,
      };
    }
    bundle = updated;
    generation = updated.dispatchGeneration;
  } else {
    const inserted = reserve
      ? await db
          .insert(sourceBundles)
          .values({ bundleHash: contentHash, contentHash, idempotencyKey, ...bundleValues, createdByUserId: params.actorUserId })
          // Уникальность держится на bundle_hash: одновременный запрос с тем
          // же комплектом не должен получить SQL-ошибку — он просто проиграл
          // гонку и дальше переиспользует чужой пакет.
          .onConflictDoNothing({ target: sourceBundles.bundleHash })
          .returning()
      : await db
          .insert(sourceBundles)
          .values({ bundleHash: contentHash, contentHash, idempotencyKey, ...bundleValues, createdByUserId: params.actorUserId })
          .returning();

    const [created] = inserted;
    if (!created) {
      // Гонку выиграл другой запрос. Перечитываем и решаем по scope.
      const [winner] = await db
        .select()
        .from(sourceBundles)
        .where(eq(sourceBundles.bundleHash, contentHash))
        .limit(1);
      if (!winner) throw new Error('ingest: пакет исчез после конфликта вставки');
      if (!scopeMatches(winner, params)) {
        return { outcome: 'cross_scope', existingBundleId: winner.id };
      }
      if (publicSubmission) await recordPublicSubmission(db, winner.id, publicSubmission);
      return {
        outcome: 'reused',
        bundleId: winner.id,
        status: winner.status,
        ticket: publicSubmission?.ticket ?? null,
      };
    }
    bundle = created;
    generation = created.dispatchGeneration;
  }

  // ─── 4. Файлы в S3 ────────────────────────────────────────────────────────
  const [site] = await db
    .select({ code: sites.code })
    .from(sites)
    .where(eq(sites.id, siteId))
    .limit(1);
  const [cp] = contractorId
    ? await db
        .select({ inn: counterparties.inn, name: counterparties.name })
        .from(counterparties)
        .where(eq(counterparties.id, contractorId))
        .limit(1)
    : [];

  const uploads = await Promise.allSettled(
    files.map(async (f, i) => {
      const name = safeName(f.filename, i);
      const s3Key = buildS3Key({
        site: site ?? null,
        counterparty: cp ?? null,
        entityType: 'source-documents',
        entityId: bundle.id,
        filename: `doc-${i + 1}-${name}`,
      });
      await putObject(s3Key, f.buffer, f.mimeType || 'application/octet-stream');
      return {
        s3Key,
        filename: name,
        mimeType: f.mimeType || 'application/octet-stream',
        sizeBytes: f.buffer.length,
      };
    }),
  );

  const succeeded = uploads.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failed = uploads.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    // Раньше здесь стоял Promise.all: успевшие объекты оставались в бакете
    // навсегда, потому что запись о них не создавалась.
    log.error({ err: (failed[0] as PromiseRejectedResult).reason }, 's3 putObject failed');
    await scheduleS3Cleanup(db, bundle.id, succeeded.map((a) => a.s3Key), log);
    await db
      .update(sourceBundles)
      .set({
        status: 'parse_failed',
        parseErrorCode: 'internal_error',
        parseErrorMessage: 's3_unavailable',
        updatedAt: new Date(),
      })
      .where(eq(sourceBundles.id, bundle.id));
    return { outcome: 's3_unavailable', bundleId: bundle.id };
  }

  // ─── 5. Записи о пакете + задание ─────────────────────────────────────────
  try {
    await db.transaction(async (tx) => {
      const stamp = new Date();
      const [tech] = await tx
        .insert(sourceDocuments)
        .values({
          kind: 'transport_waybill',
          // Служебная запись пакета: воркер удалит её и развернёт реальные
          // документы. Из /sync, списка и экспорта исключается по флагу.
          isTechnical: true,
          direction,
          origin: 'manual_pdf',
          contractorId,
          recipientMolId,
          siteId,
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          status: 'queued',
          contentHash,
          originalFilename: files[0]?.filename ?? null,
          queuedAt: stamp,
          parsedAt: stamp,
          bundleId: bundle.id,
          createdByUserId: params.actorUserId,
        })
        .returning();
      if (!tech) throw new Error('ingest: не удалось создать техническую запись пакета');

      await tx.insert(sourceDocumentAttachments).values(
        succeeded.map((a) => ({
          sourceDocumentId: tech.id,
          s3Key: a.s3Key,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          role: 'original' as const,
        })),
      );

      if (publicSubmission) {
        await tx.insert(ingestEvents).values({
          bundleId: bundle.id,
          channel: 'public',
          publicTicket: publicSubmission.ticket,
          submitterName: publicSubmission.submitterName,
          submitterPhone: publicSubmission.submitterPhone,
          submitterIp: publicSubmission.ip,
          submitterUserAgent: publicSubmission.userAgent,
          submissionManifest: publicSubmission.manifest,
        });
      }

      if (params.dispatch === 'outbox') {
        // Приведение как в domain/mail/resolve-message.ts: тип транзакции
        // drizzle структурно не совпадает с Db, хотя API идентичен.
        await enqueueJob(tx as unknown as Db, {
          queue: UPD_PARSE_QUEUE,
          jobName: 'parse',
          payload: { bundleId: bundle.id, mode: 'router' },
          dedupeKey: bundleDispatchKeyOf(bundle.id, generation),
        });
      }
    });
  } catch (err) {
    // Файлы уже в S3, а ссылок на них не появилось — убираем за собой.
    await scheduleS3Cleanup(db, bundle.id, succeeded.map((a) => a.s3Key), log);
    throw err;
  }

  if (params.dispatch === 'direct') {
    // Прежнее поведение внутреннего входа: недоступность Redis поднимается
    // наверх как ошибка запроса.
    await deps.queue.add('parse', { bundleId: bundle.id, mode: 'router' } as never);
  }

  return {
    outcome: 'created',
    bundleId: bundle.id,
    ticket: publicSubmission?.ticket ?? null,
  };
}
