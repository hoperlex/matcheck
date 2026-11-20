import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  DeliveryGroupComposeRequest,
  DeliveryGroupComposeResponse,
  DeliveryGroupDissolveResponse,
  DeliveryGroupLeaveResponse,
} from '@matcheck/contracts';
import { api } from '../../services/api';
import { useCollapsedGroups } from '../../shared/ui/groupRows';

const COLLAPSED_KEY = 'matcheck.deliveryGroups.collapsed';

/** Свёрнутые группы приёмок — общий хук shared/ui/groupRows.ts, свой ключ. */
export function useCollapsedDeliveryGroups(): {
  collapsed: ReadonlySet<string>;
  toggle: (groupId: string) => void;
} {
  return useCollapsedGroups(COLLAPSED_KEY);
}

/** Сбор, уход и роспуск группы; после любого — список и состав перечитываются. */
export function useDeliveryGroupMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['deliveries'] }),
      queryClient.invalidateQueries({ queryKey: ['delivery-group-members'] }),
    ]);
  const compose = useMutation({
    mutationFn: (body: DeliveryGroupComposeRequest) =>
      api.post<DeliveryGroupComposeResponse>('/delivery-groups', body),
    onSuccess: refresh,
  });
  const leave = useMutation({
    mutationFn: (deliveryIds: string[]) =>
      api.post<DeliveryGroupLeaveResponse>('/delivery-groups/leave', { deliveryIds }),
    onSuccess: refresh,
  });
  const dissolve = useMutation({
    mutationFn: (groupId: string) =>
      api.delete<DeliveryGroupDissolveResponse>(`/delivery-groups/${groupId}`),
    onSuccess: refresh,
  });
  return { compose, leave, dissolve };
}
