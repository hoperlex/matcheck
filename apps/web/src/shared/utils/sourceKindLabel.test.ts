import { describe, expect, it } from 'vitest';
import { sourceKindLabel } from './sourceKindLabel';

describe('sourceKindLabel', () => {
  it('повторяет тексты, которые уже показывают списки', () => {
    expect(sourceKindLabel('upd')).toBe('УПД');
    expect(sourceKindLabel('transport_waybill')).toBe('Накладная');
    expect(sourceKindLabel('os2_transfer')).toBe('Накладная');
    expect(sourceKindLabel('request')).toBe('Заявка');
  });
});
