// @vitest-environment jsdom
/**
 * Окно «Объединить в одну машину»: разные поставщики — предупреждение, а не
 * запрет (решение 25.11.2026). Машина из документов разных поставщиков — то же,
 * что загрузка одной отправкой: менеджер видит, кто в ней, и может объединить.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineMergePreviewResponse } from '@matcheck/contracts';
import { MachineMergeModal } from './MachineMergeModal';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEAD_A = '33333333-3333-4333-8333-333333333333';
const HEAD_B = '44444444-4444-4444-8444-444444444444';

let preview: MachineMergePreviewResponse;

vi.mock('./useMachineMerge', () => ({
  useMachineMergePreview: () => ({
    data: preview,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useMachineMergeMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

function machine(headId: string, docId: string, supplierName: string) {
  return {
    headId,
    uploads: [{ rootId: headId, uploadedAt: '2026-11-25T10:57:00Z' }],
    merged: false,
    documents: [
      {
        id: docId,
        kind: 'upd',
        docNumber: docId === A ? 'М-1789' : '1001',
        docDate: '2026-11-25',
        status: 'parsed',
        supplierName,
      },
    ],
  };
}

function basePreview(): MachineMergePreviewResponse {
  return {
    machines: [machine(HEAD_A, A, 'ООО «Альтернатива»'), machine(HEAD_B, B, 'ООО «Гаскар»')],
    targetHeadId: HEAD_A,
    alreadyOneMachine: false,
    documentIds: [A, B],
    siteId: null,
    siteName: 'TEST',
    expectedDate: '2026-11-25',
    blockers: [],
    blockerMessages: [],
    warnings: [],
  };
}

afterEach(cleanup);

describe('MachineMergeModal — разные поставщики', () => {
  it('предупреждение со списком поставщиков, кнопка «Объединить» доступна', () => {
    preview = {
      ...basePreview(),
      warnings: [
        {
          code: 'different_suppliers',
          values: [
            { value: 'a', label: 'ООО «Альтернатива»', documentIds: [A] },
            { value: 'b', label: 'ООО «Гаскар»', documentIds: [B] },
          ],
        },
      ],
    };
    render(<MachineMergeModal documentIds={[A, B]} onClose={() => {}} onMerged={() => {}} />);

    expect(
      screen.getByText('Документы разных поставщиков: ООО «Альтернатива», ООО «Гаскар»'),
    ).toBeTruthy();
    expect(screen.queryByText('Объединить нельзя')).toBeNull();
    const button = screen.getByRole('button', { name: 'Объединить' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('один поставщик — предупреждения нет', () => {
    preview = basePreview();
    render(<MachineMergeModal documentIds={[A, B]} onClose={() => {}} onMerged={() => {}} />);

    expect(screen.queryByText(/Документы разных поставщиков/)).toBeNull();
  });
});
