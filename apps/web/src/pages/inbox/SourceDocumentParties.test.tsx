// @vitest-environment jsdom
/**
 * Стороны документа в карточке приёмки: грузополучатель и покупатель.
 *
 * Мониторинг и админ задают их, когда распознавание не нашло сторону или
 * ошиблось. Источник — справочник заказчика, а если организации там нет —
 * ручной ввод названия и ИНН.
 *
 * Тест держит цепочку до тела PATCH: что именно уходит на сервер. Главное —
 * сторона уходит только изменённой, ИНН из справочника — цифрами (там он
 * свободный текст), битый ИНН не уходит вовсе, а без права «Редактировать»
 * блок остаётся текстом.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageAction, PageId } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const base = {
  id: '22222222-2222-2222-2222-222222222222',
  kind: 'upd',
  direction: 'inbound',
  status: 'parsed',
  origin: 'manual_pdf',
  docNumber: 'ТР-12296',
  docDate: '2026-08-25',
  expectedDate: '2026-08-26',
  totalSum: '60263.00',
  vatSum: null,
  supplierName: 'ООО «РУТЕК»',
  buyerName: null as string | null,
  buyerInn: null as string | null,
  consigneeName: null as string | null,
  consigneeInn: null as string | null,
  contractorId: null,
  recipientMolId: null,
  siteId: '44444444-4444-4444-4444-444444444444',
  siteName: 'ЖК ИНДЖОЙ',
  portalGroupId: null,
  portalGroupSize: null,
  items: [{ id: 'i1', lineNo: 1, nameRaw: 'Труба', qty: '1', unit: 'шт', price: '100', sum: '100' }],
  attachments: [],
  extraFiles: [],
  validation: { hasMismatch: false, checkedAt: null, checks: [], warnings: [] },
};

/** Справочник заказчика: ИНН там — свободный текст, бывает и битый. */
const directory = [
  {
    id: 'cc-1',
    inn: '77 36-255508',
    name: 'СУ-10',
    aliases: ['Строительное управление 10'],
    address: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'cc-2',
    // Контрольная цифра должна быть 9 — так его прочитало распознавание.
    inn: '7736255087',
    name: 'Стройуправление-10',
    aliases: [],
    address: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

let detail: typeof base = base;
let canEdit = true;
const patch = vi.fn((_path: string, _body?: unknown) => Promise.resolve(detail));

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url.includes('/customer-counterparties')) {
        return Promise.resolve({ items: directory, total: directory.length });
      }
      if (url.includes('/responsible-persons')) return Promise.resolve({ items: [], total: 0 });
      if (url.includes('/sites')) return Promise.resolve({ items: [], total: 0 });
      if (url.includes('/units')) return Promise.resolve({ items: [], total: 0 });
      if (url.endsWith('/file')) return Promise.reject(new Error('no file'));
      return Promise.resolve(detail);
    }),
    post: vi.fn(),
    patch: (...args: unknown[]) => patch(...(args as [string, unknown])),
  },
  apiDownload: vi.fn(),
  ApiError: class ApiError extends Error {
    status = 404;
    code = 'not_found';
  },
}));

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: (_page: PageId, action: PageAction) => (action === 'edit' ? canEdit : true),
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: () => true,
    enforced: true,
    loading: false,
  }),
}));

vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { id: 'u1', role: 'monitor' } }),
}));

const { SourceDocumentDetailModal } = await import('./SourceDocumentDetailModal');

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** Реквизиты живут в свёрнутой панели (широкий экран) или на вкладке «Шапка». */
async function openCard(): Promise<void> {
  render(wrap(<SourceDocumentDetailModal id={detail.id} open onClose={() => {}} />));
  await screen.findByText(/ТР-12296|Реквизиты документа|Позиции/);
  const tab = screen.queryByRole('tab', { name: /Шапка/ });
  if (tab) fireEvent.click(tab);
  else fireEvent.click(await screen.findByText('Реквизиты документа'));
  await screen.findByText('Стороны по документу');
}

/** Открыть список стороны и набрать текст поиска. */
function search(side: 'Грузополучатель' | 'Покупатель', text: string): void {
  const box = screen.getByRole('combobox', { name: side });
  fireEvent.mouseDown(box);
  fireEvent.change(box, { target: { value: text } });
}

async function pick(title: string): Promise<void> {
  fireEvent.click(await screen.findByTitle(title));
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
}

async function sentBody(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(patch).toHaveBeenCalled());
  return (patch.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
}

afterEach(() => {
  cleanup();
  patch.mockClear();
  detail = base;
  canEdit = true;
});

describe('карточка приёмки — стороны документа', () => {
  it('выбор из справочника: уходит только грузополучатель, ИНН — цифрами', async () => {
    await openCard();
    search('Грузополучатель', 'строительное');
    // Нашлось по алиасу; в подписи ИНН как в справочнике — с пробелом и дефисом.
    await pick('СУ-10 (ИНН 77 36-255508)');
    save();

    expect(await sentBody()).toEqual({ consignee: { name: 'СУ-10', inn: '7736255508' } });
  });

  it('запись справочника с битым ИНН уходит без ИНН, а не отказом сервера', async () => {
    await openCard();
    search('Грузополучатель', 'стройуправление');
    await pick('Стройуправление-10 (ИНН 7736255087)');
    save();

    expect(await sentBody()).toEqual({ consignee: { name: 'Стройуправление-10', inn: null } });
  });

  it('ввод вручную: название из поиска, ИНН отдельным полем', async () => {
    await openCard();
    search('Покупатель', 'ООО «ЭСТ»');
    await pick('Ввести вручную: «ООО «ЭСТ»»');
    fireEvent.change(screen.getByRole('textbox', { name: 'Покупатель: ИНН' }), {
      target: { value: '7714679380' },
    });
    save();

    expect(await sentBody()).toEqual({ buyer: { name: 'ООО «ЭСТ»', inn: '7714679380' } });
  });

  it('ввод вручную без ИНН — только название', async () => {
    await openCard();
    search('Покупатель', 'ИП Петров');
    await pick('Ввести вручную: «ИП Петров»');
    save();

    expect(await sentBody()).toEqual({ buyer: { name: 'ИП Петров', inn: null } });
  });

  it('битый ИНН: поле подсвечено, на сервер ничего не уходит', async () => {
    await openCard();
    search('Покупатель', 'Стройуправление');
    await pick('Ввести вручную: «Стройуправление»');
    fireEvent.change(screen.getByRole('textbox', { name: 'Покупатель: ИНН' }), {
      target: { value: '7736255087' },
    });

    expect(await screen.findByText(/ИНН не прошёл проверку: нужно 10 или 12 цифр/)).toBeTruthy();
    save();
    expect(await screen.findByText(/ИНН покупателя не прошёл проверку/)).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it('очистка распознанной стороны уходит как null', async () => {
    detail = { ...base, consigneeName: 'ООО "СУ-10"', consigneeInn: '7736255508' };
    await openCard();
    const select = screen.getByRole('combobox', { name: 'Грузополучатель' }).closest('.ant-select');
    const clear = select?.querySelector('.ant-select-clear');
    expect(clear).toBeTruthy();
    fireEvent.mouseDown(clear!);
    save();

    expect(await sentBody()).toEqual({ consignee: null });
  });

  it('нетронутая распознанная сторона не уходит — даже с битым ИНН из документа', async () => {
    // Распознанный ИНН с ошибкой не должен запирать сохранение других полей.
    detail = { ...base, buyerName: 'ООО "СУ-10"', buyerInn: '7736255087' };
    await openCard();
    fireEvent.change(screen.getByDisplayValue('ТР-12296'), { target: { value: 'ТР-12297' } });
    save();

    expect(await sentBody()).toEqual({ docNumber: 'ТР-12297' });
  });

  it('сохранение без правок не отправляет запрос', async () => {
    detail = { ...base, buyerName: 'ООО "СУ-10"', buyerInn: '7736255508' };
    await openCard();
    save();

    expect(await screen.findByText('Изменений нет')).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it('без права «Редактировать» — текст, как раньше', async () => {
    canEdit = false;
    await openCard();

    expect(screen.queryByRole('combobox', { name: 'Грузополучатель' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Покупатель' })).toBeNull();
    expect(screen.getAllByText('не распознан')).toHaveLength(2);
  });
});
