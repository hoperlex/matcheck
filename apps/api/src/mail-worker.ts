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
import { Worker, type Job } from 'bullmq';
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
  EDO_POLL_QUEUE,
  MAIL_POLL_QUEUE,
  type EdoPollJobData,
  type MailPollJobData,
} from './plugins/queue.js';
import {
  pollAllEdoAccounts,
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

const edoWorker = new Worker<EdoPollJobData>(
  EDO_POLL_QUEUE,
  async (job: Job<EdoPollJobData>) => {
    const { accountId, mode } = job.data;
    if (mode === 'inventory') {
      const outcome = await runEdoInventory(edoDeps, accountId, job.data.since);
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
    // mode === 'sync': сам проход по ленте появится вместе с журналом событий.
    edoLog.info({ accountId }, 'синхронизация ЭДО поставлена в очередь');
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
  if (retentionTimer) clearInterval(retentionTimer);
  await worker.close().catch(() => undefined);
  await edoWorker.close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ workerId: WORKER_ID }, 'mail-worker запущен');
