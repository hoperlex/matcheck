/**
 * Разбор клиентского `confirmedByMolAt` — момента, когда инспектор фактически
 * завершил операцию на планшете.
 *
 * История бага: раньше сервер ставил это время сам (`new Date()` в момент
 * приёма мутации). Пока планшет синхронизировался за секунды, серверное время
 * почти совпадало с фактическим и дефект был незаметен. 04.08 на ЖК АЛИЯ
 * очередь мутаций простояла 5 ч 15 мин, прорвалась разом — и сервер проставил
 * четырём приёмкам подряд одно и то же время 05:23. Инспектор справедливо
 * сказал, что это неправда. За 30 дней такие «слипшиеся» подтверждения нашлись
 * 16 раз на 10 объектах, у приёмок и отгрузок.
 *
 * Теперь время присылает планшет — как он уже давно присылает `arrivedAt`.
 * Но доверять ему вслепую нельзя: часы на устройстве может увести
 * пользователь, а строка приходит из внешнего мира. Отсюда клампы ниже.
 *
 * Чистая функция, без побочных эффектов (кроме опционального лога).
 * Тестируется без БД.
 */

/**
 * Допуск на будущее. Часы планшета и сервера расходятся на секунды-минуты
 * даже при исправном NTP, поэтому небольшое «будущее» — норма, а не аномалия.
 */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface ConfirmedAtLogger {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ResolveConfirmedAtParams {
  /** Что прислал клиент. Отсутствует у старых сборок (до 1.0.33). */
  raw?: string | null;
  /**
   * Нижняя граница — `arrivedAt` у приёмки, `shippedAt` у отгрузки.
   * Подтверждение не может быть раньше самой операции.
   */
  lowerBound?: Date | string | null;
  /** Точка отсчёта. Параметром — чтобы тест не зависел от системных часов. */
  now?: Date;
  log?: ConfirmedAtLogger;
  entity: 'delivery' | 'shipment';
  id?: string | null;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Возвращает время подтверждения, которое безопасно писать в БД.
 *
 * Порядок разбора:
 *  - поля нет или строка не парсится → `now` (так ведут себя старые клиенты);
 *  - позже `now + 5 мин` → `now` (часы устройства убежали вперёд);
 *  - раньше [lowerBound] → `lowerBound` (подтверждение не бывает до операции);
 *  - нижняя граница сама выше верхней → `now` + предупреждение в лог: у
 *    планшета сломаны часы, и обе границы бессмысленны.
 */
export function resolveConfirmedAt(params: ResolveConfirmedAtParams): Date {
  const now = params.now ?? new Date();
  const upperBound = new Date(now.getTime() + FUTURE_TOLERANCE_MS);
  const lowerBound = toDate(params.lowerBound);

  if (lowerBound && lowerBound.getTime() > upperBound.getTime()) {
    params.log?.warn?.(
      {
        entity: params.entity,
        id: params.id ?? null,
        raw: params.raw ?? null,
        lowerBound: lowerBound.toISOString(),
        now: now.toISOString(),
      },
      'confirmed-at: нижняя граница выше верхней (часы устройства уехали) — ставим серверное время',
    );
    return now;
  }

  let result = toDate(params.raw) ?? now;
  if (result.getTime() > upperBound.getTime()) result = now;
  if (lowerBound && result.getTime() < lowerBound.getTime()) result = lowerBound;
  return result;
}
