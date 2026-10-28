import { useQuery } from '@tanstack/react-query';
import type { DeliverySupplierOrdersResponse } from '@matcheck/contracts';
import { api } from '../../services/api';

/** Как часто перечитывать привязанные заказы, пока карточка открыта. */
export const SUPPLIER_ORDERS_REFRESH_MS = 30_000;

/**
 * Заказы EstiMat, привязанные к приёмке. Отдельный запрос: опрос карточки раз
 * в 5 с обновляет только приёмку. Снятие визы в EstiMat обход приносит раз в
 * полчаса — пока заказы привязаны, перечитываем их раз в 30 с, чтобы открытая
 * карточка показала «не согласован» без перезагрузки. В фоне react-query не
 * опрашивает. SSE здесь не годится: поток закрыт для Мониторинга и в проде
 * бывает молчащим.
 */
export function useDeliverySupplierOrders(deliveryId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['delivery-supplier-orders', deliveryId],
    queryFn: () =>
      api.get<DeliverySupplierOrdersResponse>(`/deliveries/${deliveryId}/supplier-orders`),
    enabled: !!deliveryId && enabled,
    refetchInterval: (q) =>
      (q.state.data?.items.length ?? 0) > 0 ? SUPPLIER_ORDERS_REFRESH_MS : false,
    retry: false,
  });
}
