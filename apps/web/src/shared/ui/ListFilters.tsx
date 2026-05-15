import { useEffect, useState, type ReactNode } from 'react';
import { Input, Select, Space } from 'antd';
import type { Counterparty, Site } from '@matcheck/contracts';

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
const SEARCH_DEBOUNCE_MS = 250;

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

  // Локальный буфер строки поиска: набираем без задержки, а наружу пушим
  // дебаунсом — иначе каждый символ плодит запись в history.
  const [qLocal, setQLocal] = useState(value.q);
  useEffect(() => {
    setQLocal(value.q);
  }, [value.q]);
  useEffect(() => {
    if (qLocal === value.q) return;
    const t = window.setTimeout(() => onChange({ q: qLocal }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [qLocal, value.q, onChange]);

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
        <Input.Search
          style={{ width: SEARCH_WIDTH }}
          placeholder={searchPlaceholder ?? 'Номер документа'}
          value={qLocal}
          allowClear
          onChange={(e) => setQLocal(e.target.value)}
          onSearch={(v) => onChange({ q: v })}
        />
      )}
      {extra}
    </Space>
  );
}
