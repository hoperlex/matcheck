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
