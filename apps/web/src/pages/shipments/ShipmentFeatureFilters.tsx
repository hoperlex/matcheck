import { Select } from 'antd';

// 4 значения «Тип отгрузки» (shipments.purpose, миграция 0050).
// Источник правды — ShipmentPage.PURPOSE_OPTIONS. Дублирую сюда, чтобы
// не тянуть импорт из крупного lazy-модуля ShipmentPage в фильтры списка.
export const PURPOSE_VALUES = [
  'Вывоз материала',
  'Перемещение на объект',
  'Вывоз мусора',
  'Другое',
] as const;
export type ShipmentPurpose = (typeof PURPOSE_VALUES)[number];

// 4 признака «Признаки». Внутри multi-select — AND (требование задачи):
// «ОС + УПД» = есть и ОС, и УПД.
export const FEATURE_VALUES = ['assets', 'waybill', 'upd', 'transit'] as const;
export type ShipmentFeature = (typeof FEATURE_VALUES)[number];

const FEATURE_LABELS: Record<ShipmentFeature, string> = {
  assets: 'ОС',
  waybill: 'Накладные',
  upd: 'УПД',
  transit: 'Транзит',
};

export interface ShipmentFeatureFiltersValue {
  purposes: ShipmentPurpose[];
  features: ShipmentFeature[];
}

interface Props {
  value: ShipmentFeatureFiltersValue;
  onChange: (patch: Partial<ShipmentFeatureFiltersValue>) => void;
}

/**
 * Компактные мультиселекты «Тип отгрузки» и «Признаки» — рендерятся
 * в строке фильтров `ShipmentsHistory` через ListFilters.tail. На
 * Приёмке не показываются (компонент монтируется только в
 * ShipmentsHistory). `maxTagCount="responsive"` — выбранные значения
 * сворачиваются в «+N», высота строки не растёт.
 */
export function ShipmentFeatureFilters({ value, onChange }: Props) {
  return (
    <>
      <Select<ShipmentPurpose[]>
        mode="multiple"
        style={{ minWidth: 200 }}
        placeholder="Тип отгрузки"
        value={value.purposes}
        onChange={(v) => onChange({ purposes: v })}
        allowClear
        maxTagCount="responsive"
        options={PURPOSE_VALUES.map((p) => ({ value: p, label: p }))}
      />
      <Select<ShipmentFeature[]>
        mode="multiple"
        style={{ minWidth: 180 }}
        placeholder="Признаки"
        value={value.features}
        onChange={(v) => onChange({ features: v })}
        allowClear
        maxTagCount="responsive"
        options={FEATURE_VALUES.map((f) => ({ value: f, label: FEATURE_LABELS[f] }))}
      />
    </>
  );
}
