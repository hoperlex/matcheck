// @vitest-environment jsdom
/**
 * Договор строки УПД: «+ Договор» без своего (подсказка — какой общий действует),
 * чип своего договора с отвязкой по договору, который человек видел, и без права
 * выбора — только чип.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryContract } from '@matcheck/contracts';
import { DocumentContractControl } from './DocumentContractControl';

function contract(patch: Partial<DeliveryContract> = {}): DeliveryContract {
  return {
    id: crypto.randomUUID(),
    onecId: crypto.randomUUID(),
    counterpartyName: 'РУТЕК ООО',
    counterpartyInn: '7716951747',
    name: 'Автозаводская ул., вл.23/2 ЖК ЗИЛАРТ (ЛОТ 33), ДГ №СУ-ЗИЛ33/25-33 от 26.08.25',
    number: 'СУ-ЗИЛ33/25-33',
    contractDate: '2025-08-26',
    kind: 'supplier',
    objectText: null,
    siteStatus: 'exact',
    siteCodes: ['ЗИЛ33'],
    missingSince: null,
    linkedAt: '2026-11-11T10:00:00.000Z',
    linkedByName: null,
    supplierMatch: true,
    siteMatch: 'match',
    kindChanged: false,
    missing: false,
    ...patch,
  };
}

afterEach(() => cleanup());

describe('DocumentContractControl', () => {
  it('своего нет — «+ Договор», подсказка с общим договором, клик открывает подбор', async () => {
    const onPick = vi.fn();
    render(
      <DocumentContractControl
        own={null}
        general={contract({ number: 'СУ-ЗИЛ/25-40' })}
        canLink
        onPick={onPick}
        onUnlink={vi.fn()}
      />,
    );
    const btn = screen.getByTestId('document-contract-add');
    fireEvent.mouseEnter(btn);
    expect(await screen.findByText(/Сейчас действует общий договор приёмки: СУ-ЗИЛ\/25-40/)).toBeTruthy();
    fireEvent.click(btn);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('своего и общего нет — подсказка «Общий договор приёмки не выбран»', async () => {
    render(<DocumentContractControl own={null} general={null} canLink onPick={vi.fn()} onUnlink={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByTestId('document-contract-add'));
    expect(await screen.findByText('Общий договор приёмки не выбран')).toBeTruthy();
  });

  it('свой есть — чип; «Отвязать» уходит с id своего договора', async () => {
    const onUnlink = vi.fn();
    const own = contract();
    render(<DocumentContractControl own={own} general={null} canLink onPick={vi.fn()} onUnlink={onUnlink} />);
    expect(screen.queryByTestId('document-contract-add')).toBeNull();
    fireEvent.click(screen.getByTestId('contract-chip'));
    fireEvent.click(await screen.findByRole('button', { name: /Отвязать/ }));
    const confirm = await screen.findAllByRole('button', { name: 'Отвязать' });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(onUnlink).toHaveBeenCalledWith(own.id));
  });

  it('без права выбора: своего нет — ничего; свой есть — чип без кнопок', async () => {
    const { container, rerender } = render(
      <DocumentContractControl own={null} general={contract()} canLink={false} onPick={vi.fn()} onUnlink={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
    rerender(
      <DocumentContractControl own={contract()} general={null} canLink={false} onPick={vi.fn()} onUnlink={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('contract-chip'));
    await screen.findByTestId('contract-chip-details');
    expect(screen.queryByText('Отвязать')).toBeNull();
    expect(screen.queryByText('Заменить')).toBeNull();
  });
});
