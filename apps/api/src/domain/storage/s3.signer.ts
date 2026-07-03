import { AwsClient } from 'aws4fetch';
import { loadEnv } from '../../lib/env.js';

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

// Ретрай транзиентных сбоев S3. Провайдер (s3.cloud.ru) резолвится в ПУЛ IP;
// единичный «мёртвый» узел даёт ConnectTimeout, роняя операцию, хотя соседний
// узел жив (инцидент 03.07: узел .30 не отвечал, .31 работал). Повтор = новый
// fetch = новый DNS-резолв undici → шанс уйти на живой IP пула. Повторяем ТОЛЬКО
// транзиентное: брошенное сетевое исключение (ConnectTimeout/ECONNRESET/EAI_AGAIN/
// «fetch failed») и шлюзовые 502/503/504. На успехе и на прочих 4xx (включая 404)
// не повторяем — это валидный ответ, который обрабатывает вызывающий.
const S3_MAX_ATTEMPTS = 3;
const S3_RETRY_BASE_MS = 200;

function isTransientS3Status(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Оборачивает одну S3-операцию (`() => getClient().fetch(...)`) ретраем.
 * Экспортируется ради юнит-тестов: `attempt`/`sleep` инжектируются.
 */
export async function s3FetchWithRetry(
  attempt: () => Promise<Response>,
  opts: { maxAttempts?: number; baseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? S3_MAX_ATTEMPTS;
  const baseMs = opts.baseMs ?? S3_RETRY_BASE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await attempt();
      // Шлюзовой 5xx — транзиентный, повторяем; на последней попытке отдаём
      // ответ вызывающему (он бросит осмысленную «HTTP 5xx»-ошибку).
      if (isTransientS3Status(res.status) && i < maxAttempts) {
        lastErr = new Error(`S3 transient HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      lastErr = err;
      if (i >= maxAttempts) throw err;
    }
    await sleep(baseMs * Math.pow(3, i - 1)); // 200мс, 600мс, …
  }
  throw lastErr instanceof Error ? lastErr : new Error('S3 fetch failed after retries');
}

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
  const res = await s3FetchWithRetry(() => getClient().fetch(url, { method: 'GET' }));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 GET ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  const res = await s3FetchWithRetry(() =>
    getClient().fetch(url, {
      method: 'PUT',
      body,
      headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
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
  const res = await s3FetchWithRetry(() => getClient().fetch(url, { method: 'DELETE' }));
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
  const res = await s3FetchWithRetry(() => getClient().fetch(url, { method: 'HEAD' }));
  if (res.status === 404) return false;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 HEAD ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return true;
}
