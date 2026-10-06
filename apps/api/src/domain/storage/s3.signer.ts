import { AwsClient } from 'aws4fetch';
import { loadEnv } from '../../lib/env.js';
import { s3FetchWithRetry } from './s3.retry.js';

const env = loadEnv();

let client: AwsClient | null = null;

function getClient(): AwsClient {
  if (client) return client;
  if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    throw new Error('S3 credentials are not configured (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)');
  }
  client = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    region: env.S3_REGION,
    service: 's3',
  });
  return client;
}

function endpoint(): string {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET) {
    throw new Error('S3_ENDPOINT and S3_BUCKET must be configured');
  }
  return env.S3_ENDPOINT.replace(/\/$/, '');
}

// Ретрай транзиентных сбоев S3 живёт в s3.retry.ts (там же — почему он не
// гарантирует другой узел пула). Реэкспорт — для старых импортов отсюда.
export { s3FetchWithRetry };

const S3_ATTEMPT_TIMEOUT_MS = 60_000;

export type SignOptions = {
  method: 'PUT' | 'GET' | 'DELETE';
  key: string;
  expiresIn: number;
  contentType?: string;
};

export async function presign({
  method,
  key,
  expiresIn,
  contentType,
}: SignOptions): Promise<string> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  url.searchParams.set('X-Amz-Expires', String(expiresIn));
  const req = new Request(url, {
    method,
    ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
  });
  const signed = await getClient().sign(req, { aws: { signQuery: true } });
  return signed.url;
}

export async function getObject(key: string): Promise<Buffer> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  const res = await s3FetchWithRetry(() =>
    getClient().fetch(url, { method: 'GET', signal: AbortSignal.timeout(S3_ATTEMPT_TIMEOUT_MS) }),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 GET ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Кладёт объект в хранилище.
 *
 * @param metadata пользовательские метаданные объекта — уезжают заголовками
 *   `x-amz-meta-<имя>`. Нужны, чтобы хеш содержимого хранился РЯДОМ С ФАЙЛОМ, а
 *   не только в нашей БД: строка реестра говорит, что мы приняли, метаданные
 *   объекта — что на самом деле лежит в бакете. Без этого сверка «в S3 именно
 *   то, что прислали» упирается в скачивание файла целиком.
 *
 *   Имена ключей — только латиница, цифры и дефис: значение заголовка обязано
 *   быть ASCII, а имя участвует в подписи запроса.
 */
export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
  metadata?: Record<string, string>,
): Promise<void> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(body.length),
  };
  for (const [name, value] of Object.entries(metadata ?? {})) {
    headers[`x-amz-meta-${name}`] = value;
  }
  const res = await s3FetchWithRetry(() =>
    getClient().fetch(url, {
      method: 'PUT',
      body,
      headers,
      signal: AbortSignal.timeout(S3_ATTEMPT_TIMEOUT_MS),
    }),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function copyObject(srcKey: string, dstKey: string): Promise<void> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${dstKey}`);
  const res = await s3FetchWithRetry(() =>
    getClient().fetch(url, {
      method: 'PUT',
      headers: { 'x-amz-copy-source': `/${env.S3_BUCKET}/${encodeURI(srcKey)}` },
      signal: AbortSignal.timeout(S3_ATTEMPT_TIMEOUT_MS),
    }),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `S3 COPY ${srcKey} → ${dstKey} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }
}

export async function deleteObject(key: string): Promise<void> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  const res = await s3FetchWithRetry(() =>
    getClient().fetch(url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(S3_ATTEMPT_TIMEOUT_MS),
    }),
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 DELETE ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

// Проверка существования объекта в S3 без скачивания тела. Используется в
// confirm-эндпоинте фото и в orphan-cleanup-job. true = объект есть; false =
// 404; throw — сетевая/permission-ошибка (caller решает что делать).
export async function headObject(key: string): Promise<boolean> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  const res = await s3FetchWithRetry(() =>
    getClient().fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(S3_ATTEMPT_TIMEOUT_MS) }),
  );
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 HEAD ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return true;
}
