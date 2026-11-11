// @vitest-environment jsdom
/**
 * Окно выбора договора 1С: отборы уходят на сервер, пустое состояние с ИНН и
 * без, метки объекта, выбор без договора и замена с подтверждением. Ожидаемый
 * договор фиксируется при нажатии «Выбрать»: если, пока открыто подтверждение,
 * данные сменились на C, PUT всё равно уходит с A, и сервер отвечает 409.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ContractCandidate,
  ContractCandidatesResponse,
  DeliveryContract,
  DeliveryContractResponse,
} from '@matcheck/contracts';

class ApiErrorMock extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
  }
}

const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock('../../services/api', () => ({ api: { get: apiGet, put: apiPut }, ApiError: ApiErrorMock }));

const { LinkContractModal } = await import('./LinkContractModal');

function candidate(patch: Partial<ContractCandidate> = {}): ContractCandidate {
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
    supplierMatch: true,
    siteMatch: 'match',
    missing: false,
    current: false,
    ...patch,
  };
}

function current(patch: Partial<DeliveryContract> = {}): DeliveryContract {
  const { current: _c, ...base } = candidate();
  return { ...base, linkedAt: '2026-11-10T10:00:00.000Z', linkedByName: null, kindChanged: false, ...patch };
}

function response(items: ContractCandidate[], ctx: Partial<ContractCandidatesResponse['context']> = {}) {
  return {
    items,
    total: items.length,
    context: {
      documentId: null,
      supplierInns: ['7716951747'],
      supplierKnown: true,
      filteredBySupplier: true,
      siteCode: 'ЗИЛ33',
      supplierContractsTotal: items.length,
      importedAt: '2026-11-10T09:00:00.000Z',
      ...ctx,
    },
  } satisfies ContractCandidatesResponse;
}

const okResponse = (contract: DeliveryContract | null): DeliveryContractResponse => ({
  contract,
  perDocument: false,
  documents: [],
  catalog: { total: 3, importedAt: null },
});

function renderModal(
  props: { open?: boolean; current?: DeliveryContract | null; onClose?: () => void; documentId?: string } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = props.onClose ?? vi.fn();
  const view = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <LinkContractModal
        open={p.open ?? true}
        deliveryId="d1"
        documentId={p.documentId ?? null}
        documentLabel={p.documentId ? 'УПД № 201/211153746-24' : null}
        current={p.current ?? null}
        onClose={onClose}
      />
    </QueryClientProvider>
  );
  const utils = render(view(props));
  return { client, onClose, rerender: (p: typeof props) => utils.rerender(view(p)) };
}

const lastUrl = () => String(apiGet.mock.calls.at(-1)?.[0] ?? '');

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPut.mockReset();
});

describe('LinkContractModal', () => {
  it('запрос по умолчанию и «Все поставщики»', async () => {
    apiGet.mockResolvedValue(response([candidate()]));
    renderModal();
    await screen.findByText(/СУ-ЗИЛ33\/25-33 · 26\.08\.2025/);
    expect(lastUrl()).toBe('/deliveries/d1/contract-candidates?limit=20&offset=0');
    fireEvent.click(screen.getByRole('switch', { name: 'Все поставщики' }));
    await waitFor(() => expect(lastUrl()).toContain('allSuppliers=1'));
  });

  it('ИНН известен, договоров нет — пустое состояние и переход к поиску по всем', async () => {
    apiGet.mockResolvedValue(response([]));
    renderModal();
    const empty = await screen.findByTestId('contract-empty-supplier');
    expect(empty.textContent).toContain('договоров с ИНН 7716951747 нет');
    fireEvent.click(screen.getByRole('button', { name: 'Искать среди всех договоров' }));
    await waitFor(() => expect(lastUrl()).toContain('allSuppliers=1'));
  });

  it('ИНН неизвестен — подсказка искать, переключателя нет', async () => {
    apiGet.mockResolvedValue(
      response([candidate({ supplierMatch: null })], { supplierInns: [], supplierKnown: false, filteredBySupplier: false }),
    );
    renderModal();
    await waitFor(() =>
      expect(screen.getByTestId('contract-modal-context').textContent).toContain('Поставщик приёмки не определён'),
    );
    expect(screen.queryByRole('switch', { name: 'Все поставщики' })).toBeNull();
  });

  it('метки объекта: спорный и группа', async () => {
    apiGet.mockResolvedValue(
      response([
        candidate({ siteStatus: 'conflict', siteMatch: 'conflict', siteCodes: ['ПРИМ13', 'ПРИМ22'] }),
        candidate({ siteStatus: 'group', siteMatch: 'group', siteCodes: ['ЗИЛ18', 'ЗИЛ33'] }),
      ]),
    );
    renderModal();
    expect(await screen.findByText('спорный: ПРИМ13 / ПРИМ22')).toBeTruthy();
    expect(screen.getByText('группа: ЗИЛ18, ЗИЛ33')).toBeTruthy();
  });

  it('без текущего договора — PUT сразу, replaceContractId = null', async () => {
    const c = candidate();
    apiGet.mockResolvedValue(response([c]));
    apiPut.mockResolvedValue(okResponse(null));
    const { onClose, client } = renderModal();
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/deliveries/d1/contract', { contractId: c.id, replaceContractId: null }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(client.getQueryData(['delivery-contract', 'd1'])).toEqual(okResponse(null));
  });

  it('замена — подтверждение и PUT с текущим договором', async () => {
    const a = current();
    const b = candidate({ number: 'СУ-ЗИЛ33/25-40' });
    apiGet.mockResolvedValue(response([b]));
    apiPut.mockResolvedValue(okResponse(null));
    renderModal({ current: a });
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Заменить' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/deliveries/d1/contract', { contractId: b.id, replaceContractId: a.id }),
    );
  });

  it('данные сменились во время подтверждения — PUT уходит с A, на 409 сообщение и перечитка', async () => {
    const a = current();
    const c = current({ number: 'СУ-ЗИЛ33/25-77' });
    const b = candidate({ number: 'СУ-ЗИЛ33/25-40' });
    apiGet.mockResolvedValue(response([b]));
    apiPut.mockRejectedValue(
      new ApiErrorMock(409, 'contract_changed', 'changed', {
        error: 'contract_changed',
        message: 'changed',
        current: c,
      }),
    );
    const { rerender, client } = renderModal({ current: a });
    const spy = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать' }));
    await screen.findByRole('button', { name: 'Заменить' });
    // Пока открыто подтверждение, опрос карточки принёс чужую замену на C.
    rerender({ current: c });
    fireEvent.click(screen.getByRole('button', { name: 'Заменить' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/deliveries/d1/contract', { contractId: b.id, replaceContractId: a.id }),
    );
    expect(await screen.findByText(/уже изменил другой пользователь: «СУ-ЗИЛ33\/25-77/)).toBeTruthy();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['delivery-contract', 'd1'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['delivery-contract-candidates', 'd1'] });
  });

  it('договор документа: documentId в запросе кандидатов и в PUT, заголовок с номером УПД', async () => {
    const c = candidate();
    apiGet.mockResolvedValue(response([c], { documentId: 'doc-1' }));
    apiPut.mockResolvedValue(okResponse(null));
    renderModal({ documentId: 'doc-1' });
    expect(await screen.findByText('Договор 1С для УПД № 201/211153746-24')).toBeTruthy();
    await waitFor(() => expect(lastUrl()).toBe('/deliveries/d1/contract-candidates?limit=20&offset=0&documentId=doc-1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать' }));
    await waitFor(() =>
      expect(apiPut).toHaveBeenCalledWith('/deliveries/d1/contract', {
        contractId: c.id,
        replaceContractId: null,
        documentId: 'doc-1',
      }),
    );
  });

  it('закрытое окно не запрашивает; повторное открытие — новый запрос', async () => {
    apiGet.mockResolvedValue(response([candidate()]));
    const { rerender } = renderModal({ open: false });
    expect(apiGet).not.toHaveBeenCalled();
    rerender({ open: true });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });
});
