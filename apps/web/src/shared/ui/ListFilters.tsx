import type { ReactNode } from 'react';
import { Select, Space } from 'antd';
import type { Counterparty, Site } from '@matcheck/contracts';
import { DebouncedSearch } from './DebouncedSearch';

export type ListFilterField = 'contractor' | 'supplier' | 'site' | 'q';

// Селекты Подрядчик/Поставщик/Объект — мульти-выбор. Пустой массив = «все».
// В URL хранится как CSV: `?contractor=uuid1,uuid2`. Парсинг — на стороне
// страниц, см. parseCsvIds в shared/utils.
export interface ListFiltersValue {
  contractorIds: string[];
  supplierIds: string[];
  siteIds: string[];
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
  /**
   * Доп. фильтры, которые рендерятся между стандартными селектами/поиском
   * и блоком `extra` (обычно кнопки «Новая запись» / «Экспорт»). Сохраняют
   * единый `Space wrap` родителя — переносятся на следующий ряд на узких
   * экранах вместе с остальными фильтрами, без поломки layout.
   */
  tail?: ReactNode;
}

const SELECT_WIDTH = 240;
const SEARCH_WIDTH = 220;

/**
 * Общая панель фильтров для списочных страниц (Приёмка, Отгрузка, Документы).
 * Полностью controlled — состояние хранит родитель (обычно в URL searchParams).
 * Справочники прокидываются через props, чтобы они переиспользовались для резолва
 * имён в столбцах таблицы и не дублировались между несколькими списками на странице.
 *
 * Селекты в режиме `multiple` — пользователь может выбрать несколько
 * подрядчиков/поставщиков/объектов. `maxTagCount="responsive"` — теги
 * адаптивно сворачиваются в «+N», чтобы не растягивать высоту строки.
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
  tail,
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
        <Select<string[]>
          mode="multiple"
          style={{ minWidth: SELECT_WIDTH }}
          placeholder="Подрядчик"
          value={value.contractorIds}
          onChange={(v) => onChange({ contractorIds: v })}
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
          loading={loading}
          options={contractorOptions}
        />
      )}
      {showSupplier && (
        <Select<string[]>
          mode="multiple"
          style={{ minWidth: SELECT_WIDTH }}
          placeholder="Поставщик"
          value={value.supplierIds}
          onChange={(v) => onChange({ supplierIds: v })}
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
          loading={loading}
          options={supplierOptions}
        />
      )}
      {showSite && (
        <Select<string[]>
          mode="multiple"
          style={{ minWidth: SELECT_WIDTH }}
          placeholder="Объект"
          value={value.siteIds}
          onChange={(v) => onChange({ siteIds: v })}
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount="responsive"
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
      {tail}
      {extra}
    </Space>
  );
}
