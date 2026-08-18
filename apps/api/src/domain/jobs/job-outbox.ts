import { and, eq, inArray, isNull, lt, lte, or, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { jobOutbox } from '../../db/schema.js';

/**
 * Transactional outbox для постановки задач в очередь.
 *
 * Зачем. `queue.add` вызывается после коммита бизнес-транзакции, поэтому
 * недоступность Redis в этот момент оставляет пакет в статусе `queued` без
 * job — навсегда: повторная загрузка того же набора файлов вернёт
 * `alreadyExists` и нового задания не поставит. Строка outbox пишется в ОДНОЙ
 * транзакции с пакетом, а доставку в BullMQ берёт на себя consumer воркера.
 *
 * Дедупликация — по `dedupeKey`, который является идентификатором ПОПЫТКИ
 * диспетчеризации (`bundle~<id>~parse~<generation>`), а не сущности. Он же
 * передаётся в `queue.add` как `jobId`: BullMQ не создаст второй job с тем же
 * идентификатором, поэтому повторная обработка той же строки безопасна.
 * Идентификатор сущности здесь не годится — BullMQ держит завершённые jobs
 * сутки (`removeOnComplete`), и намеренный повторный разбор молча не
 * запустился бы.
 */

/**
 * Ключи диспетчеризации. Повтор доставки ОДНОЙ outbox-строки сохраняет ключ,
 * поэтому BullMQ не создаёт дубль. Recovery, напротив, атомарно увеличивает
 * `generation`, supersede'ит старую строку и получает новый jobId; старый
 * worker после этого отсекается generation-fencing.
 *
 * `generation` — счётчик ручных и watchdog-recovery попыток.
 *
 * Разделитель — `~`, а НЕ двоеточие: BullMQ строит из jobId ключи Redis и
 * отвергает идентификаторы с `:` ошибкой «Custom Id cannot contain :». С
 * двоеточиями задания молча не доставлялись, а документы висели в queued.
 */
const KEY_SEP = '~';

/** Символы, запрещённые BullMQ в custom job id. */
const FORBIDDEN_IN_JOB_ID = /:/;

function assertValidKey(key: string): string {
  if (FORBIDDEN_IN_JOB_ID.test(key)) {
    throw new Error(`недопустимый ключ задания: ${key}`);
  }
  return key;
}

export function dispatchKeyOf(sourceDocumentId: string, generation = 0): string {
  return assertValidKey(['doc', sourceDocumentId, 'parse', generation].join(KEY_SEP));
}

export function bundleDispatchKeyOf(bundleId: string, generation = 0): string {
  return assertValidKey(['bundle', bundleId, 'parse', generation].join(KEY_SEP));
}

/**
 * Ключ сборки логических УПД для пакета.
 *
 * Отдельный от bundleDispatchKeyOf: у дочернего пакета сборки и обычного
 * пакетного разбора разные обработчики, и общий ключ означал бы, что повторная
 * постановка одного вытесняет другое.
 */
export function assemblyDispatchKeyOf(bundleId: string, generation = 0): string {
  return assertValidKey(['bundle', bundleId, 'assembly', generation].join(KEY_SEP));
}

/**
 * Ключ распознавания одного сегмента.
 *
 * Адресует сегмент манифеста, а не файл: страницы сегмента лежат в разных
 * файлах. Recovery сохраняет segmentId, но увеличивает generation, чтобы
 * терминальный BullMQ job прежней попытки не заблокировал новую.
 */
export function segmentDispatchKeyOf(segmentId: string, generation = 0): string {
  return assertValidKey(['segment', segmentId, 'parse', generation].join(KEY_SEP));
}

/**
 * Ключ ВТОРОГО прохода документа (повторное распознавание картинкой).
 *
 * Отдельный от ключей пакета: второй проход адресует конкретный документ, а не
 * загрузку. Он же служит защитой от дублей — BullMQ не создаст второе задание с
 * тем же jobId, а `onConflictDoNothing` по dedupe_key не создаст вторую строку
 * outbox. Восстановление зависших заданий обязано использовать ЭТОТ же ключ,
 * иначе документ распознается дважды.
 */
export function documentSecondPassKeyOf(sourceDocumentId: string, generation = 0): string {
  // Поколение в ключе — по той же причине, по которой оно есть у остальных:
  // BullMQ держит завершённые задания сутки, и после РУЧНОГО повтора документа
  // (кнопка «Распознать повторно», dispatch_generation растёт) ключ без
  // поколения совпал бы с уже отработавшим — второй проход молча не запустился
  // бы. Значение по умолчанию сохраняет прежний вид ключа для документов,
  // которые ни разу не переразбирали.
  return assertValidKey(
    generation === 0
      ? ['doc', sourceDocumentId, 'parse', 'vision'].join(KEY_SEP)
      : ['doc', sourceDocumentId, 'parse', 'vision', generation].join(KEY_SEP),
  );
}

export const OUTBOX_BATCH = 50;
export const OUTBOX_LEASE_MS = 5 * 60 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 12;
export const OUTBOX_INTERVAL_MS = 15 * 1000;

/**
 * Минимум, который нужен consumer'у от BullMQ-очереди.
 *
 * `data: never` — единственная форма, совместимая с `Queue<T>` при любом T:
 * параметр функции контравариантен, поэтому очередь с конкретным типом job'а
 * подходит под это описание. Payload лежит в БД как jsonb и статически не
 * типизирован — его разбирает обработчик задания.
 */
export type JobQueue = {
  add: (name: string, data: never, opts?: { jobId?: string }) => Promise<unknown>;
};

export type EnqueueJobInput = {
  /** Имя очереди BullMQ, например UPD_PARSE_QUEUE. */
  queue: string;
  /** Имя задания внутри очереди, например 'parse'. */
  jobName: string;
  payload: Record<string, unknown>;
  /** Идентификатор попытки диспетчеризации; он же станет jobId. */
  dedupeKey: string;
};

/**
 * Записывает задание в outbox. Вызывать ВНУТРИ бизнес-транзакции — тогда job
 * и данные появляются атомарно.
 *
 * Повтор с тем же `dedupeKey` игнорируется: это ретрай той же попытки, а не
 * новый запуск. Намеренный повтор обязан прийти с новым `dedupeKey`
 * (инкремент `dispatch_generation`).
 */
export async function enqueueJob(tx: Db, input: EnqueueJobInput): Promise<void> {
  await tx
    .insert(jobOutbox)
    .values({
      queue: input.queue,
      jobName: input.jobName,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing({ target: jobOutbox.dedupeKey });
}

/**
 * Выводит старую попытку из доставки, не уничтожая улику об инциденте.
 *
 * Вызывать в той же транзакции, где сущность получает новое поколение и
 * записывается новый outbox job.
 */
export async function supersedeJobAttempt(tx: Db, dedupeKey: string | null): Promise<void> {
  if (!dedupeKey) return;
  await tx
    .update(jobOutbox)
    .set({ supersededAt: drSql`now()`, processingAt: null })
    .where(and(eq(jobOutbox.dedupeKey, dedupeKey), isNull(jobOutbox.supersededAt)));
}

export type ProcessJobOutboxDeps = {
  db: Db;
  /** Очереди по имени: consumer сам выбирает нужную по строке outbox. */
  queues: Record<string, JobQueue>;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
};

export type ProcessJobOutboxResult = { dispatched: number; failed: number };

/**
 * Разбирает готовые строки outbox и ставит их в BullMQ.
 *
 * Паттерн тот же, что у `processS3CleanupOutbox`: батч под
 * `FOR UPDATE SKIP LOCKED`, лизинг через `processing_at` (зависшие после краха
 * воркера строки возвращаются в работу по истечении лиза), успех — строка
 * удаляется, ошибка — `attempts++` с экспоненциальным backoff.
 */
export async function processJobOutbox(
  deps: ProcessJobOutboxDeps,
): Promise<ProcessJobOutboxResult> {
  const { db, queues, log } = deps;

  // Всё время берётся из БД, а не из процесса. Строки создаются с
  // `next_attempt_at DEFAULT now()` (время PostgreSQL), а воркер живёт на
  // другой машине: сравнение с `new Date()` при расхождении часов либо
  // задерживает готовые задания, либо срывает чужой лизинг раньше срока.
  const dbNow = drSql`now()`;
  const leaseCutoff = drSql`now() - make_interval(secs => ${OUTBOX_LEASE_MS / 1000})`;

  // 1) Атомарно забираем батч готовых строк и помечаем processing_at.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: jobOutbox.id,
        queue: jobOutbox.queue,
        jobName: jobOutbox.jobName,
        payload: jobOutbox.payload,
        dedupeKey: jobOutbox.dedupeKey,
        attempts: jobOutbox.attempts,
      })
      .from(jobOutbox)
      .where(
        and(
          lte(jobOutbox.nextAttemptAt, dbNow),
          isNull(jobOutbox.parkedAt),
          isNull(jobOutbox.supersededAt),
          or(isNull(jobOutbox.processingAt), lt(jobOutbox.processingAt, leaseCutoff)),
        ),
      )
      .orderBy(jobOutbox.createdAt)
      .limit(OUTBOX_BATCH)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return rows;
    await tx
      .update(jobOutbox)
      .set({ processingAt: dbNow })
      .where(
        inArray(
          jobOutbox.id,
          rows.map((r) => r.id),
        ),
      );
    return rows;
  });
  if (claimed.length === 0) return { dispatched: 0, failed: 0 };

  // 2) Вне транзакции ставим каждое задание. jobId = dedupeKey, поэтому
  //    повторная доставка той же строки дубля не создаёт.
  let dispatched = 0;
  let failed = 0;
  for (const row of claimed) {
    try {
      const queue = queues[row.queue];
      if (!queue) throw new Error(`unknown queue: ${row.queue}`);
      await queue.add(row.jobName, row.payload as never, { jobId: row.dedupeKey });
      await db.delete(jobOutbox).where(eq(jobOutbox.id, row.id));
      dispatched += 1;
    } catch (err) {
      failed += 1;
      const attempts = row.attempts + 1;
      // Исчерпав транспортный бюджет, строка остаётся как улика, но больше не
      // ездит по суточному циклу. Recovery создаст НОВОЕ поколение.
      const parked = attempts >= OUTBOX_MAX_ATTEMPTS;
      const backoffSec = parked ? 24 * 60 * 60 : Math.min(2 ** attempts, 60 * 60);
      await db
        .update(jobOutbox)
        .set({
          attempts,
          parkedAt: parked ? dbNow : null,
          // Тоже от времени БД — иначе отставшие часы воркера отодвинут
          // повтор на лишние минуты (или, наоборот, вернут строку раньше).
          nextAttemptAt: drSql`now() + make_interval(secs => ${backoffSec})`,
          lastError: err instanceof Error ? err.message : String(err),
          processingAt: null,
        })
        .where(eq(jobOutbox.id, row.id));
      log.warn(
        { err, dedupeKey: row.dedupeKey, queue: row.queue, attempts, parked },
        'job outbox dispatch failed',
      );
    }
  }
  if (dispatched || failed) log.info({ dispatched, failed }, 'job outbox batch done');
  return { dispatched, failed };
}
