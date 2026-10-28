import { describe, expect, it } from 'vitest';
import { approvalText, contractorsText, formatMsk, stageLabel, worstApprovalState } from './estimatOrder';

describe('estimatOrder', () => {
  it('худшее состояние: удалён и отменён хуже несогласованного, recorded не хуже согласованного', () => {
    expect(worstApprovalState(['approved', 'not_required'])).toBe('approved');
    expect(worstApprovalState(['not_required', 'approved'])).toBe('not_required');
    expect(worstApprovalState(['approved', 'pending'])).toBe('pending');
    expect(worstApprovalState(['pending', 'deleted', 'approved'])).toBe('deleted');
    expect(worstApprovalState([])).toBeNull();
  });

  it('время по Москве', () => {
    expect(formatMsk('2026-10-22T12:40:11.000Z')).toBe('22.10.2026, 15:40');
    expect(formatMsk('2026-10-22T21:30:00.000Z', false)).toBe('23.10.2026');
    expect(formatMsk(null)).toBe('—');
  });

  it('виза одной строкой', () => {
    const base = { supplyApprovedAt: null, lastApprovalRevokedAt: null };
    expect(approvalText({ ...base, approvalState: 'approved', supplyApprovedAt: '2026-10-22T12:40:11.000Z' })).toBe(
      'согласован 22.10.2026, 15:40',
    );
    expect(approvalText({ ...base, approvalState: 'pending' })).toBe('не согласован');
    expect(
      approvalText({ ...base, approvalState: 'pending', lastApprovalRevokedAt: '2026-10-23T07:00:00.000Z' }),
    ).toContain('согласование снято');
    expect(approvalText({ ...base, approvalState: 'not_required' })).toContain('виза не требуется');
  });

  it('подписи стадий и подрядчиков', () => {
    expect(stageLabel('awarded')).toBe('Поставщик выбран');
    expect(stageLabel('new_stage')).toBe('new_stage');
    expect(
      contractorsText({
        contractors: [
          { id: '1', name: 'ООО А', inn: null, type: 'subcontractor' },
          { id: '2', name: 'Иванов И.И.', inn: null, type: 'mol' },
        ],
      }),
    ).toBe('ООО А, Иванов И.И. (МОЛ)');
    expect(contractorsText({ contractors: [] })).toBe('—');
  });
});
