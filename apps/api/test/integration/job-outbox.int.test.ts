/**
 * Job outbox в изоляции: на таблицу ещё никто не пишет, writers переводятся
 * отдельным этапом — поэтому consumer проверяется здесь, ДО переключения.
 *
 * Проверяется ровно то, ради чего outbox вводится: задание не теряется при
 * недоступности Redis, ретрай той же попытки не плодит дублей, а намеренный
 * повтор (новое поколение) реально запускается.
 *
 * Запуск: см. заголовок test/integration/mail-requests.int.test.ts.
 * Без TEST_DATABASE_URL набор пропускается.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql as drSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { jobOutbox } from '../../src/db/schema.js';
import {
  enqueueJob,
  processJobOutbox,
  OUTBOX_LEASE_MS,
  type JobQueue,
} from '../../src/domain/jobs/job-outbox.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const QUEUE = 'upd-parse';

suite('job outbox — consumer в изоляции (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let db: Db;
  let add: ReturnType<typeof vi.fn>;
  let queues: Record<string, JobQueue>;
  const log = { info: () => {}, warn: () => {} };

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, { max: 4 });
    db = drizzle(sql) as unknown as Db;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM job_outbox`;
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql`DELETE FROM job_outbox`;
    add = vi.fn().mockResolvedValue({ id: 'job' });
    queues = { [QUEUE]: { add } as unknown as JobQueue };
  });

  const dispatchId = (bundleId: string, generation: number) =>
    `bundle:${bundleId}:parse:${generation}`;

  async function put(dedupeKey: string, payload: Record<string, unknown>) {
    await enqueueJob(db, { queue: QUEUE, jobName: 'parse', payload, dedupeKey });
  }

  it('строка доезжает до очереди, jobId = dispatch ID, строка убирается', async () => {
    const bundleId = randomUUID();
    const key = dispatchId(bundleId, 1);
    await put(key, { bundleId, mode: 'router' });

    const result = await processJobOutbox({ db, queues, log });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(add).toHaveBeenCalledWith('parse', { bundleId, mode: 'router' }, { jobId: key });
    const left = await db.select().from(jobOutbox);
    expect(left).toHaveLength(0);
  });

  it('повторная запись того же dispatch ID даёт одну строку и один job', async () => {
    const bundleId = randomUUID();
    const key = dispatchId(bundleId, 1);
    await put(key, { bundleId, mode: 'router' });
    // Ретрай той же попытки — например, повторный вызов writer'а после
    // сетевого сбоя. Это НЕ новый запуск.
    await put(key, { bundleId, mode: 'router' });

    const rows = await db.select().from(jobOutbox);
    expect(rows).toHaveLength(1);

    await processJobOutbox({ db, queues, log });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('разные поколения одного пакета — два независимых job', async () => {
    const bundleId = randomUUID();
    await put(dispatchId(bundleId, 1), { bundleId, mode: 'router' });
    await put(dispatchId(bundleId, 2), { bundleId, mode: 'router' });

    const result = await processJobOutbox({ db, queues, log });

    expect(result).toEqual({ dispatched: 2, failed: 0 });
    // Намеренный повтор обязан получить СВОЙ jobId, иначе BullMQ молча
    // отбросит его как уже завершённый (removeOnComplete держит сутки).
    const jobIds = add.mock.calls.map((c) => (c[2] as { jobId: string }).jobId);
    expect(new Set(jobIds).size).toBe(2);
  });

  it('Redis недоступен → строка ждёт и уезжает после возврата', async () => {
    const bundleId = randomUUID();
    const key = dispatchId(bundleId, 1);
    await put(key, { bundleId, mode: 'router' });

    add.mockRejectedValueOnce(new Error('Redis connection lost'));
    const first = await processJobOutbox({ db, queues, log });
    expect(first).toEqual({ dispatched: 0, failed: 1 });

    // Задание НЕ потеряно: строка на месте, лизинг снят, попытка учтена.
    const [row] = await db.select().from(jobOutbox).where(eq(jobOutbox.dedupeKey, key));
    expect(row).toMatchObject({ attempts: 1, processingAt: null });
    expect(row!.lastError).toContain('Redis');
    // Сравниваем в терминах БД: часы процесса и PostgreSQL могут расходиться.
    const [{ pending }] = await db
      .select({ pending: drSql<boolean>`${jobOutbox.nextAttemptAt} > now()` })
      .from(jobOutbox)
      .where(eq(jobOutbox.dedupeKey, key));
    expect(pending).toBe(true);

    // Redis вернулся, backoff истёк. Время двигаем в БД, а не в процессе:
    // consumer намеренно опирается только на now() PostgreSQL.
    await db
      .update(jobOutbox)
      .set({ nextAttemptAt: drSql`now() - interval '1 second'` })
      .where(eq(jobOutbox.dedupeKey, key));
    const second = await processJobOutbox({ db, queues, log });
    expect(second).toEqual({ dispatched: 1, failed: 0 });
    expect(await db.select().from(jobOutbox)).toHaveLength(0);
  });

  it('зависшая после краха воркера строка возвращается в работу по лизу', async () => {
    const bundleId = randomUUID();
    const key = dispatchId(bundleId, 1);
    await put(key, { bundleId, mode: 'router' });
    // Воркер забрал строку и умер, не сняв processing_at.
    await db
      .update(jobOutbox)
      .set({ processingAt: drSql`now() - make_interval(secs => ${OUTBOX_LEASE_MS / 1000 + 60})` })
      .where(eq(jobOutbox.dedupeKey, key));

    const result = await processJobOutbox({ db, queues, log });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
  });

  it('свежий лизинг чужого воркера не трогаем', async () => {
    const bundleId = randomUUID();
    const key = dispatchId(bundleId, 1);
    await put(key, { bundleId, mode: 'router' });
    await db
      .update(jobOutbox)
      .set({ processingAt: drSql`now()` })
      .where(eq(jobOutbox.dedupeKey, key));

    const result = await processJobOutbox({ db, queues, log });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    expect(add).not.toHaveBeenCalled();
  });

  it('неизвестная очередь не теряет задание, а откладывает его', async () => {
    const bundleId = randomUUID();
    await enqueueJob(db, {
      queue: 'no-such-queue',
      jobName: 'parse',
      payload: { bundleId },
      dedupeKey: dispatchId(bundleId, 1),
    });

    const result = await processJobOutbox({ db, queues, log });

    expect(result).toEqual({ dispatched: 0, failed: 1 });
    const [row] = await db.select().from(jobOutbox);
    expect(row).toMatchObject({ attempts: 1, processingAt: null });
    expect(row!.lastError).toContain('unknown queue');
  });
});
