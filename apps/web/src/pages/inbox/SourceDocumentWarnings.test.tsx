// @vitest-environment jsdom
/**
 * Блоки расхождений и подозрений в карточке распознанного документа.
 *
 * Подозрение на перестановку количества и цены приходит с сервера отдельным
 * полем `validation.warnings` — намеренно не через `checks`, чтобы не выглядеть
 * доказанной арифметической ошибкой. Тесты держат три свойства: подозрение
 * видно оператору, оно не подмешивается к блоку «Расхождения в суммах», а
 * длинный перечень сворачивается в одну полосу — иначе он занимает всю высоту
 * модалки и до самого документа (таблица позиций, превью, «Скачать оригинал»)
 * не добраться.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageAction, PageId, UpdCheck, UpdWarning } from '@matcheck/contracts';
import type { ReactElement } from 'react';

const VALIDATION_LS_KEY = 'matcheck.docModal.validation';

function makeDetail(validation: { checks: UpdCheck[]; warnings: UpdWarning[] }) {
  return {
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
      {
        id: 'i1',
        lineNo: 1,
        nameRaw: 'Профнастил',
        qty: '200',
        unit: 'м2',
        price: '451.68',
        sum: '90336.07',
      },
      {
        id: 'i2',
        lineNo: 2,
        nameRaw: 'Триплекс',
        qty: '8114.75',
        unit: 'м2',
        price: '66.294',
        sum: '537959.51',
      },
    ],
    attachments: [],
    extraFiles: [],
    validation: {
      hasMismatch: validation.checks.length > 0,
      checkedAt: '2026-08-18T13:00:00.000Z',
      ...validation,
    },
  };
}

/** Проваленная построчная проверка «qty × price ≠ sum» — по одной на строку. */
function rowCheck(row: number): UpdCheck {
  return {
    name: 'row_qty_price',
    scope: { row },
    expected: 4418.25,
    actual: 5301.9,
    diff: 883.65,
    tolerance: 0.02,
    ok: false,
  };
}

const oneWarning = makeDetail({
  checks: [],
  warnings: [{ name: 'qty_price_swap', scope: { row: 2 } }],
});

// Боевой случай со скриншота: цена взята с НДС во всех девяти строках, из-за
// чего не сходится и построчная арифметика, и НДС документа.
const manyProblems = makeDetail({
  checks: [
    {
      name: 'vat_total',
      scope: 'document',
      expected: 10424.75,
      actual: 9634.99,
      diff: 789.76,
      tolerance: 0.02,
      ok: false,
    },
    ...Array.from({ length: 9 }, (_, i) => rowCheck(i + 1)),
  ],
  warnings: Array.from({ length: 9 }, (_, i) => ({
    name: 'price_includes_vat' as const,
    scope: { row: i + 1 },
  })),
});

// УПД № 53: три строки в бланке, распознаны две — сумма позиций меньше итога
// ровно на потерянную строку. Знак разницы и есть подсказка менеджеру.
const lostLine = makeDetail({
  checks: [
    {
      name: 'sum_total',
      scope: 'document',
      expected: 2557288,
      actual: 1513703,
      // diff беззнаковый: валидатор пишет туда Math.abs, и направление по нему
      // не восстановить — его считает сама карточка.
      diff: 1043585,
      tolerance: 0.02,
      ok: false,
    },
  ],
  warnings: [],
});

// Обратный случай, самый частый на бою: строка задвоилась при склейке копий.
const doubledLine = makeDetail({
  checks: [
    {
      name: 'sum_total',
      scope: 'document',
      expected: 1000000,
      actual: 1500000,
      diff: 500000,
      tolerance: 0.02,
      ok: false,
    },
  ],
  warnings: [],
});

const manyWarningsOnly = makeDetail({
  checks: [],
  warnings: Array.from({ length: 9 }, (_, i) => ({
    name: 'price_includes_vat' as const,
    scope: { row: i + 1 },
  })),
});

// Документ, который отдаёт мок api, меняется от кейса к кейсу. vi.hoisted —
// потому что фабрика vi.mock поднимается выше объявлений модуля.
const state = vi.hoisted(() => ({ detail: null as unknown }));

vi.mock('../../services/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url.includes('/responsible-persons')) return Promise.resolve({ items: [], total: 0 });
      if (url.endsWith('/file')) return Promise.reject(new Error('no file'));
      return Promise.resolve(state.detail);
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

function open() {
  render(
    wrap(
      <SourceDocumentDetailModal
        id="11111111-1111-1111-1111-111111111111"
        open
        onClose={() => {}}
      />,
    ),
  );
}

beforeEach(() => {
  // Выбор «развернуть/свернуть» живёт в localStorage: без сброса клик одного
  // кейса задал бы начальное состояние следующему.
  window.localStorage.removeItem(VALIDATION_LS_KEY);
});

afterEach(cleanup);

describe('карточка документа — подозрение на перестановку', () => {
  it('показывает предупреждение с номером строки', async () => {
    state.detail = oneWarning;
    open();

    expect(await screen.findByText('Проверьте строки по документу')).toBeTruthy();
    expect(
      screen.getByText(/количество и цена стоят не в своих колонках \(строка 2\)/),
    ).toBeTruthy();
    // Это не арифметическое расхождение: блока «Расхождения в суммах» нет.
    expect(screen.queryByText('Расхождения в суммах')).toBeNull();
  });
});

describe('карточка документа — много расхождений', () => {
  it('по умолчанию свёрнуто до полосы со счётчиками', async () => {
    state.detail = manyProblems;
    open();

    expect(await screen.findByText(/Расхождения в суммах: 10/)).toBeTruthy();
    expect(screen.getByText(/Проверьте строки: 9/)).toBeTruthy();
    // Самих пунктов на экране нет — высота остаётся документу.
    expect(screen.queryByText(/qty × price ≠ sum/)).toBeNull();
    expect(screen.queryByText('Проверьте строки по документу')).toBeNull();
  });

  it('«Показать» разворачивает оба списка, «Свернуть» возвращает полосу', async () => {
    state.detail = manyProblems;
    open();

    fireEvent.click(await screen.findByRole('button', { name: /Показать/ }));

    expect(screen.getByText('Расхождения в суммах')).toBeTruthy();
    expect(screen.getByText('Проверьте строки по документу')).toBeTruthy();
    expect(screen.getByText(/qty × price ≠ sum \(строка 1\)/)).toBeTruthy();
    expect(screen.getByText(/цена взята с НДС.*\(строка 9\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Свернуть/ }));

    expect(screen.queryByText(/qty × price ≠ sum/)).toBeNull();
    expect(screen.queryByText('Проверьте строки по документу')).toBeNull();
    expect(screen.getByText(/Расхождения в суммах: 10/)).toBeTruthy();
  });

  it('сохранённый выбор «развернуть» сильнее автосворачивания', async () => {
    window.localStorage.setItem(VALIDATION_LS_KEY, 'expanded');
    state.detail = manyProblems;
    open();

    expect(await screen.findByText('Расхождения в суммах')).toBeTruthy();
    expect(screen.getByText(/qty × price ≠ sum \(строка 1\)/)).toBeTruthy();
  });

  it('документ с одними подозрениями тоже сворачивается', async () => {
    state.detail = manyWarningsOnly;
    open();

    expect(await screen.findByText(/Проверьте строки: 9/)).toBeTruthy();
    // Пустой группы в полосе нет — «Расхождения в суммах: 0» не пишем.
    expect(screen.queryByText(/Расхождения в суммах/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Показать/ }));
    expect(screen.getByText('Проверьте строки по документу')).toBeTruthy();
    expect(screen.getByText(/цена взята с НДС.*\(строка 1\)/)).toBeTruthy();
  });
});

describe('карточка документа — что значит расхождение сумм', () => {
  it('сумма позиций меньше итога: названа недостача и её причина', async () => {
    window.localStorage.setItem(VALIDATION_LS_KEY, 'expanded');
    state.detail = lostLine;
    open();

    expect(await screen.findByText('Расхождения в суммах')).toBeTruthy();
    expect(
      screen.getByText(/не хватает 1 043 585,00 ₽, вероятно, строка не распозналась/),
    ).toBeTruthy();
  });

  it('сумма позиций больше итога: названы лишние деньги и задвоение', async () => {
    window.localStorage.setItem(VALIDATION_LS_KEY, 'expanded');
    state.detail = doubledLine;
    open();

    expect(await screen.findByText('Расхождения в суммах')).toBeTruthy();
    expect(screen.getByText(/лишние 500 000,00 ₽, вероятно, строка задвоилась/)).toBeTruthy();
  });
});
