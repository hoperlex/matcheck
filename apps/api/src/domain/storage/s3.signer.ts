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

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  const res = await getClient().fetch(url, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 PUT ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}

export async function copyObject(srcKey: string, dstKey: string): Promise<void> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${dstKey}`);
  const res = await getClient().fetch(url, {
    method: 'PUT',
    headers: { 'x-amz-copy-source': `/${env.S3_BUCKET}/${encodeURI(srcKey)}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `S3 COPY ${srcKey} → ${dstKey} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
    );
  }
}

export async function deleteObject(key: string): Promise<void> {
  const url = new URL(`${endpoint()}/${env.S3_BUCKET}/${key}`);
  const res = await getClient().fetch(url, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 DELETE ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
}
