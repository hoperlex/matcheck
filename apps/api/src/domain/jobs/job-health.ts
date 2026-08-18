import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { jobOutbox, recognitionDispatchEvents } from '../../db/schema.js';

export const RECOGNITION_JOB_MAX_RUNTIME_MS = 20 * 60 * 1000;

export type WorkHealth =
  | { state: 'alive_transport'; outboxAttempts: number }
  | { state: 'alive'; queueState: string }
  | { state: 'missing' }
  | { state: 'terminal'; queueState: 'completed' | 'failed' }
  | { state: 'overdue'; activeForMs: number }
  | { state: 'stranded'; outboxAttempts: number }
  | { state: 'unknown'; reason: string };

export type QueueJobSnapshot = {
  getState: () => Promise<string>;
  processedOn?: number;
  timestamp?: number;
};

export type WorkHealthQueue = {
  getJob: (jobId: string) => Promise<QueueJobSnapshot | undefined | null>;
};

/**
 * Классифицирует уже полученный BullMQ job. Вынесено отдельно, чтобы границы
 * active-overdue проверялись без Redis и реальной БД.
 */
export async function classifyBullJob(
  job: QueueJobSnapshot,
  opts: { nowMs?: number; maxRuntimeMs?: number } = {},
): Promise<WorkHealth> {
  const queueState = await job.getState();
  if (queueState === 'completed' || queueState === 'failed') {
    return { state: 'terminal', queueState };
  }
  // BullMQ 5 возвращает литерал 'unknown', когда job существует, но ни в одном
  // из известных множеств не числится — типично для гонки с удалением по
  // removeOnComplete. Правило «всё, кроме терминальных, живо» отнесло бы это к
  // alive, и документ висел бы в очереди вечно: сторож видел бы здоровую
  // работу, которой на самом деле нет. Отдаём unknown — сторож пропустит запись
  // сейчас, но её возраст попадёт под предел health_unknown_age.
  if (queueState === 'unknown') {
    return { state: 'unknown', reason: 'BullMQ вернул состояние unknown' };
  }
  if (queueState === 'active') {
    const nowMs = opts.nowMs ?? Date.now();
    const startedAt = job.processedOn ?? job.timestamp ?? nowMs;
    const activeForMs = Math.max(0, nowMs - startedAt);
    if (activeForMs > (opts.maxRuntimeMs ?? RECOGNITION_JOB_MAX_RUNTIME_MS)) {
      return { state: 'overdue', activeForMs };
    }
  }
  // Остальные состояния BullMQ (waiting, delayed, prioritized, waiting-children)
  // означают работу, которая ещё может пойти.
  return { state: 'alive', queueState };
}

/**
 * Смотрит на обе половины транспорта: durable outbox и BullMQ.
 *
 * Если outbox ещё доставляется, ошибка Redis не превращает работу в missing:
 * consumer всё равно продолжит доставку. Для parked Redis обязателен — job мог
 * успеть создаться перед сбоем удаления outbox-строки.
 */
export async function inspectWorkHealth(args: {
  db: Db;
  queue: WorkHealthQueue;
  jobId: string | null;
  nowMs?: number;
  maxRuntimeMs?: number;
}): Promise<WorkHealth> {
  const { db, queue, jobId } = args;
  if (!jobId) return { state: 'missing' };

  const [outbox] = await db
    .select({
      attempts: jobOutbox.attempts,
      parkedAt: jobOutbox.parkedAt,
    })
    .from(jobOutbox)
    .where(and(eq(jobOutbox.dedupeKey, jobId), isNull(jobOutbox.supersededAt)))
    .limit(1);

  let job: QueueJobSnapshot | undefined | null;
  try {
    job = await queue.getJob(jobId);
  } catch (err) {
    if (outbox && !outbox.parkedAt) {
      return { state: 'alive_transport', outboxAttempts: outbox.attempts };
    }
    return {
      state: 'unknown',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (job) {
    try {
      return await classifyBullJob(job, {
        nowMs: args.nowMs,
        maxRuntimeMs: args.maxRuntimeMs,
      });
    } catch (err) {
      return {
        state: 'unknown',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (!outbox) return { state: 'missing' };
  if (outbox.parkedAt) {
    return { state: 'stranded', outboxAttempts: outbox.attempts };
  }
  return { state: 'alive_transport', outboxAttempts: outbox.attempts };
}

export type DispatchWorkType = 'document' | 'bundle' | 'segment';
export type DispatchActor = 'watchdog' | 'manual' | 'worker';

/** Append-only: функция только INSERT'ит и никогда не правит прежние события. */
export async function recordDispatchEvent(
  tx: Db,
  event: {
    workType: DispatchWorkType;
    entityId: string;
    generation: number;
    jobId: string;
    event: 'recovered' | 'terminalized' | 'dispatched' | 'superseded';
    observedState?: string | null;
    reason?: string | null;
    actor: DispatchActor;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await tx.insert(recognitionDispatchEvents).values({
    ...event,
    observedState: event.observedState ?? null,
    reason: event.reason ?? null,
    metadata: event.metadata ?? null,
  });
}
