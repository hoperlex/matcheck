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
 * Хеш раскладки файлов по зонам формы — или null, если раскладки нет.
 *
 * Содержимое пакета не отличает УПД, положенный в зону распознавания, от того
 * же файла, брошенного в «Дополнительные документы»: хеш байтов один и тот же.
 * Без этого компонента ошибочно помеченный УПД чинить было бы нечем — повторная
 * загрузка в правильную зону возвращала бы `reused` и не делала ничего.
 *
 * null, пока все файлы `auto`: пачка без дополнительных документов обязана
 * давать ровно прежний ключ, иначе перестанут узнаваться ВСЕ ранее загруженные
 * пакеты и повтор старого комплекта создаст дубль.
 *
 * Пары сортируются: порядок файлов в форме не должен влиять, как и в
 * contentHashOf.
 */
export function processingModesHashOf(
  files: readonly { fileHash: string; processingMode: string }[],
): string | null {
  if (!files.some((f) => f.processingMode !== 'auto')) return null;
  return createHash('sha256')
    .update(
      files
        .map((f) => `${f.fileHash}:${f.processingMode}`)
        .sort()
        .join('|'),
    )
    .digest('hex');
}

/**
 * Канонический ключ идемпотентности СО SCOPE.
 *
 * Формат совпадает с backfill миграции 0074 (префикс `v1|manual|` исторический
 * и канал не обозначает). Именно scope отличает этот ключ от bundle_hash:
 * уникальность по одному лишь содержимому склеивает тот же УПД, загруженный
 * на разные объекты, и молча возвращает чужой пакет.
 *
 * `modesHash` (см. processingModesHashOf) добавляется ТОЛЬКО когда в пачке есть
 * файлы, помеченные «не распознавать»: тогда формат становится `v2`, и та же
 * пачка с другой раскладкой по зонам — законно другой пакет. Пачки без таких
 * файлов сохраняют ключ `v1` байт в байт.
 */
export function idempotencyKeyOf(scope: {
  siteId: string | null;
  direction: string;
  contractorId?: string | null;
  recipientMolId?: string | null;
  expectedDate?: string | null;
  contentHash: string;
  modesHash?: string | null;
}): string {
  const base = [
    scope.siteId ?? '',
    scope.direction,
    scope.contractorId ?? '',
    scope.recipientMolId ?? '',
    scope.expectedDate ?? '',
    scope.contentHash,
  ];
  if (!scope.modesHash) return ['v1|manual', ...base].join('|');
  return ['v2|manual', ...base, scope.modesHash].join('|');
}

/**
 * Подменяет компоненты scope в каноническом ключе пакета, сохраняя его версию.
 *
 * Пересобирать ключ из колонок нельзя: формат v2 несёт ещё и `modesHash`
 * (раскладка файлов по зонам формы), а он в source_bundles не хранится —
 * пересборка молча превратила бы v2 в v1, и повторная загрузка той же пачки
 * перестала бы узнаваться. Поэтому правим ровно те компоненты, что попросили.
 *
 * Формат (см. idempotencyKeyOf): `<ver>|manual|<site>|<dir>|<contractor>|<mol>|
 * <date>|<contentHash>[|<modesHash>]` — объект третий по счёту, дата седьмая.
 *
 * Оба поля правит ОДНА функция намеренно: менеджер может сменить объект и дату
 * одним сохранением, и два независимых пересчёта ключа наступали бы друг другу
 * на пятки — второй читал бы строку, которую первый уже переписал.
 *
 * `expectedDate` — в форме ключа, то есть 'YYYY-MM-DD' либо null (см.
 * expectedDateKeyOf). Пустая строка в компоненте — законное значение «даты
 * нет», а не пропуск.
 */
export function replaceScopeInIdempotencyKey(
  key: string,
  scope: { siteId?: string | null; expectedDate?: string | null },
): string | null {
  const parts = key.split('|');
  // Меньше базовой длины — ключ не нашего формата (ручная правка, чужой backfill).
  // Молча «чинить» его нельзя: получится ключ, которого не построит ни один
  // канал приёма.
  if (parts.length < 8) return null;
  if ('siteId' in scope) parts[2] = scope.siteId ?? '';
  if ('expectedDate' in scope) parts[6] = scope.expectedDate ?? '';
  return parts.join('|');
}

/**
 * Хеш ИДЕНТИЧНОСТИ пакета: scope + содержимое, свёрнутые в 64 символа.
 *
 * Ложится в `bundle_hash`, у которого глобальный UNIQUE. Раньше туда писали
 * чистый хеш содержимого — и тот же комплект файлов физически не мог
 * существовать в двух пакетах: загрузка на другой объект или другую дату
 * упиралась в чужую строку и получала отказ `cross_scope`. Причём отказ
 * приходил и тогда, когда документы из прежнего пакета давно удалили.
 *
 * Со scope в хеше уникальность означает то, что и должна: один и тот же
 * комплект на один и тот же объект/дату — это один пакет, на другой объект или
 * дату — другой. Сравнивать пакеты ПО СОДЕРЖИМОМУ по-прежнему можно: для этого
 * есть отдельная колонка `content_hash`.
 */
export function bundleIdentityHashOf(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
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
