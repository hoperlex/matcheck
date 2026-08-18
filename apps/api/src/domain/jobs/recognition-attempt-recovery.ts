import { and, eq, inArray, isNull, or, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { bundleSegments, sourceBundles, sourceDocuments } from '../../db/schema.js';
import {
  assemblyDispatchKeyOf,
  bundleDispatchKeyOf,
  enqueueJob,
  segmentDispatchKeyOf,
  supersedeJobAttempt,
} from './job-outbox.js';
import { recordDispatchEvent, type DispatchActor, type WorkHealth } from './job-health.js';
import { MAX_RECOVERY_ATTEMPTS, workHealthLabel } from './recognition-recovery.js';

export type RecoveryOutcome =
  | { outcome: 'recovered'; generation: number; jobId: string }
  | { outcome: 'terminalized'; generation: number; reason: string }
  | { outcome: 'skipped' };

async function rootHasVisibleDocuments(tx: Db, rootId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: sourceDocuments.id })
    .from(sourceDocuments)
    .innerJoin(sourceBundles, eq(sourceBundles.id, sourceDocuments.bundleId))
    .where(
      and(
        eq(sourceDocuments.isTechnical, false),
        or(eq(sourceBundles.id, rootId), eq(sourceBundles.parentBundleId, rootId)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Recovery неопубликованного сегмента. Поколение сборки остаётся адресом
 * манифеста, а dispatchGeneration является отдельным fence попытки.
 */
export async function recoverSegmentAttempt(args: {
  db: Db;
  queueName: string;
  segmentId: string;
  sourceDocumentId: string;
  expectedGeneration: number;
  expectedDocGeneration: number;
  health: WorkHealth;
  actor: DispatchActor;
}): Promise<RecoveryOutcome> {
  const observedState = workHealthLabel(args.health);
  return args.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [segment] = await tx
      .select()
      .from(bundleSegments)
      .where(eq(bundleSegments.id, args.segmentId))
      .for('update')
      .limit(1);
    if (
      !segment ||
      segment.sourceDocumentId !== args.sourceDocumentId ||
      segment.publishedAt ||
      segment.dispatchGeneration !== args.expectedGeneration
    ) {
      return { outcome: 'skipped' as const };
    }

    const [doc] = await tx
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, args.sourceDocumentId))
      .for('update')
      .limit(1);
    if (
      !doc ||
      !doc.isTechnical ||
      doc.dispatchGeneration !== args.expectedDocGeneration ||
      !(['queued', 'processing'] as string[]).includes(doc.status)
    ) {
      return { outcome: 'skipped' as const };
    }

    const [sub] = doc.bundleId
      ? await tx
          .select()
          .from(sourceBundles)
          .where(eq(sourceBundles.id, doc.bundleId))
          .for('update')
          .limit(1)
      : [];
    const rootId = sub?.parentBundleId ?? segment.bundleId;
    const oldJobId = doc.jobId ?? segmentDispatchKeyOf(segment.id, segment.dispatchGeneration);

    const terminalize = async (reason: string): Promise<RecoveryOutcome> => {
      const now = new Date();
      const terminalGeneration = segment.dispatchGeneration + 1;
      const terminalDocGeneration = doc.dispatchGeneration + 1;
      const [closed] = await tx
        .update(sourceDocuments)
        .set({
          isTechnical: false,
          dispatchGeneration: terminalDocGeneration,
          jobId: null,
          bundleId: null,
          status: 'needs_resolution',
          parseErrorCode: 'recovery_exhausted',
          parseErrorDetails: { message: reason, health: observedState },
          processedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(sourceDocuments.id, doc.id),
            eq(sourceDocuments.dispatchGeneration, doc.dispatchGeneration),
            inArray(sourceDocuments.status, ['queued', 'processing']),
          ),
        )
        .returning({ id: sourceDocuments.id });
      if (!closed) return { outcome: 'skipped' as const };

      await tx
        .update(bundleSegments)
        .set({ sourceDocumentId: null, dispatchGeneration: terminalGeneration, updatedAt: now })
        .where(
          and(
            eq(bundleSegments.id, segment.id),
            eq(bundleSegments.dispatchGeneration, segment.dispatchGeneration),
          ),
        );
      if (sub) {
        await tx
          .update(sourceBundles)
          .set({
            status: 'parse_failed',
            parseErrorCode: 'recovery_exhausted',
            parseErrorMessage: reason.slice(0, 500),
            dispatchGeneration: sub.dispatchGeneration + 1,
            jobId: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(sourceBundles.id, sub.id),
              eq(sourceBundles.dispatchGeneration, sub.dispatchGeneration),
            ),
          );
        await supersedeJobAttempt(tx, sub.jobId);
      }
      await tx
        .update(sourceBundles)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'recovery_exhausted',
          parseErrorMessage: reason.slice(0, 500),
          updatedAt: now,
        })
        .where(eq(sourceBundles.id, rootId));
      await supersedeJobAttempt(tx, oldJobId);
      await recordDispatchEvent(tx, {
        workType: 'segment',
        entityId: segment.id,
        generation: terminalGeneration,
        jobId: oldJobId,
        event: 'terminalized',
        observedState,
        reason,
        actor: args.actor,
      });
      return { outcome: 'terminalized' as const, generation: terminalGeneration, reason };
    };

    if (await rootHasVisibleDocuments(tx, rootId)) {
      return terminalize('recovery сегмента запрещён: состав машины уже опубликован частично');
    }
    if (
      segment.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS ||
      doc.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS
    ) {
      return terminalize('распознавание сегмента не завершилось после лимита recovery-поколений');
    }

    const generation = segment.dispatchGeneration + 1;
    const docGeneration = doc.dispatchGeneration + 1;
    const jobId = segmentDispatchKeyOf(segment.id, generation);
    const now = new Date();
    const [bumpedSegment] = await tx
      .update(bundleSegments)
      .set({
        dispatchGeneration: generation,
        recoveryAttempts: segment.recoveryAttempts + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(bundleSegments.id, segment.id),
          eq(bundleSegments.dispatchGeneration, segment.dispatchGeneration),
        ),
      )
      .returning({ id: bundleSegments.id });
    if (!bumpedSegment) return { outcome: 'skipped' as const };

    const [bumpedDoc] = await tx
      .update(sourceDocuments)
      .set({
        status: 'queued',
        dispatchGeneration: docGeneration,
        recoveryAttempts: doc.recoveryAttempts + 1,
        queuedAt: now,
        jobId,
        updatedAt: now,
      })
      .where(
        and(
          eq(sourceDocuments.id, doc.id),
          eq(sourceDocuments.dispatchGeneration, doc.dispatchGeneration),
          inArray(sourceDocuments.status, ['queued', 'processing']),
        ),
      )
      .returning({ id: sourceDocuments.id });
    if (!bumpedDoc) return { outcome: 'skipped' as const };

    await supersedeJobAttempt(tx, oldJobId);
    await enqueueJob(tx, {
      queue: args.queueName,
      jobName: 'parse',
      payload: {
        sourceDocumentId: doc.id,
        segmentId: segment.id,
        generation: segment.generation,
        segmentGeneration: generation,
        docGeneration,
        bundleGeneration: sub?.dispatchGeneration,
      },
      dedupeKey: jobId,
    });
    await recordDispatchEvent(tx, {
      workType: 'segment',
      entityId: segment.id,
      generation,
      jobId,
      event: 'recovered',
      observedState,
      reason: 'актуальное задание сегмента отсутствует или не может завершиться',
      actor: args.actor,
      metadata: { oldGeneration: segment.dispatchGeneration, oldJobId, docGeneration },
    });
    return { outcome: 'recovered' as const, generation, jobId };
  });
}

/** Атомарный recovery router, waybill или assembly job новым поколением. */
export async function recoverBundleAttempt(args: {
  db: Db;
  queueName: string;
  bundleId: string;
  expectedGeneration: number;
  health: WorkHealth;
  actor: DispatchActor;
}): Promise<RecoveryOutcome> {
  const observedState = workHealthLabel(args.health);
  return args.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [bundle] = await tx
      .select()
      .from(sourceBundles)
      .where(eq(sourceBundles.id, args.bundleId))
      .for('update')
      .limit(1);
    if (
      !bundle ||
      bundle.dispatchGeneration !== args.expectedGeneration ||
      !(['queued', 'processing'] as string[]).includes(bundle.status)
    ) {
      return { outcome: 'skipped' as const };
    }

    const rootId = bundle.parentBundleId ?? bundle.id;
    const isAssembly = bundle.kind === 'upd' && Boolean(bundle.parentBundleId);
    const [root] = isAssembly
      ? await tx
          .select({ uploadGeneration: sourceBundles.activeUploadGeneration })
          .from(sourceBundles)
          .where(eq(sourceBundles.id, rootId))
          .for('update')
          .limit(1)
      : [{ uploadGeneration: 0 }];
    if (!root) return { outcome: 'skipped' as const };

    const oldJobId =
      bundle.jobId ??
      (isAssembly
        ? assemblyDispatchKeyOf(bundle.id, bundle.dispatchGeneration)
        : bundleDispatchKeyOf(bundle.id, bundle.dispatchGeneration));

    const terminalize = async (reason: string): Promise<RecoveryOutcome> => {
      const now = new Date();
      const terminalGeneration = bundle.dispatchGeneration + 1;
      const [closed] = await tx
        .update(sourceBundles)
        .set({
          status: 'parse_failed',
          parseErrorCode: 'recovery_exhausted',
          dispatchGeneration: terminalGeneration,
          jobId: null,
          parseErrorMessage: reason.slice(0, 500),
          updatedAt: now,
        })
        .where(
          and(
            eq(sourceBundles.id, bundle.id),
            eq(sourceBundles.dispatchGeneration, bundle.dispatchGeneration),
          ),
        )
        .returning({ id: sourceBundles.id });
      if (!closed) return { outcome: 'skipped' as const };

      const technicalAttempts = await tx
        .select({ jobId: sourceDocuments.jobId })
        .from(sourceDocuments)
        .where(and(eq(sourceDocuments.bundleId, bundle.id), eq(sourceDocuments.isTechnical, true)));
      if (isAssembly) {
        await tx
          .update(bundleSegments)
          .set({
            dispatchGeneration: drSql`${bundleSegments.dispatchGeneration} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(bundleSegments.bundleId, rootId),
              eq(bundleSegments.generation, root.uploadGeneration),
              isNull(bundleSegments.publishedAt),
            ),
          );
      }
      await tx
        .update(sourceDocuments)
        .set({
          isTechnical: false,
          bundleId: null,
          dispatchGeneration: drSql`${sourceDocuments.dispatchGeneration} + 1`,
          jobId: null,
          status: 'needs_resolution',
          parseErrorCode: 'recovery_exhausted',
          parseErrorDetails: { message: reason, health: observedState },
          processedAt: now,
          updatedAt: now,
        })
        .where(and(eq(sourceDocuments.bundleId, bundle.id), eq(sourceDocuments.isTechnical, true)));
      for (const attempt of technicalAttempts) {
        await supersedeJobAttempt(tx, attempt.jobId);
      }
      await supersedeJobAttempt(tx, oldJobId);
      await recordDispatchEvent(tx, {
        workType: 'bundle',
        entityId: bundle.id,
        generation: terminalGeneration,
        jobId: oldJobId,
        event: 'terminalized',
        observedState,
        reason,
        actor: args.actor,
      });
      return { outcome: 'terminalized' as const, generation: terminalGeneration, reason };
    };

    if (await rootHasVisibleDocuments(tx, rootId)) {
      return terminalize('recovery пакета запрещён: в машине уже есть видимые документы');
    }
    if (bundle.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      return terminalize('разбор пакета не завершился после лимита recovery-поколений');
    }

    const generation = bundle.dispatchGeneration + 1;
    const jobId = isAssembly
      ? assemblyDispatchKeyOf(bundle.id, generation)
      : bundleDispatchKeyOf(bundle.id, generation);
    const payload = isAssembly
      ? {
          bundleId: bundle.id,
          mode: 'upd_assembly' as const,
          generation: root.uploadGeneration,
          bundleGeneration: generation,
        }
      : bundle.kind === 'mixed'
        ? { bundleId: bundle.id, mode: 'router' as const, bundleGeneration: generation }
        : { bundleId: bundle.id, bundleGeneration: generation };
    const [bumped] = await tx
      .update(sourceBundles)
      .set({
        status: 'queued',
        dispatchGeneration: generation,
        recoveryAttempts: bundle.recoveryAttempts + 1,
        jobId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceBundles.id, bundle.id),
          eq(sourceBundles.dispatchGeneration, bundle.dispatchGeneration),
          inArray(sourceBundles.status, ['queued', 'processing']),
        ),
      )
      .returning({ id: sourceBundles.id });
    if (!bumped) return { outcome: 'skipped' as const };

    await supersedeJobAttempt(tx, oldJobId);
    await enqueueJob(tx, {
      queue: args.queueName,
      jobName: 'parse',
      payload,
      dedupeKey: jobId,
    });
    await recordDispatchEvent(tx, {
      workType: 'bundle',
      entityId: bundle.id,
      generation,
      jobId,
      event: 'recovered',
      observedState,
      reason: 'актуальное пакетное задание отсутствует или не может завершиться',
      actor: args.actor,
      metadata: { oldGeneration: bundle.dispatchGeneration, oldJobId },
    });
    return { outcome: 'recovered' as const, generation, jobId };
  });
}
