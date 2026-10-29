// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Delivery } from '@matcheck/contracts';
import { DocumentRecipientChips } from './DocumentRecipientChips';

const DOC = '11111111-1111-4111-8111-111111111111';
const CONTRACTOR = '22222222-2222-4222-8222-222222222222';
const MOL = '33333333-3333-4333-8333-333333333333';
const base = {
  contractorId: null,
  contractorName: null,
  recipientMolId: MOL,
  recipientMolName: 'Иванов Иван',
  purpose: 'own_forces',
  recipientsPerDocument: true,
  documentRecipients: [],
} as unknown as Delivery;

afterEach(cleanup);

describe('чипы получателя и признака УПД', () => {
  it('показывают наследование каждого поля отдельно', () => {
    render(
      <DocumentRecipientChips
        delivery={base}
        docId={DOC}
        canEditRecipient={false}
        canPickContractor={false}
        canEditPurpose={false}
        mols={[]}
        molsLoading={false}
        onRecipient={vi.fn()}
        onPurpose={vi.fn()}
      />,
    );
    expect(screen.getByText(/Получатель: как у приёмки: МОЛ: Иванов Иван/)).toBeTruthy();
    expect(screen.getByText(/Признак: как у приёмки: Свои силы/)).toBeTruthy();
  });

  it('собственный NULL не подменяется общим признаком', () => {
    const delivery = {
      ...base,
      documentRecipients: [
        {
          sourceDocumentId: DOC,
          ownRecipient: true,
          contractorId: CONTRACTOR,
          contractorName: 'ООО Подрядчик',
          recipientMolId: null,
          recipientMolName: null,
          ownPurpose: true,
          purpose: null,
        },
      ],
    } as Delivery;
    render(
      <DocumentRecipientChips
        delivery={delivery}
        docId={DOC}
        canEditRecipient={false}
        canPickContractor={false}
        canEditPurpose={false}
        mols={[]}
        molsLoading={false}
        onRecipient={vi.fn()}
        onPurpose={vi.fn()}
      />,
    );
    expect(screen.getByText(/Получатель: Подрядчик: ООО Подрядчик/)).toBeTruthy();
    expect(screen.getByText(/Признак: — не выбран/)).toBeTruthy();
    expect(screen.queryByText(/Признак: как у приёмки/)).toBeNull();
  });

  it('для своего подрядчика не предлагает «Свои силы» и не даёт наследовать конфликтный общий признак', async () => {
    const delivery = {
      ...base,
      documentRecipients: [
        {
          sourceDocumentId: DOC,
          ownRecipient: true,
          contractorId: CONTRACTOR,
          contractorName: 'ООО Подрядчик',
          recipientMolId: null,
          recipientMolName: null,
          ownPurpose: true,
          purpose: null,
        },
      ],
    } as Delivery;
    const onPurpose = vi.fn();
    render(
      <DocumentRecipientChips
        delivery={delivery}
        docId={DOC}
        canEditRecipient={false}
        canPickContractor={false}
        canEditPurpose
        mols={[]}
        molsLoading={false}
        onRecipient={vi.fn()}
        onPurpose={onPurpose}
      />,
    );
    fireEvent.click(screen.getByText(/Признак: — не выбран/));
    await waitFor(() => expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0));
    expect(screen.queryByText('1 Свои силы')).toBeNull();
    expect(
      screen.getByText('Вернуть общий признак').closest('[aria-disabled="true"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('2 Реализация'));
    expect(onPurpose).toHaveBeenCalledWith({ purpose: 'realization' });
  });
});
