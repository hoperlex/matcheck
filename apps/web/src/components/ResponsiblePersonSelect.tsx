import { Select, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ResponsiblePerson } from '@matcheck/contracts';
import { api } from '../services/api';

type ListResp = { items: ResponsiblePerson[]; total: number };

/**
 * Combobox МОЛ (материально-ответственное лицо) — выбор из справочника.
 *
 * Список — все активные МОЛ: зеркало ФОТ (начальники участков) и заведённые
 * вручную в Справочники → МОЛ (кладовщики, которых в ФОТ нет). Тот же запрос
 * и ключ кэша, что у выбора МОЛ в приёмке и отгрузке.
 *
 * Создавать МОЛ отсюда нельзя: только в Справочники → МОЛ, где видно, есть ли
 * человек в ФОТ или в архиве, — иначе в списках копятся опечатки и тёзки.
 */
export function ResponsiblePersonSelect({
  value,
  onChange,
  disabled,
  placeholder = 'Выберите МОЛ',
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const list = useQuery({
    queryKey: ['responsible-persons', 'active'],
    queryFn: () => api.get<ListResp>('/responsible-persons?activeOnly=true&limit=500'),
  });
  const items = list.data?.items ?? [];

  return (
    <Select
      showSearch
      allowClear
      placeholder={placeholder}
      value={value ?? undefined}
      onChange={(v) => onChange(v ?? null)}
      loading={list.isLoading}
      disabled={disabled}
      style={{ width: '100%' }}
      optionFilterProp="label"
      options={items.map((p) => ({ value: p.id, label: p.fullName }))}
      notFoundContent={list.isLoading ? <Spin size="small" /> : 'Ничего не найдено'}
    />
  );
}
