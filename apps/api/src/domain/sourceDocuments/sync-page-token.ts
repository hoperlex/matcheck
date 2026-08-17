/**
 * Keyset-пагинация документов в /sync.
 *
 * Что было сломано. Клиент, получив полную страницу, заменял свой курсор на
 * серверный `cursor` (момент начала выборки) и шёл за следующей порцией уже с
 * НИМ. Но записи страницы отсортированы по `updated_at DESC`, и всё, что старше
 * последней отданной строки, оказывалось старше нового курсора — во вторую
 * страницу такие записи не попадали никогда. Хвост дельты просто исчезал;
 * reconcile потом вытягивал часть обратно, но не атомарно и не весь.
 *
 * Как устроено теперь.
 *
 *   1. Первая страница фиксирует `snapshotCursor` — момент, на который делается
 *      вся выборка. Все последующие страницы идут по НЕМУ же, поэтому записи,
 *      изменившиеся во время листания, в текущий проход не попадают и не сдвигают
 *      границы страниц.
 *   2. Позиция внутри снимка — пара `(updatedAt, id)`, а не смещение. Пара, а не
 *      один updated_at: у пачки, разобранной одним заданием, время совпадает до
 *      миллисекунды, и по одному полю строки перескакивали бы.
 *   3. Основной курсор клиент двигает ТОЛЬКО после последней применённой
 *      страницы. Обрыв на середине означает повтор с того же места, а не потерю
 *      хвоста.
 *
 * Токен непрозрачен для клиента: base64url от JSON. Так его нельзя «починить»
 * руками на планшете, и формат можно менять, не ломая контракт.
 */

export type SyncPageToken = {
  /** Момент, на который сделан снимок. ISO-8601. */
  snapshot: string;
  /** Позиция: updated_at последней отданной строки. ISO-8601. */
  updatedAt: string;
  /** Позиция: id последней отданной строки — тай-брейк при равном updated_at. */
  id: string;
};

export function encodePageToken(token: SyncPageToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

/**
 * Разбор токена. Невалидный токен — это НЕ ошибка запроса: клиент мог сохранить
 * его от прошлой версии сервера или повредить при записи. Отдаём null, и
 * листание начинается сначала — лишний трафик, но целостность не страдает.
 */
export function decodePageToken(raw: string | undefined | null): SyncPageToken | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as SyncPageToken).snapshot !== 'string' ||
      typeof (parsed as SyncPageToken).updatedAt !== 'string' ||
      typeof (parsed as SyncPageToken).id !== 'string'
    ) {
      return null;
    }
    const token = parsed as SyncPageToken;
    if (Number.isNaN(Date.parse(token.snapshot)) || Number.isNaN(Date.parse(token.updatedAt))) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/**
 * Обрезает страницу так, чтобы машина не оказалась разрезанной границей.
 *
 * Инспектор принимает машину целиком, и половина её документов на планшете — это
 * либо неполный состав материалов, либо вечное «состав изменился» на форме.
 * Поэтому если последняя строка страницы принадлежит группе, у которой есть
 * продолжение, вся эта группа переносится на следующую страницу.
 *
 * Хвостовой случай: страница целиком занята одной группой. Резать её некуда, и
 * лимит превышается осознанно — целостность важнее ровного размера страницы.
 * Такое возможно только при машине больше страницы (сотни документов в одном
 * пакете), чего в реальных пачках не бывает.
 */
export function trimPageToGroupBoundary<T extends { id: string; groupId: string | null }>(
  rows: T[],
  limit: number,
): { page: T[]; hasMore: boolean } {
  if (rows.length <= limit) return { page: rows, hasMore: false };

  const page = rows.slice(0, limit);
  const nextRow = rows[limit];
  const lastGroup = page[page.length - 1]?.groupId ?? null;

  // Граница проходит внутри группы — отрезаем её хвост.
  if (lastGroup && nextRow?.groupId === lastGroup) {
    const trimmed = page.filter((r) => r.groupId !== lastGroup);
    // Вся страница — одна группа: резать нечего, отдаём как есть.
    if (trimmed.length === 0) return { page, hasMore: true };
    return { page: trimmed, hasMore: true };
  }

  return { page, hasMore: true };
}
