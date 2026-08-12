import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  createHmac,
} from 'node:crypto';
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

// ─── Refresh: детерминированный вывод токена-замены ───────────────────────
//
// Зачем. При ротации refresh сервер отзывает старый токен и выдаёт новый. Если
// ответ до клиента не дошёл (оборванный по таймауту fetch, потерянный
// Set-Cookie, второй параллельный запрос), клиент повторяет запрос со СТАРЫМ
// токеном — и упирается в reuse-detection, которая трактует это как кражу и
// убивает всю сессию. Чтобы ответить на такой повтор идемпотентно, сервер
// должен уметь выдать ТОТ ЖЕ токен-замену повторно. Взять его из БД нельзя:
// там лежит только sha256-хеш (refresh_tokens.token_hash). Значит замену надо
// уметь вывести заново.
//
// Из чего выводим. Ключ вывода — ТОЛЬКО серверный: подключ из keyring
// APP_FIELD_ENCRYPTION_KEYS. Материал сообщения — предъявленный родительский
// токен и id будущей строки-замены.
//
// Почему ключ обязателен и почему replacementId в модель секретности НЕ входит:
// это первичный ключ строки, он попадает в дампы, диагностику и логи. Если бы
// стойкость держалась на нём, вор, укравший родительский токен и подсмотревший
// UUID, вычислил бы действующего потомка и обошёл reuse-detection вовсе. С
// серверным ключом кража родительского токена не даёт ничего: ни внутри
// grace-окна, ни после него. Дамп БД без ключа — тоже.
//
// Стойкость наследуется от keyring: на production дефолтный (нулевой) keyring
// недопустим — он публично известен, и вывод замены перестал бы быть секретом.
// То же ограничение уже действует для field-encryption.
const REPLACEMENT_KEY_INFO = 'matcheck:refresh-replacement-key:v1';
const REPLACEMENT_TOKEN_DOMAIN = 'matcheck:refresh-replacement:v1';

// Подключ выводится отдельно (domain separation), а не берётся из keyring
// напрямую: один и тот же байтовый ключ не должен работать сразу и как
// AES-256-GCM-ключ шифрования полей, и как HMAC-ключ выпуска токенов.
const cachedReplacementKeys = new Map<string, Buffer>();

function replacementKey(version: string): Buffer {
  const memo = cachedReplacementKeys.get(version);
  if (memo) return memo;
  const { keys } = loadKeys();
  const key = keys.get(version);
  if (!key) throw new Error(`Unknown encryption key version ${version}`);
  const derived = createHmac('sha256', key).update(REPLACEMENT_KEY_INFO).digest();
  cachedReplacementKeys.set(version, derived);
  return derived;
}

/**
 * Версии keyring: активная первой. При replay кандидат-токен проверяется по
 * каждой (их единицы, HMAC дешёв) — так ротация ключа не обрывает живые
 * сессии, выпущенные на прежней версии, и не требует колонки в refresh_tokens.
 *
 * ВАЖНО при ротации ключа: старую версию нельзя удалять из
 * APP_FIELD_ENCRYPTION_KEYS, пока живы цепочки, выпущенные на ней. Замену из
 * такой цепочки станет нечем вывести, повтор перестанет обслуживаться, и
 * потерянный ответ снова обернётся разлогином. Безопасный срок хранения старой
 * версии — не меньше REFRESH_TOKEN_TTL_DAYS.
 */
export function replacementKeyVersions(): string[] {
  const { keys, active } = loadKeys();
  return [active, ...[...keys.keys()].filter((v) => v !== active)];
}

/**
 * Токен-замена для ротации: HMAC(подключ; домен ‖ родительский токен ‖ id замены).
 * Вызывается дважды за жизнь токена — при выпуске и при идемпотентном повторе,
 * оба раза даёт один и тот же результат. Разделитель \0 между частями делает
 * конкатенацию однозначной (ни base64url-токен, ни UUID нулевого байта не содержат).
 */
export function deriveReplacementToken(
  parentToken: string,
  replacementId: string,
  keyVersion?: string,
): string {
  const version = keyVersion ?? loadKeys().active;
  return createHmac('sha256', replacementKey(version))
    .update(REPLACEMENT_TOKEN_DOMAIN)
    .update('\0')
    .update(parentToken)
    .update('\0')
    .update(replacementId)
    .digest('base64url');
}
