import { describe, it, expect } from 'vitest';
import {
  DeliveryStatusCodeSchema,
  ShipmentStatusCodeSchema,
  DELIVERY_HARD_DELETE_STATUSES,
  DELIVERY_SOFT_DELETE_STATUSES,
  SHIPMENT_HARD_DELETE_STATUSES,
  SHIPMENT_SOFT_DELETE_STATUSES,
} from '@matcheck/contracts';

/**
 * Регрессия на двухэтапную модель удаления.
 *
 * Что защищаем: набор soft-delete статусов для отгрузок был скопирован из
 * кода приёмок вместе с кодом `filled` (у отгрузки тот же по смыслу статус
 * «Оформлена» называется `shipped`). В результате `shipped` не попадал НИ в
 * один набор, и отгрузка становилась неудаляемой в принципе: DELETE отвечал
 * 409 `must_mark_first`, а mark-deletion — 400 `cannot_mark_status`.
 *
 * Отсюда главный инвариант: каждый код статуса сущности принадлежит ровно
 * одному набору — либо hard (удаляем сразу), либо soft (пометка → админ).
 * Дыра (код не покрыт) = документ нельзя удалить; пересечение = два разных
 * пути удаления для одного статуса.
 */

const CASES = [
  {
    entity: 'приёмка',
    codes: DeliveryStatusCodeSchema.options,
    hard: DELIVERY_HARD_DELETE_STATUSES,
    soft: DELIVERY_SOFT_DELETE_STATUSES,
  },
  {
    entity: 'отгрузка',
    codes: ShipmentStatusCodeSchema.options,
    hard: SHIPMENT_HARD_DELETE_STATUSES,
    soft: SHIPMENT_SOFT_DELETE_STATUSES,
  },
] as const;

describe.each(CASES)('наборы статусов удаления — $entity', ({ codes, hard, soft }) => {
  it.each(codes)('%s покрыт ровно одним набором (hard xor soft)', (code) => {
    // дыра (0 наборов) → документ неудаляем; оба набора → конфликт путей
    const sets = [hard.has(code) && 'hard', soft.has(code) && 'soft'].filter(Boolean);
    expect(sets).toHaveLength(1);
  });

  it('в наборах нет кодов из чужой сущности', () => {
    const known = new Set<string>(codes);
    const unknown = [...hard, ...soft].filter((code) => !known.has(code));
    expect(unknown).toEqual([]);
  });
});

describe('конкретные ожидания по статусам', () => {
  it('отгрузка «Оформлена» (shipped) удаляется через пометку — исходный баг', () => {
    expect(SHIPMENT_SOFT_DELETE_STATUSES.has('shipped')).toBe(true);
    expect(SHIPMENT_HARD_DELETE_STATUSES.has('shipped')).toBe(false);
    // `filled` — код приёмки, в наборах отгрузки ему делать нечего
    expect(SHIPMENT_SOFT_DELETE_STATUSES.has('filled')).toBe(false);
  });

  it('приёмка «Оформлена» (filled) — поведение прежнее', () => {
    expect(DELIVERY_SOFT_DELETE_STATUSES.has('filled')).toBe(true);
    expect(DELIVERY_SOFT_DELETE_STATUSES.has('confirmed_mol')).toBe(true);
  });

  it('черновики и «Не оформлена» удаляются сразу у обеих сущностей', () => {
    for (const code of ['draft', 'not_filled']) {
      expect(DELIVERY_HARD_DELETE_STATUSES.has(code)).toBe(true);
      expect(SHIPMENT_HARD_DELETE_STATUSES.has(code)).toBe(true);
    }
  });
});
