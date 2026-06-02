import type { ReactNode } from 'react';
import { Select, Space } from 'antd';
import type { Counterparty, Site } from '@matcheck/contracts';
import { DebouncedSearch } from './DebouncedSearch';

export type ListFilterField = 'contractor' | 'supplier' | 'site' | 'q';

export interface ListFiltersValue {
  contractorId: string | null;
  supplierId: string | null;
  siteId: string | null;
  q: string;
}

export interface ListFiltersProps {
  value: ListFiltersValue;
  onChange: (patch: Partial<ListFiltersValue>) => void;
  fields: ReadonlyArray<ListFilterField>;
  counterparties: Counterparty[];
  sites: Site[];
  loading?: boolean;
  searchPlaceholder?: string;
  extra?: ReactNode;
}

const SELECT_WIDTH = 200;
const SEARCH_WIDTH = 220;

/**
 * Общая панель фильтров для списочных страниц (Приёмка, Отгрузка, Документы).
 * Полностью controlled — состояние хранит родитель (обычно в URL searchParams).
 * Справочники прокидываются через props, чтобы они переиспользовались для резолва
 * имён в столбцах таблицы и не дублировались между несколькими списками на странице.
 */
export function ListFilters({
  value,
  onChange,
  fields,
  counterparties,
  sites,
  loading,
  searchPlaceholder,
  extra,
}: ListFiltersProps) {
  const showContractor = fields.includes('contractor');
  const showSupplier = fields.includes('supplier');
  const showSite = fields.includes('site');
  const showQ = fields.includes('q');

  const contractorOptions = counterparties
    .filter((c) => c.isContractor)
    .map((c) => ({ value: c.id, label: c.name }));
  const supplierOptions = counterparties
    .filter((c) => c.isSupplier)
    .map((c) => ({ value: c.id, label: c.name }));
  const siteOptions = sites.map((s) => ({
    value: s.id,
    label: `${s.code} · ${s.name}`,
  }));

  return (
    <Space wrap size={[8, 8]} style={{ width: '100%' }}>
      {showContractor && (
        <Select<string>
          style={{ width: SELECT_WIDTH }}
          placeholder="Подрядчик"
          value={value.contractorId ?? undefined}
          onChange={(v) => onChange({ contractorId: v ?? null })}
          allowClear
          showSearch
          optionFilterProp="label"
          loading={loading}
          options={contractorOptions}
        />
      )}
      {showSupplier && (
        <Select<string>
          style={{ width: SELECT_WIDTH }}
          placeholder="Поставщик"
          value={value.supplierId ?? undefined}
          onChange={(v) => onChange({ supplierId: v ?? null })}
          allowClear
          showSearch
          optionFilterProp="label"
          loading={loading}
          options={supplierOptions}
        />
      )}
      {showSite && (
        <Select<string>
          style={{ width: SELECT_WIDTH }}
          placeholder="Объект"
          value={value.siteId ?? undefined}
          onChange={(v) => onChange({ siteId: v ?? null })}
          allowClear
          showSearch
          optionFilterProp="label"
          loading={loading}
          options={siteOptions}
        />
      )}
      {showQ && (
        <DebouncedSearch
          style={{ width: SEARCH_WIDTH }}
          placeholder={searchPlaceholder ?? 'Номер документа'}
          value={value.q}
          onChange={(v) => onChange({ q: v })}
        />
      )}
      {extra}
    </Space>
  );
}
