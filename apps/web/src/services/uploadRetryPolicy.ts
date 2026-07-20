// Политика ретраев фоновой отправки фото (A2). Чистые функции без зависимостей
// от api/idb — чтобы решение «повторять или блокировать» тестировалось изолированно
// и НИКОГДА не приводило к удалению локального blob (единственной копии фото).

export type UploadErrorInfo = { status?: number; code?: string; network?: boolean };

/**
 * Классифицирует ошибку отправки по коду/статусу, НЕ по одному лишь HTTP-статусу:
 *  - `retriable` — фото ещё не в S3, повтор поможет (not_in_s3, 429, 5xx, сеть,
 *    S3 PUT fail). blob сохранить, повтор с backoff;
 *  - `terminal` — повтор бесполезен (приёмка/отгрузка удалена, помечена на
 *    удаление, доступ запрещён, некорректный запрос). Пометить blocked, blob НЕ
 *    удалять;
 *  - `unknown` — 404 не про not_in_s3 (отсутствующий маршрут / рассинхрон версий
 *    фронта и API). Длинный capped backoff вместо шторма, blob сохранить.
 */
export function classifyUploadError(info: UploadErrorInfo): 'retriable' | 'terminal' | 'unknown' {
  const { status, code } = info;
  if (
    code &&
    ['delivery_not_found', 'shipment_not_found', 'pending_deletion', 'forbidden'].includes(code)
  ) {
    return 'terminal';
  }
  if (code === 'not_in_s3') return 'retriable';
  if (status === 429) return 'retriable';
  if (status != null && status >= 500) return 'retriable';
  if (status === 404) return 'unknown';
  if (status != null && status >= 400) return 'terminal';
  return 'retriable'; // сеть / нет статуса (в т.ч. проваленный S3 PUT)
}

/** Извлекает {status, code} из ApiError-подобного объекта duck-typing'ом (без импорта ApiError). */
export function toErrorInfo(err: unknown): UploadErrorInfo {
  if (err && typeof err === 'object' && 'status' in err && 'code' in err) {
    const e = err as { status?: unknown; code?: unknown };
    return {
      status: typeof e.status === 'number' ? e.status : undefined,
      code: typeof e.code === 'string' ? e.code : undefined,
    };
  }
  return { network: true };
}

const BASE_MS = 30_000;
const CAP_RETRIABLE_MS = 30 * 60_000; // 30 мин
const CAP_UNKNOWN_MS = 6 * 3600_000; // 6 ч — неизвестный 404 не должен штормить

/** Экспоненциальный capped backoff. Для `unknown` потолок выше. */
export function backoffMs(attempts: number, cls: 'retriable' | 'unknown'): number {
  const cap = cls === 'unknown' ? CAP_UNKNOWN_MS : CAP_RETRIABLE_MS;
  const exp = BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(cap, exp);
}
