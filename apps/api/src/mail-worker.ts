/**
 * Отдельный процесс опроса почтовых ящиков.
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
import { copyObject, putObject } from './domain/storage/s3.signer.js';
import { loadEnv } from './lib/env.js';
import { logger } from './lib/logger.js';
import { buildQueueConnection, MAIL_POLL_QUEUE, type MailPollJobData } from './plugins/queue.js';

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

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'mail-worker: завершение');
  if (timer) clearInterval(timer);
  await worker.close().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ workerId: WORKER_ID }, 'mail-worker запущен');
