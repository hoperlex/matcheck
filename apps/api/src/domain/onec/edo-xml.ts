/**
 * Сырые байты XML УПД из ЭДО для 1С — без перекодировки: подписанный оригинал
 * у операторов бывает в windows-1251, и перекодировка сломала бы и подпись, и
 * сверку sha256. Кодировка уходит в Content-Type отдельно.
 */
import type { Db } from '../../db/client.js';
import { loadEnv } from '../../lib/env.js';
import { resolveEdoMatchFile } from '../edo/edo-match-file.js';
import { detectXmlEncoding } from '../edo/upd-xml-decode.js';
import { getObject } from '../storage/s3.signer.js';

/** Срок чтения из S3 на запрос, вместе с повторами внутри getObject. */
export const EDO_XML_READ_DEADLINE_MS = 15_000;

export type EdoXmlResult =
  | { kind: 'ok'; buffer: Buffer; filename: string; charset: string }
  | { kind: 'not_found' | 'file_not_found' | 'too_large' | 'storage_failed' };

export async function readEdoXml(
  db: Db,
  deliveryId: string,
  matchId: string,
  opts: { maxBytes?: number; read?: (key: string, signal: AbortSignal) => Promise<Buffer> } = {},
): Promise<EdoXmlResult> {
  const resolved = await resolveEdoMatchFile(db, deliveryId, matchId);
  if (resolved.kind !== 'ok') return { kind: resolved.kind };
  const { file } = resolved;
  const maxBytes = opts.maxBytes ?? loadEnv().EDO_XML_MAX_BYTES;
  // Объект держится в памяти целиком — размер сверяем ДО чтения. Пустой размер
  // у реестра — аномалия, вслепую не читаем.
  if (file.sizeBytes === null || file.sizeBytes > maxBytes) return { kind: 'too_large' };

  let buffer: Buffer;
  try {
    const read = opts.read ?? ((key, signal) => getObject(key, { signal }));
    buffer = await read(file.s3Key, AbortSignal.timeout(EDO_XML_READ_DEADLINE_MS));
  } catch {
    return { kind: 'storage_failed' };
  }
  // Строка реестра могла разойтись с объектом.
  if (buffer.length > maxBytes) return { kind: 'too_large' };
  return { kind: 'ok', buffer, filename: file.filename, charset: detectXmlEncoding(buffer) };
}
