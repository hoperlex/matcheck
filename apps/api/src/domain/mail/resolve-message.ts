// Превращение письма в пакет документов.
//
// Письмо не получает собственного распознавателя: его вложения становятся
// таким же пакетом, какой создаёт кнопка «Загрузить документы», и дальше идут
// по существующему конвейеру — очередь upd-parse, тот же воркер, те же
// парсеры, те же «Ожидаемые».
//
// S3 не участвует в транзакции БД, поэтому это сага из двух транзакций:
//
//   T1  письмо quarantined → resolving, создаётся пакет в статусе resolving;
//   copy  staging → постоянные ключи (вне транзакции);
//   T2  технический документ, вложения, provenance и задание в outbox;
//       пакет resolving → queued, письмо resolving → ingested.
//
// Падение между шагами не оставляет «наполовину принятого» письма: пакет в
// статусе resolving нигде не показывается, а повтор проходит начисто.

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  ingestEvents,
  mailAttachments,
  mailMessages,
  sites,
  sourceBundles,
  sourceDocumentAttachments,
  sourceDocuments,
} from '../../db/schema.js';
import { enqueueJob } from '../jobs/job-outbox.js';
import { buildS3Key } from '../storage/s3.path.js';
import { UPD_PARSE_QUEUE } from '../../plugins/queue.js';

export type CopyObject = (srcKey: string, dstKey: string) => Promise<void>;

export type ResolveDeps = {
  db: Db;
  copyObject: CopyObject;
  log?: { warn?: (o: unknown, m?: string) => void };
};

export type ResolveParams = {
  /** Письмо в карантине. */
  messageId: string;
  siteId: string;
  direction?: 'inbound' | 'outbound';
  contractorId?: string | null;
  expectedDate?: string | null;
  /** Кто подтвердил. null — автоматический проход по явному маркеру. */
  actorUserId?: string | null;
};

export type ResolveOutcome =
  | { outcome: 'ingested'; bundleId: string; documentId: string }
  /** Тот же набор файлов уже загружен на этот же объект — новый пакет не нужен. */
  | { outcome: 'reused'; bundleId: string }
  /** Тот же набор файлов уже лежит на ДРУГОМ объекте — решает оператор. */
  | { outcome: 'cross_scope'; conflictingBundleId: string }
  | { outcome: 'no_attachments' }
  | { outcome: 'not_quarantined' };

/**
 * Хеш содержимого пакета. Считается ровно так же, как в `/upload-documents`:
 * sha256 от отсортированных sha256 файлов через `|`. Совпадение формата
 * обязательно — иначе один и тот же комплект, пришедший письмом и руками,
 * создаст два пакета.
 */
export function contentHashOf(fileHashes: readonly string[]): string {
  return createHash('sha256').update([...fileHashes].sort().join('|')).digest('hex');
}

/**
 * Канонический ключ идемпотентности со scope.
 *
 * Формат совпадает с backfill миграции 0074 (префикс `v1|manual|` исторический
 * и канал не обозначает): один и тот же комплект на один и тот же объект — это
 * один пакет, каким бы путём он ни пришёл.
 */
export function idempotencyKeyOf(scope: {
  siteId: string | null;
  direction: string;
  contractorId?: string | null;
  recipientMolId?: string | null;
  expectedDate?: string | null;
  contentHash: string;
}): string {
  return [
    'v1|manual',
    scope.siteId ?? '',
    scope.direction,
    scope.contractorId ?? '',
    scope.recipientMolId ?? '',
    scope.expectedDate ?? '',
    scope.contentHash,
  ].join('|');
}

function safeName(filename: string | null, idx: number): string {
  const base = (filename ?? '').replace(/[/\\]/g, '_').trim().slice(-100);
  return base || `file-${idx + 1}.bin`;
}

/**
 * Создаёт пакет документов из письма.
 *
 * Идемпотентно: повторный вызов для уже принятого письма вернёт существующий
 * пакет, а не создаст второй.
 */
export async function resolveMailMessage(
  deps: ResolveDeps,
  params: ResolveParams,
): Promise<ResolveOutcome> {
  const { db } = deps;
  const direction = params.direction ?? 'inbound';

  const [message] = await db
    .select()
    .from(mailMessages)
    .where(eq(mailMessages.id, params.messageId))
    .limit(1);
  if (!message) return { outcome: 'not_quarantined' };
  if (message.status === 'ingested' && message.bundleId) {
    return { outcome: 'reused', bundleId: message.bundleId };
  }
  if (message.status !== 'quarantined') return { outcome: 'not_quarantined' };

  // Берём только пригодные вложения: отброшенные и подозрительные на подпись
  // в пакет не идут, но остаются у письма и возвращаются оператором.
  const attachments = await db
    .select()
    .from(mailAttachments)
    .where(
      and(eq(mailAttachments.mailMessageId, message.id), eq(mailAttachments.state, 'kept')),
    )
    .orderBy(asc(mailAttachments.idx));
  if (attachments.length === 0) return { outcome: 'no_attachments' };

  const contentHash = contentHashOf(attachments.map((a) => a.sha256 ?? ''));

  // Тот же комплект уже загружен? Пока уникальность держится на bundle_hash,
  // объект в неё не входит, поэтому проверяем scope вручную: пакет чужого
  // объекта переиспользовать нельзя — это и есть тот дефект, из-за которого
  // один и тот же УПД «прилипал» к первой площадке.
  const [existing] = await db
    .select()
    .from(sourceBundles)
    .where(eq(sourceBundles.bundleHash, contentHash))
    .limit(1);
  if (existing) {
    if (existing.siteId !== params.siteId) {
      await db
        .update(mailMessages)
        .set({
          rejectReason: 'cross_scope_conflict',
          lastError: `тот же комплект уже загружен на другой объект (пакет ${existing.id})`,
          updatedAt: new Date(),
        })
        .where(eq(mailMessages.id, message.id));
      return { outcome: 'cross_scope', conflictingBundleId: existing.id };
    }
    await db
      .update(mailMessages)
      .set({ status: 'ingested', bundleId: existing.id, updatedAt: new Date() })
      .where(eq(mailMessages.id, message.id));
    await db.insert(ingestEvents).values({
      bundleId: existing.id,
      channel: 'mail',
      mailMessageId: message.id,
      actorUserId: params.actorUserId ?? null,
    });
    return { outcome: 'reused', bundleId: existing.id };
  }

  const resolveToken = randomUUID();
  const idempotencyKey = idempotencyKeyOf({
    siteId: params.siteId,
    direction,
    contractorId: params.contractorId ?? null,
    expectedDate: params.expectedDate ?? null,
    contentHash,
  });

  // ─── T1: резервируем пакет и переводим письмо в resolving ────────────────
  const bundleId = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(mailMessages)
      .set({ status: 'resolving', resolveToken, resolveStartedAt: new Date() })
      .where(and(eq(mailMessages.id, message.id), eq(mailMessages.status, 'quarantined')))
      .returning({ id: mailMessages.id });
    // Кто-то успел раньше — второй раз то же письмо не принимаем.
    if (!claimed) return null;

    const [bundle] = await tx
      .insert(sourceBundles)
      .values({
        bundleHash: contentHash,
        contentHash,
        idempotencyKey,
        origin: 'mail',
        kind: 'mixed',
        direction,
        siteId: params.siteId,
        contractorId: params.contractorId ?? null,
        expectedDate: params.expectedDate ? new Date(params.expectedDate) : null,
        // Пока пакет в этом статусе, он не показывается как загрузка.
        status: 'resolving',
        createdByUserId: params.actorUserId ?? null,
      })
      .returning({ id: sourceBundles.id });
    if (!bundle) throw new Error('resolve: не удалось создать пакет');

    await tx
      .update(mailMessages)
      .set({ bundleId: bundle.id })
      .where(eq(mailMessages.id, message.id));
    return bundle.id;
  });
  if (!bundleId) return { outcome: 'not_quarantined' };

  // ─── copy: staging → постоянные ключи ────────────────────────────────────
  const [site] = await db
    .select({ code: sites.code })
    .from(sites)
    .where(eq(sites.id, params.siteId))
    .limit(1);

  const copied: { s3Key: string; filename: string; mimeType: string; sizeBytes: number }[] = [];
  for (const [i, att] of attachments.entries()) {
    if (!att.stagingS3Key) continue;
    const name = safeName(att.filename, i);
    const dstKey = buildS3Key({
      site: site ?? null,
      counterparty: null,
      entityType: 'source-documents',
      entityId: bundleId,
      filename: `doc-${i + 1}-${name}`,
    });
    await deps.copyObject(att.stagingS3Key, dstKey);
    copied.push({
      s3Key: dstKey,
      filename: name,
      mimeType: att.sniffedMime ?? 'application/octet-stream',
      sizeBytes: att.sizeBytes,
    });
  }

  // ─── T2: документы, provenance и задание в очередь ───────────────────────
  const documentId = await db.transaction(async (tx) => {
    const now = new Date();
    const [tech] = await tx
      .insert(sourceDocuments)
      .values({
        kind: 'transport_waybill',
        // Служебная запись пакета: до инспектора не доходит (см. фильтры /sync).
        isTechnical: true,
        direction,
        origin: 'mail',
        contractorId: params.contractorId ?? null,
        siteId: params.siteId,
        expectedDate: params.expectedDate ? new Date(params.expectedDate) : null,
        status: 'queued',
        contentHash,
        originalFilename: copied[0]?.filename ?? null,
        queuedAt: now,
        parsedAt: now,
        bundleId,
        createdByUserId: params.actorUserId ?? null,
      })
      .returning({ id: sourceDocuments.id });
    if (!tech) throw new Error('resolve: не удалось создать технический документ');

    if (copied.length > 0) {
      await tx.insert(sourceDocumentAttachments).values(
        copied.map((c) => ({
          sourceDocumentId: tech.id,
          s3Key: c.s3Key,
          filename: c.filename,
          mimeType: c.mimeType,
          sizeBytes: c.sizeBytes,
          role: 'original' as const,
        })),
      );
    }

    await tx.insert(ingestEvents).values({
      bundleId,
      channel: 'mail',
      mailMessageId: message.id,
      actorUserId: params.actorUserId ?? null,
    });

    // Задание пишется в ТОЙ ЖЕ транзакции: падение Redis не оставит пакет
    // навсегда в queued без разбора.
    await enqueueJob(tx as unknown as Db, {
      queue: UPD_PARSE_QUEUE,
      jobName: 'parse',
      payload: { bundleId, mode: 'router' },
      dedupeKey: `bundle:${bundleId}:parse:0`,
    });

    await tx
      .update(sourceBundles)
      .set({ status: 'queued', updatedAt: now })
      .where(eq(sourceBundles.id, bundleId));

    // Закрываем сагу только своим токеном — чужой повтор её не «докатит».
    await tx
      .update(mailMessages)
      .set({ status: 'ingested', updatedAt: now })
      .where(and(eq(mailMessages.id, message.id), eq(mailMessages.resolveToken, resolveToken)));

    return tech.id;
  });

  return { outcome: 'ingested', bundleId, documentId };
}
