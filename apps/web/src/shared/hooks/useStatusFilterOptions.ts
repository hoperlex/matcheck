import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { StatusListResponse } from '@matcheck/contracts';
import { api } from '../../services/api';
import type { FilterOption } from '../ui/ColumnFilterWindow';

/**
 * Варианты воронки «Статус» в Принятых: все статусы операции из справочника
 * плюс «Без документа» — это не код статуса, а признак пустого
 * sourceDocumentIds (тот же, что понимает серверный ?status=no_document).
 *
 * Справочник статусов меняется раз в годы — держим его в кэше долго и не
 * дёргаем сервер при каждом открытии раздела.
 */
export function useStatusFilterOptions(entity: 'delivery' | 'shipment'): {
  options: FilterOption[];
  loading: boolean;
} {
  const query = useQuery({
    queryKey: ['statuses', entity],
    queryFn: () => api.get<StatusListResponse>(`/statuses?entity=${entity}`),
    staleTime: 30 * 60_000,
  });
  const options = useMemo(
    () => [
      ...(query.data?.items ?? []).map((s) => ({ value: s.code, label: s.label })),
      { value: 'no_document', label: 'Без документа' },
    ],
    [query.data],
  );
  return { options, loading: query.isLoading };
}
