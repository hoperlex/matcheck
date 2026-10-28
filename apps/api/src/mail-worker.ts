/**
 * Отдельный процесс опроса внешних источников документов: почтовых ящиков и
 * учётных записей ЭДО (Контур.Диадок).
 *
 * Имя файла и контейнера историческое — оно зашито в деплой, и переименование
 * стоит дороже, чем строчка пояснения. Опрос Диадока живёт здесь, а не в
 * matcheck-worker, по той же причине, что и почта (см. ниже), и не в отдельном
 * контейнере: это несколько HTTP-запросов и небольшой XML раз в несколько
 * минут, а память на сервере общая с соседними проектами.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api mail-worker    — tsx src/mail-worker.ts
 *
 * Почему отдельный процесс, а не задача в matcheck-worker: тот работает с
 * concurrency = 1 и занят распознаванием PDF по несколько минут. IMAP-сессия,
 * скачивание писем и разбор MIME встали бы в ту же очередь и задерживали
 * распознавание — а тяжёлая работа в общем воркере уже однажды тормозила API
 * и справочники.
 *
 * ДВЕ независимые защиты от случайного включения:
 *   1. MAIL_POLL_ENABLED — без него процесс живёт, но сам не опрашивает ничего;
 *   2. mail_accounts.poll_enabled — опрашивается только явно включённый ящик.
 * Плюс контейнера нет в списке деплоя, пока его туда не добавят.
 *
 * Вся логика обхода — в domain/jobs/mail-poll-runner.ts; здесь только запуск.
 */
import './instrument.js'; // ПЕРВЫМ — Sentry.init до bullmq/postgres/undici
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { Queue, Worker, type Job } from 'bullmq';
import { simpleParser } from 'mailparser';
import { db } from './db/client.js';
import {
  pollAccountById,
  pollAllAccounts,
  type RunnerDeps,
} from './domain/jobs/mail-poll-runner.js';
import { DEFAULT_FETCH_LIMITS } from './domain/mail/imap.fetch.js';
import { openMailbox } from './domain/mail/imap.connect.js';
import { installFatalHandlers } from './lib/fatal-visibility.js';
import { purgeOldMail, purgeOldReceipts } from './domain/mail/retention.js';
import { copyObject, putObject } from './domain/storage/s3.signer.js';
import { loadEnv } from './lib/env.js';
import { logger } from './lib/logger.js';
import {
  buildQueueConnection,
  EDO_EXPORT_AUTO_JOB_ID,
  EDO_POLL_QUEUE,
  ESTIMAT_SYNC_AUTO_JOB_ID,
  ESTIMAT_SYNC_JOB_OPTIONS,
  ESTIMAT_SYNC_QUEUE,
  MAIL_POLL_QUEUE,
  SBIS_EXPORT_AUTO_JOB_ID,
  SBIS_EXPORT_QUEUE,
  type EdoPollJobData,
  type EstimatSyncJobData,
  type MailPollJobData,
  type SbisExportJobData,
} from './plugins/queue.js';
import { describeTokenForLog, readEstimatConfig } from './domain/estimat/config.js';
import { runEstimatSync, type EstimatSyncReport } from './domain/estimat/supplier-orders-sync.js';
import { runExportForAllAccounts } from './domain/jobs/edo-export-runner.js';
import {
  runSbisExportForAllAccounts,
  runSbisExportPass,
  SBIS_CONFIRM_DELAY_MS,
  type SbisAutoReport,
  type SbisExportDeps,
} from './domain/jobs/sbis-export-runner.js';
import {
  pollAllEdoAccounts,
  pollEdoAccountById,
  runEdoInventory,
  type EdoRunnerDeps,
} from './domain/jobs/edo-poll-runner.js';
import { checkEdoAccess } from './domain/edo/check-access.js';
import { edoAccounts } from './db/schema.js';
import { eq } from 'drizzle-orm';

// Падение процесса обязано оставлять след в логе и в Sentry — см.
// lib/fatal-visibility.ts (инцидент 21.08: 854 немых рестарта API).
installFatalHandlers('mail-worker');

const env = loadEnv();
const log = logger.child({ service: 'mail-worker' });

/** UUID экземпляра — попадает в лиз, по нему видно, кто держит ящик. */
const WORKER_ID = randomUUID();

const deps: RunnerDeps = {
  db,
  putObject,
  parseMime: (raw) => simpleParser(raw),
  openMailbox,
  // Нужен для автосоздания пакета: staging → постоянные ключи.
  copyObject,
  log,
  onError: (err) => Sentry.captureException(err, { tags: { service: 'mail-worker' } }),
};

const pollOptions = {
  owner: WORKER_ID,
  leaseTtlSeconds: env.MAIL_POLL_LEASE_SEC,
  maxMessages: env.MAIL_POLL_MAX_MESSAGES,
  fetchLimits: { ...DEFAULT_FETCH_LIMITS, maxLetterBytes: env.MAIL_LETTER_MAX_BYTES },
};

// Ручной запуск из админки: «проверить ящик сейчас». Работает и при выключенном
// автоопросе — этим проверяют доступы до включения.
const worker = new Worker<MailPollJobData>(
  MAIL_POLL_QUEUE,
  async (job: Job<MailPollJobData>) => {
    await pollAccountById(deps, job.data.accountId, { ...pollOptions, manual: true });
  },
  { connection: buildQueueConnection(), concurrency: 1 },
);

worker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'ручной опрос ящика упал');
  Sentry.captureException(err, { tags: { queue: MAIL_POLL_QUEUE } });
});

// ── ЭДО: ручные работы из админки ──────────────────────────────────────────
//
// Отдельная очередь, а не общая с почтой: у них разные защиты (MAIL_POLL_ENABLED
// против EDO_POLL_ENABLED) и разные последствия у сбоя. concurrency = 1 здесь
// обязателен по другой причине, чем у почты: под работой обменивается
// refresh_token, и два параллельных обмена оставили бы один из них с токеном,
// который сервер уже отозвал.
const edoLog = logger.child({ service: 'edo-worker' });
const edoDeps: EdoRunnerDeps = { db, log: edoLog, owner: WORKER_ID };

/**
 * Остановка процесса прерывает выгрузку между запросами к Диадоку: проход
 * записывается как `stopped`, лиз освобождается, а не висит до истечения.
 */
const edoShutdown = new AbortController();

/** Автопроход выгрузки реестра УПД по всем учёткам — см. domain/jobs/edo-export-runner.ts. */
async function runEdoExportAuto(): Promise<void> {
  await runExportForAllAccounts(
    { ...edoDeps, put: putObject, signal: edoShutdown.signal },
    { maxEvents: env.EDO_EXPORT_MAX_EVENTS, maxDownloads: env.EDO_EXPORT_MAX_DOWNLOADS },
    {
      onError: (accountId, result) =>
        Sentry.captureException(result.cause ?? new Error(result.error ?? 'выгрузка реестра ЭДО'), {
          tags: { service: 'edo-export', account: accountId },
          // Одна и та же причина каждые полчаса — одно событие, а не поток.
          fingerprint: [
            'edo-export',
            result.cursorMismatch ? 'cursor-mismatch' : result.cause instanceof Error ? result.cause.name : 'unknown',
          ],
        }),
      onStuck: (accountId) =>
        Sentry.captureMessage('Выгрузка реестра ЭДО три прохода подряд не сдвинула курсор', {
          level: 'warning',
          tags: { service: 'edo-export', account: accountId },
          fingerprint: ['edo-export', 'stuck', accountId],
        }),
      onCrash: (accountId, err) =>
        Sentry.captureException(err, {
          tags: { service: 'edo-export', account: accountId },
          fingerprint: ['edo-export', 'crash', err instanceof Error ? err.name : 'unknown'],
        }),
    },
  );
}

const edoWorker = new Worker<EdoPollJobData>(
  EDO_POLL_QUEUE,
  async (job: Job<EdoPollJobData>) => {
    if (job.data.mode === 'export') {
      await runEdoExportAuto();
      return;
    }
    const { accountId, mode } = job.data;
    if (mode === 'inventory') {
      const outcome = await runEdoInventory(edoDeps, accountId, job.data.since, {
        checkContent: job.data.checkContent === true,
      });
      edoLog.info({ accountId, outcome }, 'разведка ящика завершена');
      return;
    }
    if (mode === 'check') {
      const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId)).limit(1);
      if (!row) return;
      const result = await checkEdoAccess(db, row, edoLog);
      edoLog.info({ accountId, ok: !('error' in result) }, 'проверка доступа завершена');
      return;
    }
    // mode === 'sync' — ручной проход по ленте.
    const result = await pollEdoAccountById(edoDeps, accountId);
    edoLog.info({ accountId, ...result }, 'синхронизация ЭДО завершена');
  },
  { connection: buildQueueConnection(), concurrency: 1 },
);

edoWorker.on('failed', (job, err) => {
  edoLog.error({ jobId: job?.id, err: err.message }, 'ручная работа по ЭДО упала');
  Sentry.captureException(err, { tags: { queue: EDO_POLL_QUEUE } });
});

// Автоопрос ЭДО. Две независимые защиты, как у почты: переменная окружения и
// колонка poll_enabled у самой учётной записи.
let edoTimer: NodeJS.Timeout | null = null;
if (env.EDO_POLL_ENABLED) {
  const sweepEdo = () =>
    void pollAllEdoAccounts(edoDeps).catch((err) => edoLog.error({ err }, 'обход ЭДО упал'));
  // Сдвиг относительно почтового прохода: два обхода не должны стартовать
  // одновременно и делить память контейнера на пике.
  setTimeout(() => {
    sweepEdo();
    edoTimer = setInterval(sweepEdo, env.EDO_POLL_INTERVAL_SEC * 1000);
    edoTimer.unref();
  }, 40_000).unref();
  edoLog.info({ intervalSec: env.EDO_POLL_INTERVAL_SEC }, 'автоопрос ЭДО включён');
} else {
  edoLog.info('автоопрос ЭДО выключен (EDO_POLL_ENABLED=0); доступен только ручной запуск');
}

// Автообновление реестра УПД из ЭДО. Таймер работу не делает — только ставит
// задачу в очередь ЭДО: её выполняет тот же edoWorker, по очереди с ручными
// осмотром и проверкой доступа, поэтому они не отнимают друг у друга учётку.
// Постоянный jobId: пока задача в очереди или идёт, вторая не ставится.
// Проход дешёвый: лента читается с курсора, то есть только новое за интервал.
let edoExportTimer: NodeJS.Timeout | null = null;
let edoExportQueue: Queue<EdoPollJobData> | null = null;
if (env.EDO_EXPORT_AUTO_ENABLED) {
  const queue = new Queue<EdoPollJobData>(EDO_POLL_QUEUE, { connection: buildQueueConnection() });
  edoExportQueue = queue;
  const enqueue = () =>
    void queue
      .add(
        'export',
        { mode: 'export' },
        { jobId: EDO_EXPORT_AUTO_JOB_ID, attempts: 1, removeOnComplete: true, removeOnFail: true },
      )
      .catch((err) => edoLog.error({ err }, 'не удалось поставить выгрузку реестра ЭДО'));
  // Минута после старта: деплой перезапускает контейнеры, пусть поднимутся.
  setTimeout(() => {
    enqueue();
    edoExportTimer = setInterval(enqueue, env.EDO_EXPORT_INTERVAL_SEC * 1000);
    edoExportTimer.unref();
  }, 60_000).unref();
  edoLog.info({ intervalSec: env.EDO_EXPORT_INTERVAL_SEC }, 'автообновление реестра ЭДО включено');
} else {
  edoLog.info('автообновление реестра ЭДО выключено (EDO_EXPORT_AUTO_ENABLED=0)');
}

// Выгрузка реестра УПД из СБИС — своя очередь и свой воркер (concurrency 1).
// Таймер ставит проход по всем учёткам СБИС; пустая страница ленты ставит
// подтверждающий проход учётки через 2 минуты (справка СБИС: выждать и повторить
// тот же запрос). Выключатель EDO_SBIS_ENABLED: при 0 ни таймера, ни воркера —
// оставшиеся в очереди задачи не выполнятся.
let sbisExportTimer: NodeJS.Timeout | null = null;
let sbisExportQueue: Queue<SbisExportJobData> | null = null;
let sbisWorker: Worker<SbisExportJobData> | null = null;
if (env.EDO_SBIS_ENABLED) {
  const sbisLog = logger.child({ service: 'sbis-export' });
  const queue = new Queue<SbisExportJobData>(SBIS_EXPORT_QUEUE, { connection: buildQueueConnection() });
  sbisExportQueue = queue;
  const sbisDeps: SbisExportDeps = {
    db,
    log: sbisLog,
    owner: WORKER_ID,
    put: putObject,
    signal: edoShutdown.signal,
    scheduleConfirm: async (accountId) => {
      await queue.add(
        'confirm',
        { mode: 'confirm', accountId },
        {
          delay: SBIS_CONFIRM_DELAY_MS,
          jobId: `sbis-confirm-${accountId}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    },
  };
  const limits = { maxEvents: env.EDO_EXPORT_MAX_EVENTS, maxDownloads: env.EDO_EXPORT_MAX_DOWNLOADS };
  const report: SbisAutoReport = {
    onError: (accountId, result) =>
      Sentry.captureException(result.cause ?? new Error(result.error ?? 'выгрузка СБИС'), {
        tags: { service: 'sbis-export', account: accountId },
        fingerprint: [
          'sbis-export',
          result.cursorMismatch ? 'cursor-mismatch' : result.cause instanceof Error ? result.cause.name : 'unknown',
        ],
      }),
    onCrash: (accountId, err) =>
      Sentry.captureException(err, {
        tags: { service: 'sbis-export', account: accountId },
        fingerprint: ['sbis-export', 'crash', err instanceof Error ? err.name : 'unknown'],
      }),
  };
  sbisWorker = new Worker<SbisExportJobData>(
    SBIS_EXPORT_QUEUE,
    async (job: Job<SbisExportJobData>) => {
      if (job.data.mode === 'auto') {
        await runSbisExportForAllAccounts(sbisDeps, limits, report);
        return;
      }
      // Подтверждение пустой страницы — обычный проход учётки: любой проход
      // начинает с незакрытого подтверждения.
      const result = await runSbisExportPass(sbisDeps, job.data.accountId, { trigger: 'auto', ...limits });
      if (!('skipped' in result) && result.outcome === 'error') report.onError(job.data.accountId, result);
    },
    { connection: buildQueueConnection(), concurrency: 1 },
  );
  sbisWorker.on('failed', (job, err) => {
    sbisLog.error({ jobId: job?.id, err: err.message }, 'выгрузка СБИС упала');
    Sentry.captureException(err, { tags: { queue: SBIS_EXPORT_QUEUE } });
  });
  const enqueue = () =>
    void queue
      .add('auto', { mode: 'auto' }, { jobId: SBIS_EXPORT_AUTO_JOB_ID, attempts: 1, removeOnComplete: true, removeOnFail: true })
      .catch((err) => sbisLog.error({ err }, 'не удалось поставить выгрузку СБИС'));
  // Полторы минуты после старта — со сдвигом от прохода Диадока.
  setTimeout(() => {
    enqueue();
    sbisExportTimer = setInterval(enqueue, env.EDO_EXPORT_INTERVAL_SEC * 1000);
    sbisExportTimer.unref();
  }, 90_000).unref();
  sbisLog.info({ intervalSec: env.EDO_EXPORT_INTERVAL_SEC }, 'выгрузка реестра из СБИС включена');
} else {
  edoLog.info('выгрузка реестра из СБИС выключена (EDO_SBIS_ENABLED=0)');
}

// Заказы поставщикам из EstiMat — полный обход по расписанию и по кнопке
// «Обновить» (POST /api/v1/estimat/sync ставит задачу в эту же очередь). Своя
// очередь и воркер с concurrency 1; при выключенном флаге или неверном токене —
// ни таймера, ни воркера, и маршрут кнопки отвечает «обработчик не запущен».
let estimatTimer: NodeJS.Timeout | null = null;
let estimatQueue: Queue<EstimatSyncJobData> | null = null;
let estimatWorker: Worker<EstimatSyncJobData> | null = null;
{
  const estimatLog = logger.child({ service: 'estimat-sync' });
  // Только длина и состояние — значение токена в лог не попадает никогда.
  estimatLog.info(describeTokenForLog(env));
  const estimatConfig = readEstimatConfig(env);
  if (env.ESTIMAT_SYNC_ENABLED && estimatConfig.ok) {
    const queue = new Queue<EstimatSyncJobData>(ESTIMAT_SYNC_QUEUE, {
      connection: buildQueueConnection(),
      defaultJobOptions: ESTIMAT_SYNC_JOB_OPTIONS,
    });
    estimatQueue = queue;
    const report: EstimatSyncReport = {
      onError: (result) =>
        Sentry.captureException(result.cause ?? new Error(result.errorMessage ?? 'обход EstiMat'), {
          level: 'error',
          tags: { service: 'estimat-sync', code: result.errorCode ?? 'unknown' },
          extra: { requestId: result.requestId, runId: result.runId },
          // Одна причина каждые полчаса — одно событие, а не поток.
          fingerprint: ['estimat-sync', result.errorCode ?? 'unknown'],
        }),
      onWarning: (code, message, extra) =>
        Sentry.captureMessage(message, {
          level: 'warning',
          tags: { service: 'estimat-sync', code },
          extra,
          fingerprint: ['estimat-sync', 'warning', code],
        }),
    };
    estimatWorker = new Worker<EstimatSyncJobData>(
      ESTIMAT_SYNC_QUEUE,
      async (job: Job<EstimatSyncJobData>) => {
        const result = await runEstimatSync(
          { db, log: estimatLog, config: estimatConfig, signal: edoShutdown.signal, report },
          { trigger: job.data.trigger, userId: job.data.userId ?? null },
        );
        if ('skipped' in result) estimatLog.info({ trigger: job.data.trigger, ...result }, 'обход EstiMat пропущен');
      },
      { connection: buildQueueConnection(), concurrency: 1 },
    );
    estimatWorker.on('failed', (job, err) => {
      estimatLog.error({ jobId: job?.id, err: err.message }, 'обход EstiMat упал');
      Sentry.captureException(err, { tags: { queue: ESTIMAT_SYNC_QUEUE } });
    });
    const enqueue = () =>
      void queue
        .add(
          'auto',
          { trigger: 'auto', requestId: randomUUID() },
          { ...ESTIMAT_SYNC_JOB_OPTIONS, jobId: ESTIMAT_SYNC_AUTO_JOB_ID },
        )
        .catch((err) => estimatLog.error({ err }, 'не удалось поставить обход EstiMat'));
    // Две минуты после старта — со сдвигом от проходов ЭДО и СБИС.
    setTimeout(() => {
      enqueue();
      estimatTimer = setInterval(enqueue, env.ESTIMAT_SYNC_INTERVAL_SEC * 1000);
      estimatTimer.unref();
    }, 120_000).unref();
    estimatLog.info({ intervalSec: env.ESTIMAT_SYNC_INTERVAL_SEC }, 'синхронизация заказов EstiMat включена');
  } else {
    estimatLog.info(
      { reason: estimatConfig.ok ? 'ESTIMAT_SYNC_ENABLED=0' : estimatConfig.reason },
      'синхронизация заказов EstiMat выключена',
    );
  }
}

let timer: NodeJS.Timeout | null = null;
if (env.MAIL_POLL_ENABLED) {
  const sweep = () =>
    void pollAllAccounts(deps, pollOptions).catch((err) =>
      log.error({ err }, 'обход ящиков упал'),
    );
  // Сдвиг от старта: даём процессу подняться и не бьём в IMAP одновременно с
  // перезапуском остальных контейнеров при деплое.
  setTimeout(() => {
    sweep();
    timer = setInterval(sweep, env.MAIL_POLL_INTERVAL_SEC * 1000);
    timer.unref();
  }, 20_000).unref();
  log.info({ intervalSec: env.MAIL_POLL_INTERVAL_SEC }, 'автоопрос включён');
} else {
  log.info('автоопрос выключен (MAIL_POLL_ENABLED=false); доступен только ручной запуск');
}

// Уборка старых писем. По умолчанию ВЫКЛЮЧЕНА (MAIL_RETENTION_DAYS=0): оригинал
// письма — доказательство того, что и когда прислал подрядчик, и удалять его
// автоматически нужно только по осознанному решению. Письма лежат в объектном
// хранилище, диск сервера не занимают.
//
// Если включена — раз в сутки от старта: срок измеряется днями, чаще смысла
// нет. Файлы удаляются не здесь: их ключи уходят в очередь s3_cleanup_outbox,
// которую разбирает основной воркер с ретраями.
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
let retentionTimer: NodeJS.Timeout | null = null;
if (env.MAIL_RETENTION_DAYS > 0) {
  const sweep = async () => {
    const purged = await purgeOldMail({ db, retentionDays: env.MAIL_RETENTION_DAYS, log });
    const receipts = await purgeOldReceipts({ db, retentionDays: env.MAIL_RETENTION_DAYS, log });
    if (purged.messages || receipts) {
      log.info({ ...purged, receipts }, 'уборка почты завершена');
    }
  };
  // Через 5 минут после старта: не мешаем первому проходу поллера.
  setTimeout(() => {
    void sweep().catch((err) => log.error({ err }, 'уборка почты упала'));
    retentionTimer = setInterval(
      () => void sweep().catch((err) => log.error({ err }, 'уборка почты упала')),
      RETENTION_INTERVAL_MS,
    );
    retentionTimer.unref();
  }, 5 * 60 * 1000).unref();
  log.info({ retentionDays: env.MAIL_RETENTION_DAYS }, 'уборка почты включена');
} else {
  log.info('уборка почты выключена (MAIL_RETENTION_DAYS=0) — письма хранятся бессрочно');
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'mail-worker: завершение');
  if (timer) clearInterval(timer);
  if (edoTimer) clearInterval(edoTimer);
  if (edoExportTimer) clearInterval(edoExportTimer);
  if (sbisExportTimer) clearInterval(sbisExportTimer);
  if (estimatTimer) clearInterval(estimatTimer);
  if (retentionTimer) clearInterval(retentionTimer);
  // Сначала прервать выгрузку: close() ждёт активную задачу, а проход без
  // сигнала мог бы идти минутами и быть убит SIGKILL'ом с висящим лизом.
  edoShutdown.abort();
  await worker.close().catch(() => undefined);
  await edoWorker.close().catch(() => undefined);
  await sbisWorker?.close().catch(() => undefined);
  // Обход получил сигнал abort выше и закрывает свою строку как stopped — ждём,
  // иначе process.exit обогнал бы запись и строка осталась бы running.
  await estimatWorker?.close().catch(() => undefined);
  await estimatQueue?.close().catch(() => undefined);
  await edoExportQueue?.close().catch(() => undefined);
  await sbisExportQueue?.close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ workerId: WORKER_ID }, 'mail-worker запущен');
