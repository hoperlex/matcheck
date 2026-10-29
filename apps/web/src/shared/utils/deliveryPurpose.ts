import { DELIVERY_PURPOSE_LABELS, type DeliveryPurpose } from '@matcheck/contracts';

export { DELIVERY_PURPOSE_LABELS };

export const DELIVERY_PURPOSE_OPTIONS: { key: DeliveryPurpose; label: string }[] = [
  { key: 'own_forces', label: '1 Свои силы' },
  { key: 'realization', label: '2 Реализация' },
  { key: 'tolling_act', label: '3 Давальческий акт' },
  { key: 'contractor_materials', label: '4 Материалы подрядчика' },
  { key: 'realization_tolling', label: '5 Реализация + давальческий' },
];
