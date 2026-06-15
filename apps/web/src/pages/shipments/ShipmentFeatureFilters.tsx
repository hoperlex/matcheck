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

// 4 признака «Признаки» — общие для приёмки и отгрузки.
// Внутри multi-select — AND (требование задачи): «ОС + УПД» =
// есть и ОС, и УПД.
//   assets  — позиция/документ с itemKind='asset' или флаг isAssets,
//             выставленный инспектором в мобиле на 1-м этапе.
//   waybill — привязан source_document с kind='transport_waybill' или
//             'os2_transfer' (ТТН / ОС-2).
//   upd     — привязан source_document с kind='upd' (УПД).
//   transit — флаг inTransit, выставленный инспектором в мобиле
//             на 1-м этапе. У delivery и shipment поля симметричны
//             (миграции 0051 in_transit, 0065 is_assets).
export const FEATURE_VALUES = ['assets', 'waybill', 'upd', 'transit'] as const;
export type OperationFeature = (typeof FEATURE_VALUES)[number];
// Обратно-совместимое имя для существующих импортов в ShipmentsHistory.
export type ShipmentFeature = OperationFeature;

const FEATURE_LABELS: Record<OperationFeature, string> = {
  assets: 'ОС',
  waybill: 'Накладные',
  upd: 'УПД',
  transit: 'Транзит',
};

export interface ShipmentFeatureFiltersValue {
  purposes: ShipmentPurpose[];
  features: OperationFeature[];
}

interface Props {
  value: ShipmentFeatureFiltersValue;
  onChange: (patch: Partial<ShipmentFeatureFiltersValue>) => void;
  // Селект «Тип отгрузки» (purpose) — только для отгрузки; у приёмки
  // такого семантического поля нет. По умолчанию true для обратной
  // совместимости с уже существующим вызовом из ShipmentsHistory.
  showPurpose?: boolean;
  // Подмножество признаков, доступных в этом списке. На Ожидаемых
  // (source_documents без поставки) transit/assets смыслово не
  // определены — не показываем их, чтобы пользователь не видел
  // «фильтр работает, но всегда возвращает пусто». По умолчанию —
  // все 4 признака.
  availableFeatures?: ReadonlyArray<OperationFeature>;
}

/**
 * Компактные мультиселекты «Тип отгрузки» и «Признаки» — рендерятся
 * в строке фильтров через ListFilters.tail. На приёмке передаётся
 * showPurpose={false} (там нет purpose-поля у модели). У обоих типов
 * операций «Признаки» работают по симметричным полям delivery/shipment
 * (in_transit, is_assets, item_kind='asset', linked source_documents).
 * `maxTagCount="responsive"` — выбранные значения сворачиваются в «+N»,
 * высота строки не растёт.
 */
export function ShipmentFeatureFilters({
  value,
  onChange,
  showPurpose = true,
  availableFeatures = FEATURE_VALUES,
}: Props) {
  const featureOptions = availableFeatures.map((f) => ({
    value: f,
    label: FEATURE_LABELS[f],
  }));
  return (
    <>
      {showPurpose && (
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
      )}
      <Select<OperationFeature[]>
        mode="multiple"
        style={{ minWidth: 180 }}
        placeholder="Признаки"
        value={value.features}
        onChange={(v) => onChange({ features: v })}
        allowClear
        maxTagCount="responsive"
        options={featureOptions}
      />
    </>
  );
}
