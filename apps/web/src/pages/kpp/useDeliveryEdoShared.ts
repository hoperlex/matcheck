import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { FactRow } from './edoSectionTotals';
import type { LinkedEdoDocument } from './LinkedEdoChips';

/** Другая приёмка с той же УПД и её факт по области связи. */
export type SharedEdoDelivery = {
  deliveryId: string;
  displayId: number;
  arrivedAt: string | null;
  /** 'section' — позиции блока документа; 'delivery' — все позиции приёмки. */
  scope: 'section' | 'delivery';
  /** В той же области у соседа есть другая УПД из ЭДО. */
  otherEdoInScope: boolean;
  rows: FactRow[];
};

/** Та же УПД в других приёмках (`GET …/edo-matches/shared`). */
export type SharedEdoFacts = {
  matchId: string;
  /** Сколько других приёмок всего; `deliveries` — первые из них. */
  count: number;
  deliveries: SharedEdoDelivery[];
};

/**
 * Ключ под префиксом привязок: `delivery_updated` по SSE сбрасывает
 * `['delivery-edo-matches']` — и строка «Факт по всем» обновится, когда сосед
 * сохранит свои позиции или кто-то привяжет ту же УПД к ещё одной приёмке.
 */
export const edoSharedQueryKey = (deliveryId: string | null) =>
  ['delivery-edo-matches', deliveryId, 'shared'] as const;

/**
 * Факт других приёмок по каждой общей УПД. Запрос — только если хоть одна
 * привязка стоит ещё где-то (`alsoInCount`): у остальных строки «Факт по
 * всем» нет.
 */
export function useDeliveryEdoShared(
  deliveryId: string | null,
  matches: readonly LinkedEdoDocument[],
): ReadonlyMap<string, SharedEdoFacts> {
  const enabled = !!deliveryId && matches.some((match) => match.alsoInCount > 0);
  const query = useQuery({
    queryKey: edoSharedQueryKey(deliveryId),
    queryFn: () =>
      api.get<{ items: SharedEdoFacts[] }>(`/deliveries/${deliveryId}/edo-matches/shared`),
    enabled,
  });
  return new Map(enabled ? (query.data?.items ?? []).map((item) => [item.matchId, item]) : []);
}
