/**
 * Выгрузка частями — чтобы реестр УПД на портале не отставал.
 *
 * Скачивание держит лиз учётки Диадока, а автовыгрузка УПД (раз в
 * EDO_EXPORT_INTERVAL_SEC) при занятом лизе пропускает проход. Одна выгрузка
 * на часы оставила бы окно «+ УПД из ЭДО» в приёмке без свежих документов на
 * всё это время. Поэтому выгрузка идёт частями, и между ними — шлюз:
 *
 *   - перед первой частью ждём проход автовыгрузки, чтобы часть начиналась
 *     сразу после него, а не в случайной точке между проходами;
 *   - после каждой части лиз отпущен, и следующая начинается только после
 *     очередного завершённого прохода. Не дождались — остановка: значит, с
 *     автовыгрузкой что-то не так, и продолжать, отнимая у неё учётку, нельзя.
 *
 * Часть ограничена по времени и короче интервала автовыгрузки, а граница
 * действует и внутри документа (download.ts). Поэтому за часть пропускается не
 * больше одного прохода, а два подряд невозможны.
 *
 * Если учётка занята в момент старта части — ждём и пробуем снова.
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
  /** Ждать проход автовыгрузки и перед первой частью. */
  waitBeforeFirst: boolean;
  waitPassMaxMs: number;
  leaseRetryMs: number;
  leaseRetries: number;
};

export type ChunkedResult = {
  chunks: number;
  processed: number;
  requests: number;
  errors: number;
  stoppedBy:
    | 'done'
    | 'limit'
    | 'deadline'
    | 'disk'
    | 'lease_lost'
    | 'lease_busy'
    | 'no_box'
    | 'not_found'
    | 'auto_export_missing'
    | 'diadoc_unavailable';
  /** Текст отказа Диадока при `diadoc_unavailable`. */
  stopReason?: string;
};

export async function runDownloadInChunks(deps: ChunkDeps, opts: ChunkOptions): Promise<ChunkedResult> {
  const result: ChunkedResult = { chunks: 0, processed: 0, requests: 0, errors: 0, stoppedBy: 'done' };
  const stop = (stoppedBy: ChunkedResult['stoppedBy'], stopReason?: string) => ({
    ...result,
    stoppedBy,
    ...(stopReason ? { stopReason } : {}),
  });
  let leaseWaits = 0;

  /** Шлюз: дождаться прохода. `null` — дождались, иначе причина остановки. */
  const gate = async (what: string): Promise<ChunkedResult['stoppedBy'] | null> => {
    if (!deps.autoExportEnabled) return null;
    const after = deps.now();
    const left = opts.overallDeadline.getTime() - after.getTime();
    const maxWait = Math.min(opts.waitPassMaxMs, left);
    deps.log(`${what} Жду проход автовыгрузки УПД…`);
    if (await deps.waitAutoExportPass(after, maxWait)) {
      deps.log('Автовыгрузка прошла — продолжаю.');
      return null;
    }
    // Ожидание урезано общим пределом времени — это конец запуска, а не сбой автовыгрузки.
    if (maxWait < opts.waitPassMaxMs) return 'deadline';
    deps.log('Автовыгрузка УПД не прошла за отведённое время — скачивание остановлено.');
    return 'auto_export_missing';
  };

  if (opts.waitBeforeFirst) {
    const stopped = await gate('Перед первой частью.');
    if (stopped) return stop(stopped);
  }

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
    if (out.stoppedBy !== 'deadline') return stop(out.stoppedBy, out.stopReason);
    if (deps.now() >= opts.overallDeadline) return stop('deadline');

    // Часть кончилась по времени: уступить учётку автовыгрузке УПД.
    const stopped = await gate(`Часть ${result.chunks} готова (документов ${result.processed}).`);
    if (stopped) return stop(stopped);
  }
}
