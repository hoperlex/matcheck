import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SupplierFilterOption, SupplierFilterOptionsResponse } from '@matcheck/contracts';
import { api } from '../../services/api';

/**
 * Поставщики для выбора человеком — одна строка на организацию.
 *
 * В справочнике у одной организации бывает по 40 записей (дубли распознавания
 * с ошибочным ИНН), и раньше и фильтр «Поставщик», и окно в карточке показывали
 * каждую. Группы считает сервер (domain/directories/supplier-filter-groups.ts):
 * `value` — основная запись, `memberIds` — вся группа. Фильтр по `value`
 * сервер сам раскрывает в группу, по любому участнику — тоже.
 *
 * Ключ — объект, а не строка: справочник держит `['suppliers', search]` со
 * строкой поиска, и строковый ключ мог бы совпасть с набранным текстом.
 * Префикс общий — правки справочника сбрасывают и этот кэш.
 */
export const SUPPLIER_FILTER_OPTIONS_KEY = ['suppliers', { view: 'filter-options' }] as const;

/** id участника → id строки его группы; повторы убираются, неизвестные id остаются. */
export function normalizeSupplierIds(
  ids: readonly string[],
  groupOf: ReadonlyMap<string, string>,
): string[] {
  return [...new Set(ids.map((id) => groupOf.get(id) ?? id))];
}

export function useSupplierFilterOptions({ enabled }: { enabled: boolean }): {
  options: { value: string; label: string }[];
  groups: SupplierFilterOption[] | undefined;
  loading: boolean;
  normalize: (ids: readonly string[]) => string[];
} {
  const query = useQuery({
    queryKey: SUPPLIER_FILTER_OPTIONS_KEY,
    queryFn: () => api.get<SupplierFilterOptionsResponse>('/suppliers/filter-options'),
    // Справочник меняется редко, а правки в нём сбрасывают кэш сами.
    staleTime: 5 * 60 * 1000,
    enabled,
  });
  const groups = query.data?.items;
  const options = useMemo(
    () => (groups ?? []).map((g) => ({ value: g.value, label: g.label })),
    [groups],
  );
  // Без этого старая ссылка ?supplier=<дубль> или смена основной записи после
  // импорта BillHub показали бы в теге голый uuid вместо названия.
  const groupOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups ?? []) for (const id of g.memberIds) m.set(id, g.value);
    return m;
  }, [groups]);
  const normalize = useCallback(
    (ids: readonly string[]) => normalizeSupplierIds(ids, groupOf),
    [groupOf],
  );
  return { options, groups, loading: query.isLoading, normalize };
}
