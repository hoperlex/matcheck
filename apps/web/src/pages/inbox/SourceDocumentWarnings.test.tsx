// @vitest-environment jsdom
/**
 * Блок «Проверьте строки по документу» в карточке распознанного документа.
 *
 * Подозрение на перестановку количества и цены приходит с сервера отдельным
 * полем `validation.warnings` — намеренно не через `checks`, чтобы не выглядеть
 * доказанной арифметической ошибкой. Тест держит два свойства: подозрение
 * видно оператору и оно не подмешивается к блоку «Расхождения в суммах».
 */
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageAction, PageId } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const detail = {
  id: '11111111-1111-1111-1111-111111111111',
  kind: 'upd',
  direction: 'inbound',
  status: 'parsed',
  origin: 'manual_pdf',
  docNumber: '848',
  docDate: '2026-08-18',
  expectedDate: null,
  totalSum: '656310.60',
  vatSum: '118351.09',
  supplierName: 'ООО «Поставщик»',
  items: [
    { id: 'i1', lineNo: 1, nameRaw: 'Профнастил', qty: '200', unit: 'м2', price: '451.68', sum: '90336.07' },
    { id: 'i2', lineNo: 2, nameRaw: 'Триплекс', qty: '8114.75', unit: 'м2', price: '66.294', sum: '537959.51' },
  ],
  attachments: [],
  extraFiles: [],
  validation: {
    hasMismatch: false,
    checkedAt: '2026-08-18T13:00:00.000Z',
    checks: [],
    warnings: [{ name: 'qty_price_swap', scope: { row: 2 } }],
  },
};

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url.includes('/responsible-persons')) return Promise.resolve({ items: [], total: 0 });
      if (url.endsWith('/file')) return Promise.reject(new Error('no file'));
      return Promise.resolve(detail);
    }),
    post: vi.fn(),
    patch: vi.fn(),
  },
  apiDownload: vi.fn(),
  ApiError: class ApiError extends Error {
    status = 404;
  },
}));

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: (_page: PageId, _action: PageAction) => true,
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: () => true,
    enforced: true,
    loading: false,
  }),
}));

vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: 'manager' } }),
}));

const { SourceDocumentDetailModal } = await import('./SourceDocumentDetailModal');

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

afterEach(cleanup);

describe('карточка документа — подозрение на перестановку', () => {
  it('показывает предупреждение с номером строки', async () => {
    render(wrap(<SourceDocumentDetailModal id={detail.id} open onClose={() => {}} />));

    expect(await screen.findByText('Проверьте строки по документу')).toBeTruthy();
    expect(
      screen.getByText(/количество и цена стоят не в своих колонках \(строка 2\)/),
    ).toBeTruthy();
    // Это не арифметическое расхождение: блока «Расхождения в суммах» нет.
    expect(screen.queryByText('Расхождения в суммах')).toBeNull();
  });
});
