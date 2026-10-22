// @vitest-environment jsdom
/**
 * Цена с НДС в карточке УПД.
 *
 * В бланке такой графы нет: форма 1137 содержит цену за единицу только без
 * налога (графа 4), а с налогом — лишь стоимость всей строки (графа 9). Раньше
 * рядом стояли цена без налога и сумма с налогом, и арифметика на экране не
 * сходилась: 15 × 240 против показанных 4 392. Для менеджера это выглядело
 * ошибкой распознавания, хотя оба числа прочитаны верно.
 *
 * Главное, что здесь охраняется: цена, которую никто не трогал, не меняется.
 * Без правок позиции не уходят вовсе; с правкой другой графы строка уходит с
 * ИСХОДНОЙ ценой бланка. Пересчёт туда-обратно расходится примерно у одной
 * позиции из тысячи, и прогон всего списка через него означал бы тихую правку
 * цен, которых никто не касался.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageAction, PageId } from '@matcheck/contracts';
import type { ReactElement } from 'react';

/** Боевой УПД № 203368: 15 шт по 240 ₽ без налога, стоимость с налогом 4 392 ₽. */
const upd = {
  id: '11111111-1111-1111-1111-111111111111',
  kind: 'upd',
  direction: 'inbound',
  status: 'parsed',
  origin: 'manual_pdf',
  docNumber: '203368',
  docDate: '2026-08-26',
  expectedDate: null,
  totalSum: '4392.00',
  vatSum: '792.00',
  supplierName: 'ООО «КОРОЛЕВСКАЯ ВОДА»',
  items: [
    {
      id: 'i1',
      lineNo: 1,
      nameRaw: 'Вода питьевая Королевская вода 19л',
      qty: '15',
      unit: 'шт',
      price: '240',
      sum: '4392.00',
      vatRate: '22',
      vatSum: '792.00',
    },
  ],
  attachments: [],
  extraFiles: [],
  validation: null,
};

/** Тот же документ, но накладная: цену с налогом там не показываем. */
const waybill = { ...upd, id: '22222222-2222-2222-2222-222222222222', kind: 'transport_waybill' };

/**
 * Тот же УПД, но ещё в обработке.
 *
 * Форма редактирования открывается сразу, как только документ разобран, — то
 * есть таблица «только для чтения» видна лишь у документов в работе и у
 * дубликатов. Чтобы проверить именно её, документ приходится показать
 * необработанным.
 */
const processing = { ...upd, id: '33333333-3333-3333-3333-333333333333', status: 'processing' };

const patch = vi.fn((_path: string, _body?: unknown) => Promise.resolve(upd));
let current: typeof upd = upd;

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url.includes('/responsible-persons')) return Promise.resolve({ items: [], total: 0 });
      // Справочник единиц: без него UnitSelect получал бы позиции документа
      // и падал на отсутствующем `code`.
      if (url.startsWith('/units')) return Promise.resolve({ items: [], total: 0 });
      if (url.endsWith('/file')) return Promise.reject(new Error('no file'));
      return Promise.resolve(current);
    }),
    post: vi.fn(),
    patch: (...args: unknown[]) => patch(...(args as [string, unknown])),
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

afterEach(() => {
  cleanup();
  patch.mockClear();
  current = upd;
});

/**
 * Шапка таблицы позиций. Подписи ищем в ней, а не по всей странице: у таблицы
 * с прокруткой вбок rc-table держит в теле скрытую строку замера ширины с теми
 * же подписями.
 */
function tableHead(): HTMLElement {
  return document.querySelector<HTMLElement>('.ant-table-thead')!;
}

describe('карточка УПД — цена с НДС', () => {
  it('показывает цену с налогом, и она сходится с суммой строки', async () => {
    current = processing;
    render(wrap(<SourceDocumentDetailModal id={processing.id} open onClose={() => {}} />));

    // 240 × 1,22 = 292,80, и 15 × 292,80 = 4 392 — ровно та сумма, что рядом.
    expect(await screen.findByText(/292,80/)).toBeTruthy();
    // Заголовок называет величину прямо: в приёмке цена остаётся без налога,
    // и одинаковое имя над разными числами читалось бы как расхождение.
    expect(within(tableHead()).getByText('Цена с НДС')).toBeTruthy();
    // Исходной цены бланка в таблице позиций быть не должно — иначе непонятно,
    // какое из двух чисел настоящее.
    expect(screen.queryByText('240,00 ₽')).toBeNull();
  });

  it('у накладной колонка прежняя — пересчёт только для УПД', async () => {
    current = { ...waybill, status: 'processing' };
    render(wrap(<SourceDocumentDetailModal id={waybill.id} open onClose={() => {}} />));

    await screen.findByText('240,00 ₽');
    expect(within(tableHead()).getByText('Цена')).toBeTruthy();
    expect(screen.queryByText('Цена с НДС')).toBeNull();
    expect(screen.getByText('240,00 ₽')).toBeTruthy();
  });

  it('СОХРАНЕНИЕ БЕЗ ПРАВОК не отправляет позиции вовсе', async () => {
    // Главная страховка правки. Пользователь открыл карточку, ничего не трогал
    // и нажал «Сохранить» — цены в базе не меняются. Раньше это держалось на
    // обратном пересчёте (в тело уходила цена бланка), теперь сильнее:
    // нетронутые позиции в тело не попадают и сервер их не пересоздаёт —
    // иначе рвались бы связи строк приёмки с позициями документа.
    render(wrap(<SourceDocumentDetailModal id={upd.id} open onClose={() => {}} />));

    // Разобранный документ открывается сразу в режиме правки: в поле цены
    // стоит 292,80 — цена с налогом.
    const field = await screen.findByDisplayValue('292,8');
    expect(field).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Сохранить/i }));

    expect(await screen.findByText('Изменений нет')).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it('правка другой графы строки: цена уходит бланковой, ставка возвращается', async () => {
    // Когда позиции всё же уходят (правили название), нетронутая цена обязана
    // остаться ценой бланка (240), а не показанной на экране (292,80). Плюс
    // ставка должна вернуться на сервер: без неё PATCH обнулял НДС у позиций.
    render(wrap(<SourceDocumentDetailModal id={upd.id} open onClose={() => {}} />));
    await screen.findByDisplayValue('292,8');

    fireEvent.change(screen.getByDisplayValue('Вода питьевая Королевская вода 19л'), {
      target: { value: 'Вода питьевая Королевская вода 19 л' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/i }));

    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0]![1] as { items: Array<Record<string, unknown>> };
    // Ушли только позиции — шапку никто не трогал.
    expect(Object.keys(body)).toEqual(['items']);
    expect(body.items[0]!.price).toBe('240');
    expect(body.items[0]!.vatRate).toBe('22');
  });

  it('цена с четырьмя знаками не портится при сохранении', async () => {
    // Боевой случай: 11 позиций за месяц имеют больше двух знаков, а поле
    // показывает только два. Без защиты сохранение карточки переписывало бы
    // 66,294 на 66,3 — молча и на каждой правке.
    //
    // Пересчёт в обе стороны проверен отдельно в priceWithVat.test.ts; здесь
    // важно, что карточка отдаёт на сервер ИСХОДНОЕ значение, а не показанное.
    current = { ...upd, items: [{ ...upd.items[0]!, price: '66.294', vatRate: '22' }] };
    render(wrap(<SourceDocumentDetailModal id={upd.id} open onClose={() => {}} />));
    await screen.findByDisplayValue(/80,88/);

    // Позиции уходят только после правки — меняем название, цену не трогаем.
    fireEvent.change(screen.getByDisplayValue('Вода питьевая Королевская вода 19л'), {
      target: { value: 'Вода 19 л' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    const body = patch.mock.calls[0]![1] as { items: Array<Record<string, unknown>> };
    expect(body.items[0]!.price).toBe('66.294');
  });
});
