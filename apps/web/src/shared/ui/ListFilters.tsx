import type { ReactNode } from 'react';
import { DatePicker, Select, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import type { Counterparty, Site } from '@matcheck/contracts';
import { DebouncedSearch } from './DebouncedSearch';

export type ListFilterField = 'contractor' | 'supplier' | 'site' | 'q' | 'plate' | 'dates';

// Селекты Подрядчик/Поставщик/Объект — мульти-выбор. Пустой массив = «все».
// В URL хранится как CSV: `?contractor=uuid1,uuid2`. Парсинг — на стороне
// страниц, см. parseCsvIds в shared/utils.
//
// Внимание: id'ы в фильтрах «Подрядчик» и «Поставщик» — это id'ы записей
// СПРАВОЧНИКОВ заказчика (customer_counterparties / suppliers), а НЕ
// операционных counterparties. Маппинг в реальные FK операций родительские
// списки делают через buildInnMatchMap (см. shared/utils/directoryFilterMap).
export interface ListFiltersValue {
  contractorIds: string[];
  supplierIds: string[];
  siteIds: string[];
  q: string;
}

export type SelectOption = { value: string; label: string };

export interface ListFiltersProps {
  value: ListFiltersValue;
  onChange: (patch: Partial<ListFiltersValue>) => void;
  fields: ReadonlyArray<ListFilterField>;
  // Готовые опции селектов: родитель решает, откуда они грузятся
  // (customer_counterparties для «Подрядчика», suppliers для «Поставщика»).
  // Это явная инверсия зависимости — раньше ListFilters сам фильтровал
  // массив Counterparty[] по isContractor/isSupplier и тянул legacy-данные.
  contractorOptions?: SelectOption[];
  supplierOptions?: SelectOption[];
  // Legacy-режим: если передан counterparties (массив операционной таблицы)
  // и НЕ переданы contractorOptions/supplierOptions, options генерируются
  // из counterparties по флагам isContractor/isSupplier — для обратной
  // совместимости с разделом «Документы» (Inbox), где серверная фильтрация
  // ждёт именно операционные counterparty.id, а не id справочников
  // заказчика. Новые вызовы должны передавать готовые options.
  counterparties?: Counterparty[];
  sites: Site[];
  loading?: boolean;
  searchPlaceholder?: string;
  /**
   * Поиск по госномеру (field 'plate'). Отдельные props, а не поле
   * ListFiltersValue: фильтр нужен только «Принятым» приёмкам/отгрузкам, где у
   * записи есть авто. Списки без авто (Документы, Ожидаемые) их не передают.
   */
  plate?: string;
  onPlateChange?: (v: string) => void;
  /**
   * Диапазон дат (field 'dates'): прибытие для приёмки, отгрузка для отгрузки.
   * Значения — дни без времени; конверсию в ISO-границы для сервера делает
   * родитель (у приёмки и отгрузки разные query-параметры).
   */
  dateRange?: [Dayjs | null, Dayjs | null] | null;
  onDateRangeChange?: (r: [Dayjs | null, Dayjs | null] | null) => void;
  /** Подписи краёв диапазона, напр. ['Прибытие с', 'по']. */
  datesPlaceholder?: [string, string];
  extra?: ReactNode;
  /**
   * Доп. фильтры, которые рендерятся между стандартными селектами/поиском
   * и блоком `extra` (обычно кнопки «Новая запись» / «Экспорт»). Сохраняют
   * единый `Space wrap` родителя — переносятся на следующий ряд на узких
   * экранах вместе с остальными фильтрами, без поломки layout.
   */
  tail?: ReactNode;
}

// ФИКСИРОВАННАЯ ширина мульти-селектов (не minWidth/эластичная!). Это
// принципиально в связке с maxTagCount={1} ниже: при mode="multiple" antd рисует
// теги через rc-overflow. Режим maxTagCount="responsive" оборачивает контейнер в
// ResizeObserver и на каждый ресайз пересчитывает, сколько тегов влезло. Если
// ширина поля при этом ЭЛАСТИЧНА (minWidth/maxWidth, ширина зависит от контента),
// измерение не сходится: показал тег → поле шире → влезло ещё → свернул → уже →
// повтор каждый кадр. Так все три селекта в одном <Space wrap> «дребезжали»
// влево-вправо (и по крестику ✕ было не попасть). Фиксированная width делает
// clientWidth константой, а maxTagCount={1} вовсе отключает responsive-путь и его
// ResizeObserver. Длинный одиночный тег обрезается эллипсисом ВНУТРИ поля.
const SELECT_WIDTH = 240;
const SEARCH_WIDTH = 220;
// Тоже фиксированная — по той же причине, что и SELECT_WIDTH выше: любое
// эластичное поле в общем <Space wrap> двигает порог переноса строки и
// возвращает «дребезг» всей панели.
const DATES_WIDTH = 260;

/**
 * Общая панель фильтров для списочных страниц (Приёмка, Отгрузка, Документы).
 * Полностью controlled — состояние хранит родитель (обычно в URL searchParams).
 * Опции селектов «Подрядчик» и «Поставщик» теперь приходят сверху уже готовыми
 * (раньше компонент фильтровал Counterparty[] по флагам isContractor/isSupplier
 * прямо из операционной таблицы; см. directoryFilterMap для нового маппинга).
 *
 * Селекты в режиме `multiple` — пользователь может выбрать несколько
 * подрядчиков/поставщиков/объектов. `maxTagCount={1}` — показываем один тег
 * и «+N» (НЕ "responsive": тот через ResizeObserver зацикливал измерение
 * ширины и «дребезжал», см. комментарий у SELECT_WIDTH).
 */
export function ListFilters({
  value,
  onChange,
  fields,
  contractorOptions,
  supplierOptions,
  counterparties,
  sites,
  loading,
  searchPlaceholder,
  plate,
  onPlateChange,
  dateRange,
  onDateRangeChange,
  datesPlaceholder,
  extra,
  tail,
}: ListFiltersProps) {
  const showContractor = fields.includes('contractor');
  const showSupplier = fields.includes('supplier');
  const showSite = fields.includes('site');
  const showQ = fields.includes('q');
  const showPlate = fields.includes('plate');
  const showDates = fields.includes('dates');

  // Legacy fallback — Inbox по-прежнему отправляет операционные
  // counterparty.id на сервер, поэтому ему нужны options из counterparties.
  const effectiveContractorOptions: SelectOption[] =
    contractorOptions ??
    (counterparties ?? [])
      .filter((c) => c.isContractor)
      .map((c) => ({ value: c.id, label: c.name }));
  const effectiveSupplierOptions: SelectOption[] =
    supplierOptions ??
    (counterparties ?? [])
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
          style={{ width: SELECT_WIDTH }}
          placeholder="Подрядчик"
          value={value.contractorIds}
          onChange={(v) => onChange({ contractorIds: v })}
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount={1}
          loading={loading}
          options={effectiveContractorOptions}
        />
      )}
      {showSupplier && (
        <Select<string[]>
          mode="multiple"
          style={{ width: SELECT_WIDTH }}
          placeholder="Поставщик"
          value={value.supplierIds}
          onChange={(v) => onChange({ supplierIds: v })}
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount={1}
          loading={loading}
          options={effectiveSupplierOptions}
        />
      )}
      {showSite && (
        <Select<string[]>
          mode="multiple"
          style={{ width: SELECT_WIDTH }}
          placeholder="Объект"
          value={value.siteIds}
          onChange={(v) => onChange({ siteIds: v })}
          allowClear
          showSearch
          optionFilterProp="label"
          maxTagCount={1}
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
      {showPlate && (
        <DebouncedSearch
          style={{ width: SEARCH_WIDTH }}
          placeholder="Номер авто"
          value={plate}
          onChange={(v) => onPlateChange?.(v)}
        />
      )}
      {showDates && (
        <DatePicker.RangePicker
          style={{ width: DATES_WIDTH }}
          format="DD.MM.YYYY"
          allowEmpty={[true, true]}
          placeholder={datesPlaceholder ?? ['С даты', 'По дату']}
          value={dateRange as [Dayjs, Dayjs] | null}
          onChange={(v) => onDateRangeChange?.(v as [Dayjs | null, Dayjs | null] | null)}
        />
      )}
      {tail}
      {extra}
    </Space>
  );
}
