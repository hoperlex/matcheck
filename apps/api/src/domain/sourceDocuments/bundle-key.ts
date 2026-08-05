// Канонические ключи пакета документов.
//
// Живут отдельно от каналов приёма (почта, кнопка менеджера, публичная
// страница поставщика), потому что формат обязан совпадать у всех: один и тот
// же комплект файлов на один и тот же объект — это ОДИН пакет, каким бы путём
// он ни пришёл. Раньше эти функции лежали в domain/mail, и третий канал
// вынужден был бы импортировать почтовый модуль ради хеша.

import { createHash } from 'node:crypto';

/**
 * Хеш содержимого пакета: sha256 от отсортированных sha256 файлов через `|`.
 *
 * Сортировка делает результат независимым от порядка файлов в форме — иначе
 * та же пачка, перетащенная в другом порядке, считалась бы новой.
 */
export function contentHashOf(fileHashes: readonly string[]): string {
  return createHash('sha256').update([...fileHashes].sort().join('|')).digest('hex');
}

/** sha256 одного файла — вход для contentHashOf. */
export function fileHashOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Канонический ключ идемпотентности СО SCOPE.
 *
 * Формат совпадает с backfill миграции 0074 (префикс `v1|manual|` исторический
 * и канал не обозначает). Именно scope отличает этот ключ от bundle_hash:
 * уникальность по одному лишь содержимому склеивает тот же УПД, загруженный
 * на разные объекты, и молча возвращает чужой пакет.
 */
export function idempotencyKeyOf(scope: {
  siteId: string | null;
  direction: string;
  contractorId?: string | null;
  recipientMolId?: string | null;
  expectedDate?: string | null;
  contentHash: string;
}): string {
  return [
    'v1|manual',
    scope.siteId ?? '',
    scope.direction,
    scope.contractorId ?? '',
    scope.recipientMolId ?? '',
    scope.expectedDate ?? '',
    scope.contentHash,
  ].join('|');
}

/**
 * Имя файла, пригодное для S3-ключа и для показа.
 *
 * Слеши вырезаются (иначе имя расщепит ключ на «папки»), длина ограничена
 * хвостом в 100 символов — расширение важнее начала имени.
 */
export function safeName(filename: string | null, idx: number): string {
  const base = (filename ?? '').replace(/[/\\]/g, '_').trim().slice(-100);
  return base || `file-${idx + 1}.bin`;
}

/** Дата поставки в форме, пригодной для ключа: 'YYYY-MM-DD' либо null. */
export function expectedDateKeyOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}
