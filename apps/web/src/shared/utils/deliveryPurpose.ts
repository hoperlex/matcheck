import type { DeliveryPurpose } from '@matcheck/contracts';

export const DELIVERY_PURPOSE_LABELS: Record<DeliveryPurpose, string> = {
  own_forces: 'Свои силы',
  realization: 'Реализация',
  tolling_act: 'Давальческий акт',
  contractor_materials: 'Материалы подрядчика',
};

export const DELIVERY_PURPOSE_OPTIONS: { key: DeliveryPurpose; label: string }[] = [
  { key: 'own_forces', label: '1 Свои силы' },
  { key: 'realization', label: '2 Реализация' },
  { key: 'tolling_act', label: '3 Давальческий акт' },
  { key: 'contractor_materials', label: '4 Материалы подрядчика' },
];
