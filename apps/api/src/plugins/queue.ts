import fp from 'fastify-plugin';
import { Queue, type ConnectionOptions } from 'bullmq';
import { loadEnv } from '../lib/env.js';

// Очередь UPD_PARSE_QUEUE используется одной из двух job-форм:
//  - sourceDocumentId+s3Key — старый flow УПД (1 файл = 1 source_document).
//  - bundleId — новый flow накладных: один пакет фото может породить N
//    source_documents (см. source_bundles, waybill-batch.parser.ts,
//    handleWaybillBundleJob в worker.ts).
export type UpdParseJobData =
  | { sourceDocumentId: string; s3Key: string; bundleId?: undefined }
  | { bundleId: string; sourceDocumentId?: undefined; s3Key?: undefined };

export type S3CleanupJobData = {
  s3Keys: string[];
};

export const UPD_PARSE_QUEUE = 'upd-parse';
export const S3_CLEANUP_QUEUE = 's3-cleanup';

declare module 'fastify' {
  interface FastifyInstance {
    queues: {
      updParse: Queue<UpdParseJobData>;
      s3Cleanup: Queue<S3CleanupJobData>;
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
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
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

  app.decorate('queues', { updParse, s3Cleanup });
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
  });

  app.log.info({ queues: [UPD_PARSE_QUEUE, S3_CLEANUP_QUEUE] }, 'queues ready');
});
