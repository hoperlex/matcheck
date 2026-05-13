import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { loadEnv } from '../../lib/env.js';

export type EncryptedEnvelope = {
  alg: 'AES-256-GCM';
  iv: string;
  tag: string;
  ct: string;
  v: string;
};

const ENV = loadEnv();

let cachedKeys: Map<string, Buffer> | null = null;
let cachedActive: string | null = null;

function loadKeys(): { keys: Map<string, Buffer>; active: string } {
  if (cachedKeys && cachedActive) return { keys: cachedKeys, active: cachedActive };
  const parsed = JSON.parse(ENV.APP_FIELD_ENCRYPTION_KEYS) as Record<string, string>;
  const keys = new Map<string, Buffer>();
  for (const [version, b64] of Object.entries(parsed)) {
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) {
      throw new Error(`Encryption key ${version} must be 32 bytes (got ${key.length})`);
    }
    keys.set(version, key);
  }
  const active = ENV.APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION;
  if (!keys.has(active)) {
    throw new Error(`Active encryption key version ${active} is not in keyset`);
  }
  cachedKeys = keys;
  cachedActive = active;
  return { keys, active };
}

export function encryptField(plaintext: string, aad: string): EncryptedEnvelope {
  const { keys, active } = loadKeys();
  const key = keys.get(active)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    v: active,
  };
}

export function decryptField(envelopeJson: string, aad: string): string {
  const { keys } = loadKeys();
  const env = JSON.parse(envelopeJson) as EncryptedEnvelope;
  const key = keys.get(env.v);
  if (!key) throw new Error(`Unknown encryption key version ${env.v}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

export function encryptToString(plaintext: string, aad: string): string {
  return JSON.stringify(encryptField(plaintext, aad));
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function buildAad(table: string, rowId: string): string {
  return `kind:${table}:id:${rowId}`;
}
