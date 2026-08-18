import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceDocumentAttachments, sourceDocuments } from '../../db/schema.js';
import { isBlocked, resolveReparsePlan } from '../sourceDocuments/reparse-plan.js';
import {
  dispatchKeyOf,
  documentSecondPassKeyOf,
  enqueueJob,
  supersedeJobAttempt,
} from './job-outbox.js';
import { recordDispatchEvent, type DispatchActor, type WorkHealth } from './job-health.js';

/** Initial generation + 2 recovery generations = максимум 3×3 BullMQ запуска. */
export const MAX_RECOVERY_ATTEMPTS = 2;

export type DocumentRecoveryOutcome =
  | { outcome: 'recovered'; generation: number; jobId: string }
  | { outcome: 'terminalized'; generation: number; reason: string }
  | { outcome: 'skipped' };

export function workHealthLabel(health: WorkHealth): string {
  if (health.state === 'terminal') return health.queueState;
  return health.state;
}

/**
 * Атомарно переводит незавершённый видимый документ на новое поколение.
 *
 * FOR UPDATE сериализует watchdog и ручную кнопку. CAS по поколению остаётся в
 * самом UPDATE: даже при будущей смене способа блокировки защита не исчезнет.
 */
export async function recoverDocumentAttempt(args: {
  db: Db;
  queueName: string;
  sourceDocumentId: string;
  expectedGeneration: number;
  health: WorkHealth;
  actor: DispatchActor;
}): Promise<DocumentRecoveryOutcome> {
  const observedState = workHealthLabel(args.health);
  return args.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [doc] = await tx
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, args.sourceDocumentId))
      .for('update')
      .limit(1);
    if (
      !doc ||
      doc.isTechnical ||
      doc.dispatchGeneration !== args.expectedGeneration ||
      !(['queued', 'processing'] as string[]).includes(doc.status)
    ) {
      return { outcome: 'skipped' as const };
    }

    const pendingSecondPass = (doc.secondPass as { state?: string } | null)?.state === 'queued';
    const oldJobId =
      doc.jobId ??
      (pendingSecondPass
        ? documentSecondPassKeyOf(doc.id, doc.dispatchGeneration)
        : dispatchKeyOf(doc.id, doc.dispatchGeneration));

    const terminalize = async (reason: string): Promise<DocumentRecoveryOutcome> => {
      const terminalGeneration = doc.dispatchGeneration + 1;
      const restore = restoreTargetFor(doc);
      const [closed] = await tx
        .update(sourceDocuments)
        .set({
          dispatchGeneration: terminalGeneration,
          jobId: null,
          ...(restore
            ? restore.values
            : {
                status: 'needs_resolution' as const,
                parseErrorCode: 'recovery_exhausted' as const,
                parseErrorDetails: {
                  message: reason,
                  observedState,
                  recoveryAttempts: doc.recoveryAttempts,
                },
              }),
          processedAt: new Date(),
          updatedAt: new Date(),
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
      await supersedeJobAttempt(tx, oldJobId);
      await recordDispatchEvent(tx, {
        workType: 'document',
        entityId: doc.id,
        generation: terminalGeneration,
        jobId: oldJobId,
        event: 'terminalized',
        observedState,
        reason,
        actor: args.actor,
        metadata: {
          recoveryAttempts: doc.recoveryAttempts,
          ...(restore ? { restoredFrom: restore.origin } : {}),
        },
      });
      return {
        outcome: 'terminalized' as const,
        generation: terminalGeneration,
        reason,
      };
    };

    if (doc.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      return terminalize(
        `распознавание не завершилось после ${MAX_RECOVERY_ATTEMPTS + 1} поколений`,
      );
    }

    const generation = doc.dispatchGeneration + 1;
    let payload: Record<string, unknown>;
    let jobId: string;
    if (pendingSecondPass) {
      const [attachment] = await tx
        .select({ s3Key: sourceDocumentAttachments.s3Key })
        .from(sourceDocumentAttachments)
        .where(
          and(
            eq(sourceDocumentAttachments.sourceDocumentId, doc.id),
            eq(sourceDocumentAttachments.role, 'original'),
          ),
        )
        .limit(1);
      if (!attachment) return terminalize('у документа нет оригинального файла');
      jobId = documentSecondPassKeyOf(doc.id, generation);
      payload = {
        sourceDocumentId: doc.id,
        s3Key: attachment.s3Key,
        pass: 'vision',
        docGeneration: generation,
      };
    } else {
      const plan = await resolveReparsePlan(tx, doc, generation);
      if (isBlocked(plan)) return terminalize(`recovery заблокирован: ${plan.blocked}`);
      jobId = plan.dedupeKey;
      payload = plan.payload;
    }

    const [bumped] = await tx
      .update(sourceDocuments)
      .set({
        status: 'queued',
        dispatchGeneration: generation,
        recoveryAttempts: doc.recoveryAttempts + 1,
        queuedAt: new Date(),
        jobId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceDocuments.id, doc.id),
          eq(sourceDocuments.dispatchGeneration, doc.dispatchGeneration),
          inArray(sourceDocuments.status, ['queued', 'processing']),
        ),
      )
      .returning({ id: sourceDocuments.id });
    if (!bumped) return { outcome: 'skipped' as const };

    await supersedeJobAttempt(tx, oldJobId);
    await enqueueJob(tx, {
      queue: args.queueName,
      jobName: 'parse',
      payload,
      dedupeKey: jobId,
    });
    await recordDispatchEvent(tx, {
      workType: 'document',
      entityId: doc.id,
      generation,
      jobId,
      event: 'recovered',
      observedState,
      reason: 'актуальное задание отсутствует или не может завершиться',
      actor: args.actor,
      metadata: {
        oldGeneration: doc.dispatchGeneration,
        oldJobId,
        recoveryAttempt: doc.recoveryAttempts + 1,
      },
    });
    return { outcome: 'recovered' as const, generation, jobId };
  });
}

/** Состояние документа до неудавшейся попытки — то, куда его возвращает терминализация. */
type RestoreTarget = {
  /** Откуда взят снимок: попадает в append-only журнал попыток. */
  origin: 'reparse_snapshot' | 'second_pass';
  values: Record<string, unknown>;
};

/**
 * Куда вернуть документ, у которого распознавание исчерпало попытки.
 *
 * Заглушка `recovery_exhausted` уместна только там, где результата НЕ БЫЛО:
 * первичный разбор так и не дошёл до конца. Но в `processing` попадает и работа
 * поверх уже распознанного документа — ручной повтор и второй проход vision. Для
 * них заглушка означала бы регресс: документ с номером, суммой и позициями
 * пропал бы с планшета (инспектору видно только `parsed`) из-за неудачи
 * НЕОБЯЗАТЕЛЬНОГО уточнения. Менеджер при этом даже не поймёт, что потерял:
 * реквизиты в строке остаются, а статус говорит «не распознано».
 *
 * Поэтому терминализация сначала ищет, что было до попытки, и возвращает
 * документ туда. Это тот же «видимый терминальный исход» — просто видимое
 * состояние здесь богаче заглушки.
 *
 * Ручной повтор отбирается по НЕЗАВЕРШЁННОМУ state, а не по равенству
 * поколений: recovery успевает поднять `dispatch_generation` на каждой попытке,
 * и снимок законно отстаёт от него на число попыток. Завершённый повтор
 * (`succeeded`/`failed`) снимком уже не распоряжается — его результат применён.
 */
export function restoreTargetFor(doc: {
  reparse: unknown;
  secondPass: unknown;
}): RestoreTarget | null {
  const reparse = doc.reparse as
    | { state?: string; snapshot?: Record<string, unknown> }
    | null
    | undefined;
  if (reparse?.snapshot && (reparse.state === 'queued' || reparse.state === 'processing')) {
    const snap = reparse.snapshot as {
      status?: string;
      parseErrorCode?: string | null;
      parseErrorDetails?: Record<string, unknown> | null;
      validation?: unknown;
      processedAt?: string | null;
      secondPass?: unknown;
    };
    return {
      origin: 'reparse_snapshot',
      values: {
        // parse_failed — как в rollbackReparse: снимок без статуса означает
        // документ, который и до повтора не был разобран.
        status: snap.status ?? 'parse_failed',
        parseErrorCode: snap.parseErrorCode ?? null,
        parseErrorDetails: snap.parseErrorDetails ?? null,
        validation: snap.validation ?? null,
        secondPass: snap.secondPass ?? null,
        reparse: {
          ...reparse,
          state: 'failed',
          reason: 'распознавание не завершилось, документ возвращён к прежнему виду',
          finishedAt: new Date().toISOString(),
        },
      },
    };
  }

  const secondPass = doc.secondPass as
    | { state?: string; restore?: Record<string, unknown> }
    | null
    | undefined;
  if (secondPass?.state === 'queued' && secondPass.restore) {
    const restore = secondPass.restore as {
      status?: string | null;
      parseErrorCode?: string | null;
      parseErrorDetails?: Record<string, unknown> | null;
    };
    return {
      origin: 'second_pass',
      values: {
        status: restore.status ?? 'parse_failed',
        parseErrorCode: restore.parseErrorCode ?? null,
        parseErrorDetails: restore.parseErrorDetails ?? null,
        secondPass: {
          ...secondPass,
          state: 'failed',
          reason: 'второй проход не завершился, результат первого прохода сохранён',
          finishedAt: new Date().toISOString(),
        },
      },
    };
  }

  return null;
}
