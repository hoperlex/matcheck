// @vitest-environment jsdom
/**
 * Чип «Договор»: подсветка по флагам сервера, «Отвязать» отправляет договор,
 * который человек видел при открытии подтверждения (а не тот, что принёс опрос),
 * и хук карточки: опрос раз в 30 с даже без договора — первый импорт делает
 * справочник непустым без перезагрузки.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryContract, DeliveryContractResponse } from '@matcheck/contracts';

const apiGet = vi.fn();
vi.mock('../../services/api', () => ({ api: { get: apiGet } }));

const { ContractChip } = await import('./ContractChip');
const { useDeliveryContract, DELIVERY_CONTRACT_REFRESH_MS } = await import('./useDeliveryContract');

function contractFixture(patch: Partial<DeliveryContract> = {}): DeliveryContract {
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
    linkedAt: '2026-11-10T10:00:00.000Z',
    linkedByName: 'Иванов',
    supplierMatch: true,
    siteMatch: 'match',
    kindChanged: false,
    missing: false,
    ...patch,
  };
}

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  vi.useRealTimers();
});

describe('ContractChip', () => {
  it('без договора чипа нет', () => {
    const { container } = render(<ContractChip contract={null} />);
    expect(container.textContent).toBe('');
  });

  it('подпись — номер и дата; всё сходится — без подсветки', () => {
    render(<ContractChip contract={contractFixture()} />);
    const chip = screen.getByTestId('contract-chip');
    expect(chip.textContent).toContain('СУ-ЗИЛ33/25-33 от 26.08.2025');
    expect(chip.dataset.warn).toBe('false');
  });

  it('номер «Оплата по счету» — подпись по наименованию', () => {
    render(
      <ContractChip
        contract={contractFixture({ number: 'Оплата по счету', name: 'Раменки р-н, СОБЫТИЕ 6, Оплата по счету (08.06.26)' })}
      />,
    );
    expect(screen.getByTestId('contract-chip').textContent).toContain('Раменки р-н, СОБЫТИЕ 6');
  });

  it.each([
    ['другой поставщик', { supplierMatch: false }],
    ['другой объект', { siteMatch: 'other' as const }],
    ['спорный объект', { siteMatch: 'conflict' as const, siteStatus: 'conflict' as const, siteCodes: ['ПРИМ13', 'ПРИМ22'] }],
    ['сменился вид', { kindChanged: true }],
    ['пропал из выгрузки', { missing: true }],
  ])('подсветка: %s', (_label, patch) => {
    render(<ContractChip contract={contractFixture(patch)} />);
    expect(screen.getByTestId('contract-chip').dataset.warn).toBe('true');
  });

  it('ИНН поставщика неизвестен (supplierMatch=null) — не подсветка', () => {
    render(<ContractChip contract={contractFixture({ supplierMatch: null, siteMatch: 'unknown' })} />);
    expect(screen.getByTestId('contract-chip').dataset.warn).toBe('false');
  });

  it('без прав — без кнопок', async () => {
    render(<ContractChip contract={contractFixture()} />);
    fireEvent.click(screen.getByTestId('contract-chip'));
    await screen.findByTestId('contract-chip-details');
    expect(screen.queryByText('Отвязать')).toBeNull();
    expect(screen.queryByText('Заменить')).toBeNull();
  });

  it('«Отвязать» уходит с договором, который был при открытии подтверждения', async () => {
    const onUnlink = vi.fn();
    const a = contractFixture();
    const c = contractFixture({ number: 'СУ-ЗИЛ33/25-99' });
    const { rerender } = render(<ContractChip contract={a} onUnlink={onUnlink} />);
    fireEvent.click(screen.getByTestId('contract-chip'));
    fireEvent.click(await screen.findByRole('button', { name: /Отвязать/ }));
    // Пока подтверждение открыто, опрос принёс чужую замену на C.
    rerender(<ContractChip contract={c} onUnlink={onUnlink} />);
    const confirm = await screen.findAllByRole('button', { name: 'Отвязать' });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(onUnlink).toHaveBeenCalledWith(a.id));
  });
});

function Probe({ deliveryId }: { deliveryId: string }) {
  const q = useDeliveryContract(deliveryId, true);
  return <span data-testid="total">{q.data ? String(q.data.catalog.total) : '—'}</span>;
}

describe('useDeliveryContract', () => {
  it('опрос раз в 30 с без договора: пустой справочник → после импорта total > 0', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const empty: DeliveryContractResponse = {
      contract: null,
      perDocument: false,
      documents: [],
      catalog: { total: 0, importedAt: null },
    };
    const full: DeliveryContractResponse = {
      contract: null,
      perDocument: false,
      documents: [],
      catalog: { total: 6007, importedAt: '2026-11-10T12:00:00.000Z' },
    };
    apiGet.mockResolvedValueOnce(empty).mockResolvedValue(full);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Probe deliveryId="d1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('total').textContent).toBe('0'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELIVERY_CONTRACT_REFRESH_MS + 50);
    });
    await waitFor(() => expect(screen.getByTestId('total').textContent).toBe('6007'));
    expect(apiGet).toHaveBeenCalledWith('/deliveries/d1/contract');
  });

  it('договор сменился в опросе — кандидаты окна перечитываются', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const a = contractFixture();
    const c = contractFixture();
    apiGet
      .mockResolvedValueOnce({ contract: a, perDocument: false, documents: [], catalog: { total: 2, importedAt: null } })
      .mockResolvedValue({ contract: c, perDocument: false, documents: [], catalog: { total: 2, importedAt: null } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, 'invalidateQueries');
    render(
      <QueryClientProvider client={client}>
        <Probe deliveryId="d2" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('total').textContent).toBe('2'));
    expect(spy).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DELIVERY_CONTRACT_REFRESH_MS + 50);
    });
    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ['delivery-contract-candidates', 'd2'] }),
    );
  });
});
