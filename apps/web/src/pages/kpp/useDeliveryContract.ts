import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeliveryContractResponse } from '@matcheck/contracts';
import { api } from '../../services/api';

/** Как часто перечитывать договор открытой карточки. */
export const DELIVERY_CONTRACT_REFRESH_MS = 30_000;

/**
 * Договор 1С приёмки и сводка справочника (сколько договоров, когда загружены).
 *
 * Опрос раз в 30 с, пока карточка открыта, — даже без договора: SSE закрыт для
 * Мониторинга и бывает молчащим, а общий запасной рефетч — раз в 5 минут. Опрос
 * же закрывает первый импорт: CLI событий не шлёт, а карточка с пустым
 * справочником за 30 с увидит договоры, и появится «+ Договор». В фоне
 * react-query не опрашивает.
 *
 * Договор сменился (чужая замена) — окно подбора перечитывает кандидатов:
 * иначе метка «текущий» осталась бы на старом.
 */
export function useDeliveryContract(deliveryId: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['delivery-contract', deliveryId],
    queryFn: () => api.get<DeliveryContractResponse>(`/deliveries/${deliveryId}/contract`),
    enabled: !!deliveryId && enabled,
    refetchInterval: DELIVERY_CONTRACT_REFRESH_MS,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const contractId = query.data ? (query.data.contract?.id ?? null) : undefined;
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (contractId === undefined) return;
    if (seen.current !== undefined && seen.current !== contractId) {
      void queryClient.invalidateQueries({ queryKey: ['delivery-contract-candidates', deliveryId] });
    }
    seen.current = contractId;
  }, [contractId, deliveryId, queryClient]);

  return query;
}
