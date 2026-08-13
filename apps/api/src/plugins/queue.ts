import fp from 'fastify-plugin';
import { Queue, type ConnectionOptions } from 'bullmq';
import { loadEnv } from '../lib/env.js';

// Очередь UPD_PARSE_QUEUE используется одной из трёх job-форм:
//  - sourceDocumentId+s3Key — старый flow УПД (1 файл = 1 source_document).
//  - bundleId — flow накладных: один пакет фото может породить N
//    source_documents (см. source_bundles, waybill-batch.parser.ts,
//    handleWaybillBundleJob в worker.ts).
//  - bundleId+mode:'router' — единый вход /upload-documents: классифицируем
//    каждый файл и роутим в существующие парсеры (handleDocumentRouterJob).
//    Дискриминатор — поле mode; у старых job его НЕТ, их ветки не меняются.
export type UpdParseJobData =
  // docKind:'m15' — одиночный документ распознаётся как накладная М-15
  // (отдельный vision-промпт, тип «Накладная»); по умолчанию (нет поля) — УПД.
  | {
      sourceDocumentId: string;
      s3Key: string;
      docKind?: 'm15';
      // pass:'vision' — ВТОРОЙ проход по тому же файлу: текстовый разбор дал
      // слабый результат или упал, и документ повторно распознаётся картинкой.
      // Отдельное задание, а не повтор внутри текущего: воркер работает с
      // concurrency=1, и удлинять им первый разбор нельзя.
      pass?: 'vision';
      bundleId?: undefined;
      mode?: undefined;
      segmentId?: undefined;
      generation?: undefined;
    }
  // Распознавание ОДНОГО логического УПД, собранного из страниц пакета.
  // s3Key нет намеренно: страницы сегмента лежат в разных файлах, их адреса
  // хранит манифест bundle_segments — он же единственный источник истины при
  // повторе задания.
  | {
      sourceDocumentId: string;
      segmentId: string;
      /** Поколение сборки корневого пакета — fencing против устаревших заданий. */
      generation: number;
      s3Key?: undefined;
      bundleId?: undefined;
      mode?: undefined;
    }
  | {
      bundleId: string;
      mode?: undefined;
      sourceDocumentId?: undefined;
      s3Key?: undefined;
      segmentId?: undefined;
      generation?: undefined;
    }
  | {
      bundleId: string;
      mode: 'router';
      sourceDocumentId?: undefined;
      s3Key?: undefined;
      segmentId?: undefined;
      generation?: undefined;
    }
  // Сборка логических УПД: классификация страниц пакета и нарезка на сегменты.
  // bundleId здесь — ДОЧЕРНИЙ пакет-исполнитель; поколение и манифест живут на
  // корневом (см. resolveRootBundle).
  | {
      bundleId: string;
      mode: 'upd_assembly';
      generation: number;
      sourceDocumentId?: undefined;
      s3Key?: undefined;
      segmentId?: undefined;
    };

export type S3CleanupJobData = {
  s3Keys: string[];
};

export const UPD_PARSE_QUEUE = 'upd-parse';
export const S3_CLEANUP_QUEUE = 's3-cleanup';
export const MAIL_POLL_QUEUE = 'mail-poll';

/**
 * Опции заданий распознавания — ОДНИ на все экземпляры очереди.
 *
 * Экземпляров два: этот, в API, и «лёгкий клиент» в воркере, через который идёт
 * весь outbox. У воркерского они не задавались вовсе, а дефолтный attempts в
 * BullMQ равен нулю — то есть публичная загрузка, почта, дочерние задания
 * router'а и второй проход работали БЕЗ ретраев: одна транзиентная ошибка
 * (S3 5xx, обрыв к БД, невезучий ответ провайдера) сразу давала parse_failed.
 * Отсюда общая константа: разъехаться снова уже нельзя.
 */
export const UPD_PARSE_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
  removeOnFail: { age: 7 * 24 * 60 * 60 },
};

/** Ручной запрос «проверить ящик сейчас» из админки. */
export type MailPollJobData = { accountId: string };

declare module 'fastify' {
  interface FastifyInstance {
    queues: {
      updParse: Queue<UpdParseJobData>;
      s3Cleanup: Queue<S3CleanupJobData>;
      mailPoll: Queue<MailPollJobData>;
    };
  }
}

// BullMQ требует отдельное подключение под Queue (то же самое верно для
// Worker — см. apps/api/src/worker.ts). Использовать общий ioredis из
// плагина redis.ts напрямую нельзя: BullMQ выставляет на нём своё
// maxRetriesPerRequest=null/enableReadyCheck=false.
export function buildQueueConnection(): ConnectionOptions {
  const env = loadEnv();
  const url = env.REDIS_URL ?? 'redis://localhost:6379';
  return { url, maxRetriesPerRequest: null };
}

export default fp(async (app) => {
  const updParse = new Queue<UpdParseJobData>(UPD_PARSE_QUEUE, {
    connection: buildQueueConnection(),
    defaultJobOptions: UPD_PARSE_JOB_OPTIONS,
  });

  // Очередь для асинхронной чистки S3-объектов при удалении документов.
  // HTTP-ответ DELETE возвращается мгновенно, реальное удаление файлов
  // выполняется воркером с ретраями (см. apps/api/src/worker.ts).
  const s3Cleanup = new Queue<S3CleanupJobData>(S3_CLEANUP_QUEUE, {
    connection: buildQueueConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });

  // Опрос почтового ящика по кнопке из админки. Обслуживается ОТДЕЛЬНЫМ
  // процессом (src/mail-worker.ts): IMAP не должен конкурировать за воркер
  // распознавания, который работает с concurrency = 1.
  const mailPoll = new Queue<MailPollJobData>(MAIL_POLL_QUEUE, {
    connection: buildQueueConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 200 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });

  app.decorate('queues', { updParse, s3Cleanup, mailPoll });
  app.addHook('onClose', async () => {
    try {
      await updParse.close();
    } catch {
      /* ignore */
    }
    try {
      await s3Cleanup.close();
    } catch {
      /* ignore */
    }
    try {
      await mailPoll.close();
    } catch {
      /* ignore */
    }
  });

  app.log.info({ queues: [UPD_PARSE_QUEUE, S3_CLEANUP_QUEUE, MAIL_POLL_QUEUE] }, 'queues ready');
});
