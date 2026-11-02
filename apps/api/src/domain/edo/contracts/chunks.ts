/**
 * Выгрузка частями — чтобы реестр УПД на портале не отставал.
 *
 * Скачивание держит лиз учётки Диадока, а автовыгрузка УПД (раз в
 * EDO_EXPORT_INTERVAL_SEC) при занятом лизе пропускает проход. Одна выгрузка
 * на часы оставила бы окно «+ УПД из ЭДО» в приёмке без свежих документов на
 * всё это время. Поэтому выгрузка идёт частями: часть ограничена по времени,
 * после неё лиз отпущен, и следующая часть начинается только после очередного
 * завершённого прохода автовыгрузки (или по истечении ожидания). Если учётка
 * занята в момент старта части — ждём и пробуем снова.
 */
import { isRunnerSkipped, type EdoRunSkip } from '../../jobs/edo-run-skip.js';
import type { DownloadRun } from './download.js';

export type ChunkDeps = {
  /** Одна часть: лиз, выгрузка до дедлайна и не больше `limit` документов. */
  runChunk: (deadline: Date, limit: number | null) => Promise<DownloadRun | EdoRunSkip>;
  /** Ждёт завершённый проход автовыгрузки, начатый после `after`; `true` — дождались. */
  waitAutoExportPass: (after: Date, maxWaitMs: number) => Promise<boolean>;
  autoExportEnabled: boolean;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
};

export type ChunkOptions = {
  chunkMs: number;
  overallDeadline: Date;
  /** Всего документов за запуск; null — без предела. */
  limit: number | null;
  waitPassMaxMs: number;
  leaseRetryMs: number;
  leaseRetries: number;
};

export type ChunkedResult = {
  chunks: number;
  processed: number;
  requests: number;
  errors: number;
  stoppedBy: 'done' | 'limit' | 'deadline' | 'disk' | 'lease_lost' | 'lease_busy' | 'no_box' | 'not_found';
};

export async function runDownloadInChunks(deps: ChunkDeps, opts: ChunkOptions): Promise<ChunkedResult> {
  const result: ChunkedResult = { chunks: 0, processed: 0, requests: 0, errors: 0, stoppedBy: 'done' };
  const stop = (stoppedBy: ChunkedResult['stoppedBy']) => ({ ...result, stoppedBy });
  let leaseWaits = 0;

  for (;;) {
    const start = deps.now();
    if (start >= opts.overallDeadline) return stop('deadline');
    const left = opts.limit === null ? null : opts.limit - result.processed;
    if (left !== null && left <= 0) return stop('limit');

    const deadline = new Date(Math.min(start.getTime() + opts.chunkMs, opts.overallDeadline.getTime()));
    const out = await deps.runChunk(deadline, left);
    if (isRunnerSkipped(out)) {
      if (out.skipped !== 'lease_taken') return stop(out.skipped);
      leaseWaits += 1;
      if (leaseWaits > opts.leaseRetries) return stop('lease_busy');
      deps.log('Учётка занята другой работой (автовыгрузка УПД) — жду и пробую снова');
      await deps.sleep(opts.leaseRetryMs);
      continue;
    }

    leaseWaits = 0;
    result.chunks += 1;
    result.processed += out.processed;
    result.requests += out.requests;
    result.errors += out.errors;
    if (out.stoppedBy === null) return stop('done');
    if (out.stoppedBy !== 'deadline') return stop(out.stoppedBy);
    if (deps.now() >= opts.overallDeadline) return stop('deadline');

    // Часть кончилась по времени: уступить учётку автовыгрузке УПД.
    if (deps.autoExportEnabled) {
      const after = deps.now();
      const maxWait = Math.min(opts.waitPassMaxMs, opts.overallDeadline.getTime() - after.getTime());
      deps.log(`Часть ${result.chunks} готова (документов ${result.processed}). Жду проход автовыгрузки УПД…`);
      const passed = await deps.waitAutoExportPass(after, maxWait);
      deps.log(passed ? 'Автовыгрузка прошла — продолжаю.' : 'Прохода автовыгрузки не дождался — продолжаю.');
    }
  }
}
