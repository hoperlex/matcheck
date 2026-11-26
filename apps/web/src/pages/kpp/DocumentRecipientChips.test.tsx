// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Delivery } from '@matcheck/contracts';
import { DocumentRecipientChips } from './DocumentRecipientChips';
import { chipText } from '../../test/chipText';

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
    expect(screen.getByText(chipText(/Получатель: как у приёмки: МОЛ: Иванов Иван/))).toBeTruthy();
    expect(screen.getByText(chipText(/Признак: как у приёмки: Свои силы/))).toBeTruthy();
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
    expect(screen.getByText(chipText(/Получатель: Подрядчик: ООО Подрядчик/))).toBeTruthy();
    expect(screen.getByText(chipText(/Признак: — не выбран/))).toBeTruthy();
    expect(screen.queryByText(chipText(/Признак: как у приёмки/))).toBeNull();
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
    fireEvent.click(screen.getByText(chipText(/Признак: — не выбран/)));
    await waitFor(() => expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0));
    expect(screen.queryByText('1 Свои силы')).toBeNull();
    expect(
      screen.getByText('Вернуть общий признак').closest('[aria-disabled="true"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('2 Реализация'));
    expect(onPurpose).toHaveBeenCalledWith({ purpose: 'realization' });
  });

  it('УПД из ЭДО без скана (0152): значения из edoDocuments, не из записей сканов', async () => {
    const EDO = '44444444-4444-4444-8444-444444444444';
    const delivery = {
      ...base,
      // Запись скана с тем же id не должна подхватиться для УПД из ЭДО.
      documentRecipients: [
        {
          sourceDocumentId: EDO,
          ownRecipient: true,
          contractorId: CONTRACTOR,
          contractorName: 'Чужой скан',
          recipientMolId: null,
          recipientMolName: null,
          ownPurpose: false,
          purpose: null,
        },
      ],
      edoDocuments: [
        {
          matchId: EDO,
          operator: 'diadoc',
          docNumber: '201/21126982-2332',
          docDate: '2026-10-29',
          ownRecipient: true,
          contractorId: CONTRACTOR,
          contractorName: 'ООО КС',
          recipientMolId: null,
          recipientMolName: null,
          ownPurpose: true,
          purpose: 'tolling_act',
        },
      ],
    } as unknown as Delivery;
    const onPurpose = vi.fn();
    render(
      <DocumentRecipientChips
        delivery={delivery}
        edoMatchId={EDO}
        canEditRecipient={false}
        canPickContractor={false}
        canEditPurpose
        mols={[]}
        molsLoading={false}
        onRecipient={vi.fn()}
        onPurpose={onPurpose}
      />,
    );
    expect(screen.getByText(chipText(/Получатель: Подрядчик: ООО КС/))).toBeTruthy();
    expect(screen.queryByText(/Чужой скан/)).toBeNull();
    fireEvent.click(screen.getByText(chipText(/Признак: Давальческий акт/)));
    await waitFor(() => expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('2 Реализация'));
    expect(onPurpose).toHaveBeenCalledWith({ purpose: 'realization' });
  });
});
