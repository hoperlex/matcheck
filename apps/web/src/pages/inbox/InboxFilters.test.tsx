// @vitest-environment jsdom
/**
 * Фильтры «Документов» независимы друг от друга.
 *
 * Жалоба звучала так: выбираешь объект, вводишь номер документа — объект
 * слетает. Причина была в записи query-параметров: панель шлёт частичный патч,
 * а недостающие ключи приходили как `undefined` и удалялись вместе с реально
 * снятыми. Тест держит именно это: адрес после ввода номера сохраняет объект,
 * подрядчика и поставщика.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect, type ReactElement } from 'react';

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
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

const SITE_ID = '33333333-3333-3333-3333-333333333333';
const CONTRACTOR_ID = '44444444-4444-4444-4444-444444444444';
const SUPPLIER_ID = '55555555-5555-5555-5555-555555555555';

// Сеть не предмет теста: список пустой, важен только адрес после ввода.
// Ответ подменяется в тестах: базовый — пустой список.
const apiState = vi.hoisted(() => ({
  response: { items: [], total: 0 } as Record<string, unknown>,
  // Адреса запросов: пока мок их игнорировал, список мог растерять половину
  // параметров, и ни один тест этого не замечал.
  urls: [] as string[],
  // Где включено объединение машин — от него зависит «Разъединить».
  mergeConfig: { enabledSites: [] as string[] },
}));

vi.mock('../../services/api', () => ({
  api: {
    get: async (url: string) => {
      apiState.urls.push(url);
      // Справочники для полей панели и воронок в шапке.
      if (url.startsWith('/sites')) {
        return { items: [{ id: SITE_ID, code: 'АЛ13', name: 'ЖК АЛИЯ' }], total: 1 };
      }
      // Строки выбора поставщика — одна на организацию (группы дублей).
      if (url === '/suppliers/filter-options') {
        return { items: [{ value: SUPPLIER_ID, label: 'ООО «Лютик»', memberIds: [SUPPLIER_ID] }] };
      }
      if (url.startsWith('/suppliers')) {
        return { items: [{ id: SUPPLIER_ID, name: 'ООО «Лютик»' }], total: 1 };
      }
      if (url === '/source-documents/machine-merge/config') return apiState.mergeConfig;
      return apiState.response;
    },
    post: async () => ({ ok: true }),
    patch: async () => ({}),
    delete: async () => ({}),
  },
  apiDownload: async () => undefined,
  ApiError: class extends Error {},
}));

const { default: InboxPage } = await import('./Inbox');
const { useGlobalFiltersStore } = await import('../../stores/globalFilters');

let search = '';
/** Сколько раз менялся адрес: одно «Применить» обязано дать ровно одно изменение. */
let urlChanges = 0;
/** Переход внутри открытой страницы — как пункт меню, без размонтирования. */
let navigateTo: NavigateFunction = () => undefined;

function UrlSpy(): null {
  const location = useLocation();
  search = location.search;
  navigateTo = useNavigate();
  useEffect(() => {
    urlChanges += 1;
  }, [location.key]);
  return null;
}

let lastClient: QueryClient | null = null;

function renderPage(initial: string): ReturnType<typeof render> {
  // Адреса считаем с чистого листа: список сам себя опрашивает по таймеру
  // (refetchInterval), и запросы соседнего кейса, долетевшие после его cleanup,
  // иначе оказались бы «последними» и проверялись бы вместо наших.
  apiState.urls = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <InboxPage />
        <UrlSpy />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(ui);
}

afterEach(async () => {
  cleanup();
  // Поллинг списка останавливаем явно: без этого его запросы долетают уже во
  // время следующего кейса и подменяют собой «последний» адрес.
  await lastClient?.cancelQueries();
  lastClient?.clear();
  lastClient = null;
  apiState.response = { items: [], total: 0 };
  apiState.urls = [];
  apiState.mergeConfig = { enabledSites: [] };
  // «Липкие» фильтры раздела живут в общем хранилище: без сброса объект из
  // соседнего кейса подставлялся бы в пустой адрес следующего.
  useGlobalFiltersStore.getState().reset();
});

/** Ячейка шапки таблицы по подписи: те же слова встречаются в панели и чипах. */
function headerCell(title: string): HTMLElement {
  const cells = Array.from(document.querySelectorAll<HTMLElement>('.ant-table-thead th'));
  const cell = cells.find((th) => th.textContent?.trim() === title);
  if (!cell) throw new Error(`нет колонки «${title}»`);
  return cell;
}

/** Запросы списка документов (без счётчиков вкладок и очереди). */
function listUrls(): URLSearchParams[] {
  return apiState.urls
    .filter((u) => u.startsWith('/source-documents?'))
    .filter((u) => !u.includes('needsAttention=true'))
    .filter((u) => !u.includes('limit=1&') && !u.endsWith('limit=1'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));
}

/** Запросы счётчика «Требуют внимания». */
function attentionUrls(): URLSearchParams[] {
  return apiState.urls
    .filter((u) => u.startsWith('/source-documents?') && u.includes('needsAttention=true'))
    .filter((u) => u.includes('limit=1'))
    .map((u) => new URLSearchParams(u.slice(u.indexOf('?') + 1)));
}

/**
 * Ждёт запрос списка, где встречаются ВСЕ ожидаемые параметры, и возвращает его.
 *
 * Ищем совпадение среди записанных адресов, а не «последний»: список сам себя
 * опрашивает по таймеру, и хвост соседнего кейса иначе подменял бы проверяемый
 * запрос. Для доказательства этого достаточно: пока параметр не доходил до
 * сервера, подходящего адреса не было ни одного.
 */
async function expectListRequest(expected: Record<string, string>): Promise<URLSearchParams> {
  let found: URLSearchParams | null = null;
  await waitFor(() => {
    found =
      listUrls().find((qs) =>
        Object.entries(expected).every(([k, v]) => qs.get(k) === v),
      ) ?? null;
    if (!found) {
      throw new Error(
        `нет запроса списка с ${JSON.stringify(expected)}; были: ${JSON.stringify(apiState.urls)}`,
      );
    }
  });
  return found!;
}

describe('Документы: фильтры не затирают друг друга', () => {
  it('ввод номера документа сохраняет объект, подрядчика и поставщика', async () => {
    renderPage(
      `/documents?site=${SITE_ID}&contractor=${CONTRACTOR_ID}&supplier=${SUPPLIER_ID}&direction=inbound`,
    );

    const input = await screen.findByPlaceholderText('Номер документа');
    fireEvent.change(input, { target: { value: 'УТ-10354' } });

    // DebouncedSearch отдаёт значение родителю через 300 мс.
    await waitFor(() => expect(search).toContain('q=%D0%A3%D0%A2-10354'), { timeout: 2000 });

    expect(search).toContain(`site=${SITE_ID}`);
    expect(search).toContain(`contractor=${CONTRACTOR_ID}`);
    expect(search).toContain(`supplier=${SUPPLIER_ID}`);
    expect(search).toContain('direction=inbound');
  });

  it('очистка номера снимает только его', async () => {
    renderPage(`/documents?site=${SITE_ID}&q=%D0%A3%D0%A2-1`);

    const input = await screen.findByPlaceholderText('Номер документа');
    fireEvent.change(input, { target: { value: '' } });

    await waitFor(() => expect(search).not.toContain('q='), { timeout: 2000 });
    expect(search).toContain(`site=${SITE_ID}`);
  });

  it('кнопка «Требуют внимания» не трогает остальные фильтры', async () => {
    renderPage(`/documents?site=${SITE_ID}&q=%D0%A3%D0%A2-1`);

    fireEvent.click(await screen.findByRole('button', { name: /Требуют внимания/ }));

    await waitFor(() => expect(search).toContain('attention=1'));
    expect(search).toContain(`site=${SITE_ID}`);
    expect(search).toContain('q=%D0%A3%D0%A2-1');
  });
});

describe('Документы: фильтры доходят до сервера', () => {
  // Жалоба звучала так: выбираешь «Дату поставки» — ничего не меняется. Адрес
  // при этом менялся, воронка загоралась, а запрос уходил без дат: список
  // собирал query-строку сам и знал лишь половину параметров.
  it('фильтр «Дата поставки» уходит в запрос', async () => {
    renderPage('/documents?direction=inbound&expFrom=2026-08-27&expTo=2026-08-27');

    await expectListRequest({
      expectedDateFrom: '2026-08-27',
      expectedDateTo: '2026-08-27',
    });
  });

  it('фильтр «Дата» уходит в запрос', async () => {
    renderPage('/documents?direction=inbound&docFrom=2026-08-01&docTo=2026-08-31');

    await expectListRequest({ docDateFrom: '2026-08-01', docDateTo: '2026-08-31' });
  });

  it('страница уходит смещением, а не номером', async () => {
    // total обязателен: с нулём antd сам приводит current к первой странице,
    // и проверять было бы нечего.
    apiState.response = { items: [], total: 200 };
    renderPage('/documents?direction=inbound&page=3');

    await expectListRequest({ limit: '50', offset: '100' });
  });

  it('сортировка по колонке уходит в запрос', async () => {
    renderPage('/documents?direction=inbound&sort=totalSum&order=asc');

    await expectListRequest({ sort: 'totalSum', order: 'asc' });
  });

  it('клик по заголовку колонки включает серверную сортировку', async () => {
    // antd отдаёт в onChange `columnKey = column.key`, а не dataIndex. Пока у
    // колонок был только dataIndex, клик приходил с пустым ключом, и обработчик
    // вместо сортировки по «Сумме» снимал её вовсе.
    renderPage('/documents?direction=inbound');
    await expectListRequest({ direction: 'inbound' });

    fireEvent.click(headerCell('Сумма'));

    await waitFor(() => expect(search).toContain('sort=totalSum'));
    expect(search).toContain('order=asc');
    await expectListRequest({ sort: 'totalSum', order: 'asc' });
  });

  it('фильтр дат не снимает сортировку, пришедшую из адреса', async () => {
    // Та же причина: при применении фильтра antd передаёт в onChange текущую
    // сортировку, и без ключа колонки обработчик её терял.
    renderPage(
      '/documents?direction=inbound&sort=totalSum&order=desc&docFrom=2026-08-01&expFrom=2026-08-05',
    );
    await expectListRequest({ sort: 'totalSum', order: 'desc', expectedDateFrom: '2026-08-05' });

    fireEvent.click(headerCell('Дата поставки').querySelector('.ant-table-filter-trigger')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Сбросить' }));

    // Снят только фильтр этой колонки: сортировка и вторая дата на месте.
    await waitFor(() => expect(search).not.toContain('expFrom'));
    expect(search).toContain('sort=totalSum');
    expect(search).toContain('order=desc');
    expect(search).toContain('docFrom=2026-08-01');

    // Смена сортировки, в свою очередь, не трогает фильтр дат.
    fireEvent.click(headerCell('Дата'));
    await waitFor(() => expect(search).toContain('sort=docDate'));
    expect(search).toContain('docFrom=2026-08-01');
  });

  it('дип-линк «Расхождение сумм» сужает выборку, а не только рисует чип', async () => {
    renderPage('/documents?direction=inbound&mismatch=1');

    await expectListRequest({ mismatch: 'true' });
  });

  it('клик по «№» не сбрасывает сортировку по колонке', async () => {
    // Колонка «№» рисуется таблицей и раньше несла свой компаратор: он
    // переставлял только загруженную страницу, а клик приходил в onChange с
    // ключом `__num__` — и обработчик снимал серверную сортировку.
    apiState.response = { items: [], total: 200 };
    renderPage('/documents?direction=inbound&sort=totalSum&order=asc');
    await expectListRequest({ sort: 'totalSum', order: 'asc' });

    // Заголовков «№» два: порядковый номер строки и номер документа. Нужен
    // первый — тот, что рисует сама таблица.
    fireEvent.click(screen.getAllByText('№')[0]!);

    // Адрес не изменился: сортировка осталась на «Сумме».
    await waitFor(() => expect(search).toContain('sort=totalSum'));
    expect(search).toContain('order=asc');
  });

  it('счётчик «Требуют внимания» считает по тем же фильтрам, что список', async () => {
    renderPage(
      `/documents?direction=inbound&expFrom=2026-08-27&expTo=2026-08-27&site=${SITE_ID}`,
    );

    const list = await expectListRequest({
      expectedDateFrom: '2026-08-27',
      expectedDateTo: '2026-08-27',
      siteIds: SITE_ID,
    });
    // Состав выборки обязан совпасть: иначе на кнопке стоит одно число, а
    // переход по ней показывает другое.
    let count: URLSearchParams | null = null;
    await waitFor(() => {
      count =
        attentionUrls().find((qs) => qs.get('expectedDateFrom') === '2026-08-27') ?? null;
      if (!count) throw new Error('счётчик не спросил про фильтр дат');
    });
    for (const key of ['expectedDateFrom', 'expectedDateTo', 'siteIds', 'direction']) {
      expect(count!.get(key), key).toBe(list.get(key));
    }
  });
});

describe('Документы: принятые файлы в общем списке', () => {
  it('файлы и документы — одна таблица с одной шапкой, страница не переполняется', async () => {
    // Сервер отдаёт файлы из того же окна, что и документы: на страницу в 50
    // строк приходит 1 файл и 49 документов. Пока файлы шли сверх лимита,
    // таблица срезала лишние строки, а вынесенные в отдельный блок — разрывали
    // шапку колонок.
    const docs = Array.from({ length: 49 }, (_, i) => ({
      id: `doc-${String(i).padStart(2, '0')}`,
      kind: 'upd',
      direction: 'inbound',
      status: 'parsed',
      origin: 'manual_pdf',
      docNumber: `Д-${i}`,
      docDate: '2026-08-01',
      expectedDate: null,
      totalSum: '1000.00',
      vatSum: null,
      supplierId: null,
      supplierName: null,
      contractorId: null,
      contractorName: null,
      recipientId: null,
      recipientName: null,
      recipientMolId: null,
      recipientMolName: null,
      siteId: null,
      siteName: null,
      llmProviderId: null,
      llmConfidence: null,
      parsedAt: '2026-08-01T10:00:00.000Z',
      queuedAt: null,
      processedAt: null,
      parseErrorCode: null,
      parseErrorDetails: null,
      originalFilename: null,
      contentHash: null,
      jobAttempts: 0,
      version: 1,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
      validation: null,
    }));
    const pending = [
      {
        key: 'registry:aaa',
        itemId: '99999999-9999-9999-9999-999999999999',
        bundleId: '88888888-8888-8888-8888-888888888888',
        portalGroupId: null,
        filename: 'ждёт-разбора.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        siteName: 'ЖК Тест',
        expectedDate: null,
        createdAt: '2026-08-01T09:00:00.000Z',
        state: 'awaiting_processing',
      },
    ];
    apiState.response = { items: docs, total: 2126, pendingFiles: pending, pendingTotal: 1 };

    const { container } = renderPage('/documents');

    expect(await screen.findByText('Д-48')).toBeTruthy();
    // Файл — обычная строка того же списка, а не отдельный блок над шапкой.
    expect(screen.getByText('ждёт-разбора.pdf')).toBeTruthy();
    expect(container.querySelectorAll('.ant-table-thead')).toHaveLength(1);
    expect(container.querySelectorAll('.ant-table-tbody > tr.ant-table-row')).toHaveLength(50);
  });
});

async function applyFunnel(column: string, option: string): Promise<void> {
  fireEvent.click(headerCell(column).querySelector('.ant-table-filter-trigger')!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByText(option).closest('label')!.querySelector('input')!);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));
}

describe('Документы: воронки в шапке — те же фильтры, что в панели', () => {
  it('«Объект» в воронке → объект в адресе и в запросе; сортировка и даты на месте', async () => {
    renderPage('/documents?direction=inbound&sort=totalSum&order=desc&docFrom=2026-08-01&page=3');
    await expectListRequest({ sort: 'totalSum', docDateFrom: '2026-08-01' });
    await waitFor(() => expect(headerCell('Объект').querySelector('.ant-table-filter-trigger')).toBeTruthy());
    const before = urlChanges;

    await applyFunnel('Объект', 'АЛ13 · ЖК АЛИЯ');

    await waitFor(() => expect(search).toContain(`site=${SITE_ID}`));
    // Ровно одно изменение адреса: второе (через Table.onChange) затёрло бы первое.
    expect(urlChanges - before).toBe(1);
    expect(search).toContain('sort=totalSum');
    expect(search).toContain('order=desc');
    expect(search).toContain('docFrom=2026-08-01');
    expect(search).not.toContain('page=');
    await expectListRequest({ siteIds: SITE_ID, sort: 'totalSum', docDateFrom: '2026-08-01' });

    // Смена сортировки не снимает объект.
    fireEvent.click(headerCell('Дата'));
    await waitFor(() => expect(search).toContain('sort=docDate'));
    expect(search).toContain(`site=${SITE_ID}`);
  });

  it('объект из адреса — воронка подсвечена, «Сбросить» снимает только его', async () => {
    renderPage(`/documents?direction=inbound&site=${SITE_ID}&supplier=${SUPPLIER_ID}`);
    await expectListRequest({ siteIds: SITE_ID });
    const trigger = () => headerCell('Объект').querySelector('.ant-table-filter-trigger')!;
    await waitFor(() => expect(trigger().classList.contains('active')).toBe(true));
    fireEvent.click(trigger());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сбросить' }));
    await waitFor(() => expect(search).not.toContain('site='));
    expect(search).toContain(`supplier=${SUPPLIER_ID}`);
  });

  it('«Накладная» в воронке «Тип» — ТН и ОС-2 на сервер', async () => {
    renderPage('/documents?direction=inbound');
    await expectListRequest({ direction: 'inbound' });
    await applyFunnel('Тип', 'Накладная');
    await waitFor(() => expect(search).toContain('kind=transport_waybill%2Cos2_transfer'));
    await expectListRequest({ kind: 'transport_waybill,os2_transfer' });
  });

  it('старая ссылка kind=upd по-прежнему работает', async () => {
    renderPage('/documents?direction=inbound&kind=upd');
    await expectListRequest({ kind: 'upd' });
    await waitFor(() =>
      expect(headerCell('Тип').querySelector('.ant-table-filter-trigger')!.classList).toContain('active'),
    );
  });

  it('воронка «№» — это поиск по номеру и имени файла из панели', async () => {
    renderPage('/documents?direction=inbound');
    await expectListRequest({ direction: 'inbound' });
    // «№» в шапке два: номер строки и номер документа — нужен тот, где воронка.
    const numberTh = Array.from(document.querySelectorAll<HTMLElement>('.ant-table-thead th')).find(
      (th) => th.textContent?.trim() === '№' && th.querySelector('.ant-table-filter-trigger'),
    )!;
    fireEvent.click(numberTh.querySelector('.ant-table-filter-trigger')!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Ищет по номеру документа и по имени файла')).toBeTruthy();
    const input = within(dialog).getByPlaceholderText('Содержит…');
    fireEvent.change(input, { target: { value: 'УТ-43' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(search).toContain('q=%D0%A3%D0%A2-43'));
    await expectListRequest({ q: 'УТ-43' });
  });
});

/** Документ списка: минимум полей, остальное пустое. */
function listDoc(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'upd',
    direction: 'inbound',
    status: 'parsed',
    origin: 'manual_pdf',
    docNumber: `Д-${id}`,
    docDate: '2026-11-23',
    expectedDate: '2026-11-24',
    totalSum: '1000.00',
    vatSum: null,
    supplierId: null,
    supplierName: null,
    contractorId: null,
    contractorName: null,
    recipientId: null,
    recipientName: null,
    recipientMolId: null,
    recipientMolName: null,
    siteId: SITE_ID,
    siteName: 'ЖК ДОМ 56',
    llmProviderId: null,
    llmConfidence: null,
    parsedAt: '2026-11-24T08:53:00.000Z',
    queuedAt: null,
    processedAt: null,
    parseErrorCode: null,
    parseErrorDetails: null,
    originalFilename: null,
    contentHash: null,
    jobAttempts: 0,
    version: 1,
    createdAt: '2026-11-24T08:53:00.000Z',
    updatedAt: '2026-11-24T08:53:00.000Z',
    validation: null,
    ...over,
  };
}

/** Верхняя «Сбросить» — в панели фильтров (у воронок колонок своя, в окне). */
function resetButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /Сбросить/ }) as HTMLButtonElement;
}

/** Отметить галочкой строку документа с этим номером. */
function selectRow(docNumber: string): void {
  const row = screen.getByText(docNumber).closest('tr')!;
  fireEvent.click(row.querySelector('.ant-table-selection-column input')!);
}

describe('Документы: «Сбросить» возвращает «свежие сверху»', () => {
  it('при одной сортировке кнопка активна и снимает сортировку и страницу', async () => {
    renderPage('/documents?direction=inbound&sort=docDate&order=asc&page=3');
    await expectListRequest({ sort: 'docDate', order: 'asc' });

    await waitFor(() => expect(resetButton().disabled).toBe(false));
    fireEvent.click(resetButton());

    await waitFor(() => expect(search).not.toContain('sort='));
    expect(search).not.toContain('order=');
    expect(search).not.toContain('page=');
    expect(search).toContain('direction=inbound');
  });

  it('без фильтров, сортировки и страницы кнопка неактивна', async () => {
    renderPage('/documents?direction=inbound');
    await expectListRequest({ direction: 'inbound' });
    expect(resetButton().disabled).toBe(true);
  });
});

describe('Документы: выбор галочками не переживает смену выдачи', () => {
  const twoDocs = () => {
    apiState.response = {
      items: [listDoc('a1', { docNumber: 'А-1' }), listDoc('a2', { docNumber: 'А-2' })],
      total: 2,
    };
  };

  it('«Сбросить» снимает выбор — невидимое не уйдёт в «Удалить выбранные»', async () => {
    twoDocs();
    renderPage('/documents?direction=inbound&page=3');
    await screen.findByText('А-1');
    selectRow('А-1');
    expect(await screen.findByText('Удалить выбранные')).toBeTruthy();

    fireEvent.click(resetButton());

    await waitFor(() => expect(search).not.toContain('page='));
    await waitFor(() => expect(screen.queryByText('Удалить выбранные')).toBeNull());
  });

  it('переход через меню без размонтирования страницы снимает выбор', async () => {
    twoDocs();
    renderPage('/documents?direction=inbound&page=3');
    await screen.findByText('А-1');
    selectRow('А-1');
    expect(await screen.findByText('Удалить выбранные')).toBeTruthy();

    // Меню ведёт на тот же маршрут — страница остаётся смонтированной.
    act(() => navigateTo('/documents?direction=inbound'));

    await waitFor(() => expect(search).not.toContain('page='));
    await waitFor(() => expect(screen.queryByText('Удалить выбранные')).toBeNull());
  });

  it('фильтр над таблицей снимает выбор', async () => {
    twoDocs();
    renderPage('/documents?direction=inbound');
    await screen.findByText('А-1');
    selectRow('А-1');
    expect(await screen.findByText('Удалить выбранные')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Номер документа'), { target: { value: 'А-2' } });

    await waitFor(() => expect(search).toContain('q='), { timeout: 2000 });
    await waitFor(() => expect(screen.queryByText('Удалить выбранные')).toBeNull());
  });

  it('обновление той же выдачи выбор не трогает', async () => {
    twoDocs();
    renderPage('/documents?direction=inbound');
    await screen.findByText('А-1');
    selectRow('А-1');
    expect(await screen.findByText('Удалить выбранные')).toBeTruthy();

    await act(async () => {
      await lastClient?.invalidateQueries({ queryKey: ['source-documents'] });
    });

    expect(screen.getByText('Удалить выбранные')).toBeTruthy();
  });
});

/** Ячейка строки поставки в колонке с этой подписью (последней, если их две — «№»). */
function groupCell(title: string): HTMLElement {
  const ths = Array.from(document.querySelectorAll<HTMLElement>('.ant-table-thead th'));
  const index = ths.map((th) => th.textContent?.trim()).lastIndexOf(title);
  if (index < 0) throw new Error(`нет колонки «${title}»`);
  const head = document.querySelector<HTMLElement>('.ant-table-tbody tr.mc-group-head');
  if (!head) throw new Error('нет строки поставки');
  return head.children[index] as HTMLElement;
}

describe('Документы: строка поставки по колонкам', () => {
  const M = 'dddddddd-0000-0000-0000-000000000001';

  it('значения поставки — в своих колонках, без «без номера» и «одной отправкой»', async () => {
    const machine = { id: M, documentCount: 2, uploadCount: 1, deliveryNumbers: [27275] };
    apiState.response = {
      items: [
        listDoc('t1', {
          portalGroupId: M,
          machine,
          docNumber: 'ТП-7724',
          buyerName: 'ООО "ЭЛЕВЕЛ"',
          buyerInn: '7720298746',
          totalSum: '1500.00',
          vatSum: '0.00',
        }),
        listDoc('t2', {
          portalGroupId: M,
          machine,
          docNumber: null,
          docDate: null,
          status: 'archived',
          parseErrorCode: 'supplementary',
          originalFilename: 'IMG_20261124.jpg',
          totalSum: null,
        }),
      ],
      total: 2,
    };
    renderPage('/documents?direction=inbound');
    await screen.findByText('IMG_20261124.jpg');

    expect(groupCell('Тип').textContent).toBe('2 документа');
    expect(groupCell('Статус').textContent).toContain('Принята: приёмка 27275');
    expect(groupCell('№').textContent).toBe('ТП-7724');
    expect(groupCell('Объект').textContent).toBe('ЖК ДОМ 56');
    expect(groupCell('Дата поставки').textContent).toBe('24.11.2026');
    expect(groupCell('Покупатель').textContent).toContain('ЭЛЕВЕЛ');
    expect(groupCell('Сумма').textContent).toContain('1');
    expect(groupCell('Сумма НДС').textContent).toMatch(/^0,00/);
    const head = document.querySelector('.ant-table-tbody tr.mc-group-head')!;
    expect(head.textContent).not.toContain('без номера');
    expect(head.textContent).not.toContain('одной отправкой');
    // Строку поставки выбрать нельзя — чекбокса в ней нет.
    expect(head.querySelector('.ant-table-selection-column input')).toBeNull();
  });

  it('принятая объединённая машина под фильтром: столбик статуса, обобщений нет', async () => {
    apiState.mergeConfig = { enabledSites: ['*'] };
    const machine = { id: M, documentCount: 3, uploadCount: 2, deliveryNumbers: [27275] };
    apiState.response = {
      items: [
        listDoc('m1', { portalGroupId: M, machine, docNumber: 'УТ-1', totalSum: '10.00' }),
        listDoc('m2', { portalGroupId: M, machine, docNumber: 'УТ-2', totalSum: '20.00' }),
      ],
      total: 2,
    };
    renderPage(`/documents?direction=inbound&supplier=${SUPPLIER_ID}`);
    await screen.findByText('УТ-1');

    // «найдено 2 из 3» — про количество, под «3 документа».
    expect(groupCell('Тип').textContent).toBe('3 документанайдено 2 из 3');
    const status = groupCell('Статус');
    expect(status.textContent).toContain('Принята: приёмка 27275');
    expect(status.textContent).toContain('объединена из 2 отправок');
    await waitFor(() =>
      expect(within(status).getByRole('button', { name: /Разъединить/ })).toBeTruthy(),
    );
    // Ячейка не режется в одну строку: кнопка не уедет за «…».
    expect(status.classList.contains('mc-group-cell')).toBe(true);
    // Под фильтром итог двух из трёх читался бы как итог поставки — пусто.
    expect(groupCell('Сумма').textContent).toBe('');
    expect(groupCell('Объект').textContent).toBe('');
    expect(groupCell('Покупатель').textContent).toBe('');
    expect(groupCell('№').textContent).toBe('УТ-1, УТ-2');
  });
});
