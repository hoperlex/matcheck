/**
 * XML документа из zip-архива СБИС.
 *
 * `СБИС.ПрочитатьДокумент` отдаёт вложения архивом (справка: «данные по ссылке
 * будут содержать zip-архив»), многостраничное вложение — архивом со страницами и
 * служебным description.xml. Нужен ровно один XML документа; всё прочее —
 * сбой документа, а не догадка.
 *
 * Своё чтение вместо библиотеки: нужны три записи формата (конец каталога,
 * запись каталога, локальный заголовок) и inflate из node:zlib. Главное — пределы:
 * число записей и размер распакованного ограничены ДО и ВО ВРЕМЯ распаковки
 * (`maxOutputLength`), иначе архив в килобайт раздувается в гигабайты и кладёт
 * воркер с удержанным лизом. ZIP64, шифрование и прочие методы сжатия — отказ.
 */
import { inflateRawSync } from 'node:zlib';

export const ZIP_MAX_ENTRIES = 20;

export class ZipRejected extends Error {
  constructor(reason: string) {
    super(`архив: ${reason}`);
    this.name = 'ZipRejected';
  }
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

type Entry = {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

function findEndOfCentralDirectory(buf: Buffer): number {
  // Запись конца каталога — 22 байта плюс комментарий до 65 535 байт.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipRejected('не найден конец каталога');
}

function readEntries(buf: Buffer): Entry[] {
  const eocd = findEndOfCentralDirectory(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new ZipRejected('ZIP64 не поддерживается');
  if (count > ZIP_MAX_ENTRIES) throw new ZipRejected(`записей ${count}, больше ${ZIP_MAX_ENTRIES}`);
  const entries: Entry[] = [];
  let p = dirOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipRejected('битый каталог');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipRejected('ZIP64 не поддерживается');
    }
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, flags, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryData(buf: Buffer, e: Entry, maxBytes: number): Buffer {
  if (e.flags & 0x1) throw new ZipRejected(`«${e.name}» зашифрован`);
  if (e.uncompressedSize > maxBytes) throw new ZipRejected(`«${e.name}» больше ${maxBytes} байт`);
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL_SIG) throw new ZipRejected('битый локальный заголовок');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ZipRejected('архив обрезан');
  const raw = buf.subarray(start, end);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method !== 8) throw new ZipRejected(`метод сжатия ${e.method} не поддерживается`);
  try {
    // Предел — и на объявленный размер выше, и на фактический здесь: заголовку
    // архива верить нельзя.
    return inflateRawSync(raw, { maxOutputLength: maxBytes });
  } catch (err) {
    throw new ZipRejected(`распаковка «${e.name}»: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Служебные файлы, которые не являются документом. */
function isServiceEntry(name: string): boolean {
  const base = name.split('/').pop()!.toLowerCase();
  return name.endsWith('/') || name.startsWith('__MACOSX/') || base === 'description.xml';
}

/** Ровно один XML документа из архива; иначе — `ZipRejected` с причиной. */
export function extractSingleXml(buf: Buffer, maxBytes: number): { name: string; bytes: Buffer } {
  const xmls = readEntries(buf).filter((e) => !isServiceEntry(e.name) && e.name.toLowerCase().endsWith('.xml'));
  if (xmls.length === 0) throw new ZipRejected('в архиве нет XML документа');
  if (xmls.length > 1) throw new ZipRejected(`в архиве ${xmls.length} XML, ожидался один`);
  const entry = xmls[0]!;
  return { name: entry.name, bytes: entryData(buf, entry, maxBytes) };
}
