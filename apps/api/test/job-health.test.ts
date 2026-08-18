import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client.js';
import {
  classifyBullJob,
  inspectWorkHealth,
  RECOGNITION_JOB_MAX_RUNTIME_MS,
} from '../src/domain/jobs/job-health.js';

const job = (state: string, times: { processedOn?: number; timestamp?: number } = {}) => ({
  getState: vi.fn().mockResolvedValue(state),
  ...times,
});

function dbWithOutbox(row?: { attempts: number; parkedAt: Date | null }): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (row ? [row] : []) }),
      }),
    }),
  } as unknown as Db;
}

describe('recognition work health', () => {
  it.each(['waiting', 'delayed', 'prioritized', 'waiting-children'])(
    `%s считается живым`,
    async (state) => {
      await expect(classifyBullJob(job(state))).resolves.toEqual({
        state: 'alive',
        queueState: state,
      });
    },
  );

  it('active в пределах дедлайна жив, после дедлайна overdue', async () => {
    const now = 10_000_000;
    await expect(
      classifyBullJob(job('active', { processedOn: now - RECOGNITION_JOB_MAX_RUNTIME_MS }), {
        nowMs: now,
      }),
    ).resolves.toEqual({ state: 'alive', queueState: 'active' });
    await expect(
      classifyBullJob(job('active', { processedOn: now - RECOGNITION_JOB_MAX_RUNTIME_MS - 1 }), {
        nowMs: now,
      }),
    ).resolves.toEqual({
      state: 'overdue',
      activeForMs: RECOGNITION_JOB_MAX_RUNTIME_MS + 1,
    });
  });

  it("литерал 'unknown' от BullMQ — это unknown, а не alive", async () => {
    // BullMQ 5 отдаёт 'unknown', когда job существует, но ни в одном известном
    // множестве не числится. Правило «всё, кроме терминальных, живо» отнесло бы
    // это к alive — и зависший документ никогда не был бы восстановлен.
    await expect(classifyBullJob(job('unknown'))).resolves.toMatchObject({
      state: 'unknown',
    });
  });

  it("'unknown' не путается с просроченным active", async () => {
    // Возраст у unknown не считается: у такого job нет достоверного
    // processedOn, и вывести из него overdue значило бы переставить работу по
    // выдуманному сроку.
    const now = 10_000_000;
    await expect(
      classifyBullJob(job('unknown', { processedOn: now - 10 * 60 * 60 * 1000 }), { nowMs: now }),
    ).resolves.toMatchObject({ state: 'unknown' });
  });

  it.each(['completed', 'failed'])(`%s считается терминальным`, async (state) => {
    await expect(classifyBullJob(job(state))).resolves.toEqual({
      state: 'terminal',
      queueState: state,
    });
  });

  it('pending outbox остаётся alive_transport при недоступном Redis', async () => {
    const queue = { getJob: vi.fn().mockRejectedValue(new Error('redis down')) };
    await expect(
      inspectWorkHealth({
        db: dbWithOutbox({ attempts: 2, parkedAt: null }),
        queue,
        jobId: 'doc~1',
      }),
    ).resolves.toEqual({ state: 'alive_transport', outboxAttempts: 2 });
  });

  it('parked не маскирует отказ Redis и без BullMQ job становится stranded', async () => {
    const db = dbWithOutbox({ attempts: 12, parkedAt: new Date() });
    await expect(
      inspectWorkHealth({
        db,
        queue: { getJob: vi.fn().mockRejectedValue(new Error('redis down')) },
        jobId: 'doc~1',
      }),
    ).resolves.toMatchObject({ state: 'unknown' });
    await expect(
      inspectWorkHealth({
        db,
        queue: { getJob: vi.fn().mockResolvedValue(null) },
        jobId: 'doc~1',
      }),
    ).resolves.toEqual({ state: 'stranded', outboxAttempts: 12 });
  });

  it('отсутствие и в outbox, и в BullMQ классифицируется missing', async () => {
    await expect(
      inspectWorkHealth({
        db: dbWithOutbox(),
        queue: { getJob: vi.fn().mockResolvedValue(null) },
        jobId: 'doc~1',
      }),
    ).resolves.toEqual({ state: 'missing' });
  });
});
