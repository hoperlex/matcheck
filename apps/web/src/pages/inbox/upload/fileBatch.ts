/**
 * Добавление ПАЧКИ файлов в зону загрузки — чистой функцией, без React.
 *
 * Почему отдельным модулем, а не внутри компонента: antd вызывает
 * `beforeUpload` синхронно на КАЖДЫЙ файл выбранной пачки, и обработчик,
 * написанный «по одному файлу», видит состояние на момент рендера. Из трёх
 * выбранных файлов в списке оставался последний, а предупреждение «файл уже в
 * другой зоне» показывалось столько раз, сколько файлов в пачке.
 *
 * Здесь вся пачка обрабатывается разом: считается один итог и один список
 * отказов. Компоненту остаётся положить `next` в state и показать одно
 * сообщение.
 */

export type FileRow = { uid: string; file: File };

/**
 * Клиентские лимиты зоны. Все поля необязательны: у публичной формы лимиты
 * жёсткие (сервер откажет), у внутренней модалки клиентских лимитов нет —
 * ограничение только серверное, и добавлять его здесь не нужно.
 *
 * Лимиты считаются по ОБЕИМ зонам сразу: файлы уезжают одним запросом, и
 * сервер меряет запрос целиком. Проверка «по своей зоне» разошлась бы с
 * серверной — одна зона прошла бы, а вместе они дали бы 413.
 */
export type FileLimits = {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

export type RejectReason =
  | 'duplicate_other_zone'
  | 'duplicate_in_batch'
  | 'too_many'
  | 'file_too_large'
  | 'total_too_large';

export type RejectedFile = { name: string; reason: RejectReason };

export type AddFileBatchResult = { next: FileRow[]; rejected: RejectedFile[] };

/** Идентичность файла для человека: то же имя и тот же размер — тот же файл. */
function fileKey(f: File): string {
  return `${f.name}:${f.size}`;
}

let uidSeq = 0;
function defaultUid(file: File): string {
  uidSeq += 1;
  return `${file.name}-${file.size}-${uidSeq}`;
}

export function addFileBatch(args: {
  prev: readonly FileRow[];
  /** Соседняя зона той же формы — один файл не должен попасть в обе. */
  otherZone: readonly FileRow[];
  files: readonly File[];
  limits?: FileLimits;
  /** Только для тестов: детерминированный uid вместо счётчика. */
  makeUid?: (file: File, index: number) => string;
}): AddFileBatchResult {
  const { prev, otherZone, files, limits = {}, makeUid } = args;

  const otherKeys = new Set(otherZone.map((r) => fileKey(r.file)));
  const batchKeys = new Set<string>();
  const next = [...prev];
  const rejected: RejectedFile[] = [];

  let count = prev.length + otherZone.length;
  let totalBytes =
    prev.reduce((s, r) => s + r.file.size, 0) + otherZone.reduce((s, r) => s + r.file.size, 0);

  files.forEach((file, index) => {
    const key = fileKey(file);

    if (otherKeys.has(key)) {
      rejected.push({ name: file.name, reason: 'duplicate_other_zone' });
      return;
    }
    // Один и тот же файл дважды внутри одной пачки — это перетаскивание
    // пересекающихся выборок, а не намерение загрузить дубль.
    if (batchKeys.has(key)) {
      rejected.push({ name: file.name, reason: 'duplicate_in_batch' });
      return;
    }
    if (limits.maxFileBytes !== undefined && file.size > limits.maxFileBytes) {
      rejected.push({ name: file.name, reason: 'file_too_large' });
      return;
    }
    if (limits.maxFiles !== undefined && count + 1 > limits.maxFiles) {
      rejected.push({ name: file.name, reason: 'too_many' });
      return;
    }
    if (limits.maxTotalBytes !== undefined && totalBytes + file.size > limits.maxTotalBytes) {
      rejected.push({ name: file.name, reason: 'total_too_large' });
      return;
    }

    batchKeys.add(key);
    next.push({ uid: makeUid ? makeUid(file, index) : defaultUid(file), file });
    count += 1;
    totalBytes += file.size;
  });

  return { next, rejected };
}

/**
 * Одно сообщение на всю пачку вместо N всплывающих подсказок.
 * null — отказов не было.
 */
export function rejectionMessage(rejected: readonly RejectedFile[]): string | null {
  if (rejected.length === 0) return null;

  if (rejected.length === 1) {
    const only = rejected[0]!;
    return `Файл «${only.name}» не добавлен: ${reasonText(only.reason)}`;
  }

  // Причин может быть несколько сразу (часть — дубли, часть — лимит), поэтому
  // перечисляем их, а не берём первую.
  const uniqueReasons = Array.from(new Set(rejected.map((r) => r.reason)));
  const reasons = uniqueReasons.map(reasonText).join('; ');
  return `Не добавлено файлов: ${rejected.length} — ${reasons}`;
}

function reasonText(reason: RejectReason): string {
  switch (reason) {
    case 'duplicate_other_zone':
      return 'уже добавлен в другую зону';
    case 'duplicate_in_batch':
      return 'выбран дважды';
    case 'too_many':
      return 'превышено число файлов в поставке';
    case 'file_too_large':
      return 'файл слишком большой';
    case 'total_too_large':
      return 'превышен суммарный объём поставки';
  }
}
