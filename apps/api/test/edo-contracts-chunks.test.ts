/**
 * Выгрузка частями: между частями учётка отдаётся автовыгрузке УПД, чтобы
 * реестр на портале не отставал; занятая учётка — ожидание, а не отказ.
 */
import { describe, expect, it } from 'vitest';
import { runDownloadInChunks, type ChunkDeps } from '../src/domain/edo/contracts/chunks.js';
import type { DownloadRun } from '../src/domain/edo/contracts/download.js';

const MIN = 60_000;

function harness(outcomes: (DownloadRun | { skipped: 'lease_taken' | 'no_box' | 'not_found' })[], opts: { autoExport?: boolean; chunkMs?: number } = {}) {
  let clock = Date.UTC(2026, 10, 2, 18, 0);
  const calls: string[] = [];
  const chunkArgs: { deadline: number; limit: number | null }[] = [];
  const deps: ChunkDeps = {
    runChunk: async (deadline, limit) => {
      chunkArgs.push({ deadline: deadline.getTime() - clock, limit });
      calls.push('chunk');
      const out = outcomes.shift();
      if (!out) throw new Error('лишняя часть');
      if (!('skipped' in out)) clock += out.stoppedBy === 'deadline' ? (opts.chunkMs ?? 25 * MIN) : MIN;
      return out;
    },
    waitAutoExportPass: async (_after, maxWaitMs) => {
      calls.push(`wait ${maxWaitMs / MIN}`);
      clock += 10 * MIN;
      return true;
    },
    autoExportEnabled: opts.autoExport ?? true,
    now: () => new Date(clock),
    sleep: async (ms) => {
      calls.push(`sleep ${ms / MIN}`);
      clock += ms;
    },
    log: () => {},
  };
  const run = (overrides: Partial<Parameters<typeof runDownloadInChunks>[1]> = {}) =>
    runDownloadInChunks(deps, {
      chunkMs: opts.chunkMs ?? 25 * MIN,
      overallDeadline: new Date(clock + 480 * MIN),
      limit: null,
      waitPassMaxMs: 35 * MIN,
      leaseRetryMs: MIN,
      leaseRetries: 3,
      ...overrides,
    });
  return { run, calls, chunkArgs };
}

const part = (processed: number, stoppedBy: DownloadRun['stoppedBy']): DownloadRun => ({
  selected: 100,
  processed,
  stoppedBy,
  errors: 0,
  requests: processed * 4,
});

describe('выгрузка частями', () => {
  it('между частями ждёт проход автовыгрузки УПД, заканчивает, когда всё обработано', async () => {
    const h = harness([part(40, 'deadline'), part(40, 'deadline'), part(20, null)]);
    const result = await h.run();
    expect(result).toMatchObject({ stoppedBy: 'done', chunks: 3, processed: 100, requests: 400 });
    expect(h.calls).toEqual(['chunk', 'wait 35', 'chunk', 'wait 35', 'chunk']);
    // Каждая часть ограничена 25 минутами.
    expect(h.chunkArgs.every((c) => c.deadline === 25 * MIN)).toBe(true);
  });

  it('автовыгрузка выключена — части идут подряд без ожидания', async () => {
    const h = harness([part(40, 'deadline'), part(10, null)], { autoExport: false });
    expect(await h.run()).toMatchObject({ stoppedBy: 'done', chunks: 2 });
    expect(h.calls).toEqual(['chunk', 'chunk']);
  });

  it('учётка занята при старте части — ждёт минуту и пробует снова', async () => {
    const h = harness([{ skipped: 'lease_taken' }, { skipped: 'lease_taken' }, part(5, null)]);
    expect(await h.run()).toMatchObject({ stoppedBy: 'done', processed: 5 });
    expect(h.calls).toEqual(['chunk', 'sleep 1', 'chunk', 'sleep 1', 'chunk']);
  });

  it('учётка занята слишком долго — остановка «занята», а не бесконечное ожидание', async () => {
    const h = harness(Array.from({ length: 4 }, () => ({ skipped: 'lease_taken' as const })));
    expect(await h.run()).toMatchObject({ stoppedBy: 'lease_busy', chunks: 0 });
  });

  it('--limit делится между частями и останавливает выгрузку', async () => {
    const h = harness([part(3, 'deadline'), part(2, 'limit')]);
    expect(await h.run({ limit: 5 })).toMatchObject({ stoppedBy: 'limit', processed: 5 });
    expect(h.chunkArgs.map((c) => c.limit)).toEqual([5, 2]);
  });

  it('мало места или потеря лиза — остановка сразу, без следующей части', async () => {
    expect(await harness([part(7, 'disk')]).run()).toMatchObject({ stoppedBy: 'disk', processed: 7 });
    expect(await harness([part(1, 'lease_lost')]).run()).toMatchObject({ stoppedBy: 'lease_lost' });
    expect(await harness([{ skipped: 'not_found' }]).run()).toMatchObject({ stoppedBy: 'not_found' });
  });

  it('общий предел времени: последняя часть не длиннее остатка, ожидание не выходит за предел', async () => {
    const h = harness([part(40, 'deadline'), part(10, 'deadline')], { chunkMs: 25 * MIN });
    const result = await h.run({ overallDeadline: new Date(Date.UTC(2026, 10, 2, 18, 0) + 40 * MIN) });
    expect(result.stoppedBy).toBe('deadline');
    // 25 мин часть → ожидание ограничено остатком 15 мин → вторая часть — оставшиеся 5 мин.
    expect(h.calls).toEqual(['chunk', 'wait 15', 'chunk']);
    expect(h.chunkArgs[1]!.deadline).toBe(5 * MIN);
  });
});
