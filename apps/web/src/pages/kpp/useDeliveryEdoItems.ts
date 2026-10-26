import { useQueries } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { LinkedEdoDocument } from './LinkedEdoChips';

/** Что сервер сделал с файлом УПД (`GET …/edo-matches/:matchId/items`). */
export type EdoItemsState =
  | 'ready'
  | 'incomplete'
  | 'storage_failed'
  | 'parse_failed'
  | 'too_large';

/** Строка УПД из ЭДО. null у числа — «неизвестно», не ноль. */
export type EdoItem = {
  position: number;
  lineNo: number | null;
  nameRaw: string;
  qty: number;
  unit: string | null;
  unitCode: string | null;
  /** Цена за единицу без НДС. */
  price: number | null;
  sumExVat: number | null;
  vatRate: number | null;
  vatSum: number | null;
  /** Стоимость строки с НДС. */
  sum: number | null;
  /** ПрТовРаб: 1 — имущество, 2 — работа, 3 — услуга, 4 — права, 5 — иное. */
  itemKind: number | null;
  productCode: string | null;
};

export type EdoItemsResponse = {
  matchId: string;
  source: 'import' | 'export';
  /** Подпись — из реестра или карточки; есть и при сбое разбора. */
  label: {
    operator: string;
    docNumber: string | null;
    docDate: string | null;
    correctionNumber: string | null;
  };
  state: EdoItemsState;
  /** null — разбора нет. */
  totals: { totalSum: number | null; totalExVat: number | null; vatSum: number | null } | null;
  reasons: string[];
  items: EdoItem[];
};

/**
 * Строки одной привязанной УПД в карточке.
 * `loading` — ответа ещё нет; `error` — запрос не дошёл (сеть, 5xx);
 * `done` — ответ есть, что с файлом — в `data.state`.
 */
export type EdoItemsEntry = {
  match: LinkedEdoDocument;
  status: 'loading' | 'error' | 'done';
  data: EdoItemsResponse | null;
  refetch: () => void;
};

export const edoItemsQueryKey = (deliveryId: string | null, matchId: string) =>
  ['delivery-edo-items', deliveryId, matchId] as const;

/**
 * Строки УПД из ЭДО по всем привязкам приёмки — запрос на каждую привязку.
 *
 * Отдельные запросы, а не один общий: чтение файла из хранилища может ждать до
 * срока сервера (15 с), и медленная УПД не должна задерживать соседние.
 *
 * Обновлять нечего: файл УПД в реестре неизменен, поэтому `staleTime: Infinity`.
 * Новая привязка (своя, чужая по SSE, fallback-рефетч) приходит новым id в
 * списке привязок — её запрос стартует сам. Повторы — на сервере, здесь их нет:
 * повтор поверх 15-секундного срока растянул бы «Загружаю…» на минуту.
 */
export function useDeliveryEdoItems(
  deliveryId: string | null,
  matches: readonly LinkedEdoDocument[],
): Map<string, EdoItemsEntry> {
  const results = useQueries({
    queries: matches.map((match) => ({
      queryKey: edoItemsQueryKey(deliveryId, match.id),
      queryFn: () =>
        api.get<EdoItemsResponse>(`/deliveries/${deliveryId}/edo-matches/${match.id}/items`),
      enabled: !!deliveryId,
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
    })),
  });
  const byMatch = new Map<string, EdoItemsEntry>();
  matches.forEach((match, index) => {
    const result = results[index]!;
    // Данные важнее ошибки повторного запроса: при «Повторить» таблица не
    // должна пропадать, пока ответ не пришёл.
    const status = result.data ? 'done' : result.isError ? 'error' : 'loading';
    byMatch.set(match.id, {
      match,
      status,
      data: result.data ?? null,
      refetch: () => void result.refetch(),
    });
  });
  return byMatch;
}
