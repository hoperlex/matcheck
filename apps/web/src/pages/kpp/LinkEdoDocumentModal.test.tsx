// @vitest-environment jsdom
/**
 * Окно «Подобрать УПД из ЭДО»: «Открыть файл» и фото приёмки.
 *
 * УПД из реестра открывается панелью сверки (PDF рядом с фото), а не XML во
 * вкладке; у импортированных путь прежний. После закрытия панели фокус
 * возвращается в окно — иначе следующий ESC его не закроет.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

class ApiErrorMock extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const apiGet = vi.fn();
const apiDownload = vi.fn();

vi.mock('../../services/api', () => ({
  api: { get: apiGet },
  apiDownload,
  saveBlobAsFile: vi.fn(),
  ApiError: ApiErrorMock,
}));

const { LinkEdoDocumentModal } = await import('./LinkEdoDocumentModal');
type Props = ComponentProps<typeof LinkEdoDocumentModal>;

const base = {
  contentCategory: 'materials',
  supplierName: 'ООО «Поставщик»',
  supplierInn: '7712345678',
  totalSum: '1200.00',
  siteId: null,
  usedElsewhere: 0,
  usedIn: [],
  foundBy: ['number'],
  reference: { origin: 'paper', label: 'EXP-1' },
  score: 10,
  level: 'high',
  matches: ['номер УПД'],
  conflicts: [],
  missing: [],
  otherSupplier: false,
  supplierCheck: { documentInns: ['7712345678'], referenceInns: ['7712345678'], matchedInn: '7712345678' },
};

/** Приёмка 19507: у чужого поставщика совпали только цифры номера. */
const stranger = {
  ...base,
  id: 'exp-stranger',
  source: 'export',
  docNumber: 'УТ-4862',
  docDate: '2026-09-03',
  supplierName: 'ООО "ЛЕНИНЕРТ"',
  supplierInn: '7816583913',
  level: 'weak',
  matches: ['номер совпал по цифрам'],
  conflicts: ['ИНН поставщика отличается'],
  otherSupplier: true,
  supplierCheck: { documentInns: ['7816583913'], referenceInns: ['7714333304'], matchedInn: null },
};

const candidates = {
  items: [
    { ...base, id: 'exp-1', source: 'export', docNumber: 'EXP-1', docDate: '2026-10-05' },
    { ...base, id: 'imp-1', source: 'import', docNumber: 'IMP-1', docDate: '2026-10-06' },
  ],
  referenceMissing: [],
  truncated: [],
  diagnostics: {
    registryReceivedUntil: null,
    registryAsOf: null,
    referencesAfterRegistry: [],
    registry: [],
    census: null,
    innsAbsentInRegistry: [],
    innUnreadable: false,
    contractorDelivery: false,
    dateOnly: false,
    dateFallback: false,
  },
};

const photos: Props['deliveryPhotos'] = [
  {
    id: 'p1',
    kind: 'document',
    stage: 'before',
    takenAt: '2026-10-12T08:00:00Z',
    uploadedAt: '2026-10-12T08:01:00Z',
  },
  // Висящая загрузка — не считается и не показывается.
  {
    id: 'p2',
    kind: 'document',
    stage: 'before',
    takenAt: '2026-10-12T08:02:00Z',
    uploadedAt: null,
  },
];

function show(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    deliveryId: 'd1',
    busy: false,
    error: null,
    deliveryItems: [],
    deliveryPhotos: photos,
    onCancel: vi.fn(),
    onPick: vi.fn(),
    ...over,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (p: Props) => (
    <QueryClientProvider client={client}>
      <LinkEdoDocumentModal {...p} />
    </QueryClientProvider>
  );
  const view = render(ui(props));
  return { props, rerender: (p: Partial<Props>) => view.rerender(ui({ ...props, ...p })) };
}

async function openFileButtons() {
  await screen.findByText('EXP-1');
  return screen.getAllByRole('button', { name: 'Открыть файл' });
}

beforeEach(() => {
  apiGet.mockReset();
  apiDownload.mockReset();
  apiGet.mockImplementation((path: string) => {
    if (path === '/deliveries/d1/edo-candidates') return Promise.resolve(candidates);
    if (path === '/source-documents/imp-1/file') {
      return Promise.resolve({ url: 'https://s3.test/imp-1.xml' });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
  apiDownload.mockImplementation((path: string) =>
    Promise.resolve({
      blob: new Blob(['x'], { type: path.endsWith('/pdf') ? 'application/pdf' : 'image/jpeg' }),
      filename: '',
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('«Открыть файл»', () => {
  it('УПД из реестра — панель с PDF и фото, без новой вкладки', async () => {
    const open = vi.spyOn(window, 'open');
    show();
    const [exportButton] = await openFileButtons();
    fireEvent.click(exportButton!);

    expect(await screen.findByTitle('УПД EXP-1')).toBeTruthy();
    expect(apiDownload).toHaveBeenCalledWith('/deliveries/d1/edo-candidates/export/exp-1/pdf');
    expect(open).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Фото 1' })).toBeTruthy();
  });

  it('импортированная УПД — прежний путь: XML во вкладке', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    show();
    const [, importButton] = await openFileButtons();
    fireEvent.click(importButton!);

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://s3.test/imp-1.xml'));
    expect(apiDownload).not.toHaveBeenCalledWith(expect.stringContaining('/pdf'));
  });

  it('«Открыть XML» в панели ведёт к файлу реестра', async () => {
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    apiGet.mockImplementation((path: string) => {
      if (path === '/deliveries/d1/edo-candidates') return Promise.resolve(candidates);
      if (path === '/deliveries/d1/edo-candidates/export/exp-1/file') {
        return Promise.resolve({ url: 'https://s3.test/exp-1.xml' });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    show();
    const [exportButton] = await openFileButtons();
    fireEvent.click(exportButton!);
    await screen.findByTitle('УПД EXP-1');
    fireEvent.click(screen.getByRole('button', { name: 'Открыть XML' }));
    await waitFor(() => expect(tab.location.href).toBe('https://s3.test/exp-1.xml'));
  });
});

describe('фото приёмки', () => {
  it('кнопка считает только загруженные фото и открывает панель без PDF', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Фото приёмки (1)' }));
    const drawer = (await screen.findByText('Фото приёмки')).closest('.ant-drawer')!;
    expect(
      within(drawer as HTMLElement).getAllByRole('button', { name: /^Фото \d$/ }),
    ).toHaveLength(1);
    expect(apiDownload).not.toHaveBeenCalledWith(expect.stringContaining('/pdf'));
  });

  it('без загруженных фото кнопка неактивна', () => {
    show({ deliveryPhotos: [] });
    expect(
      (screen.getByRole('button', { name: 'Фото приёмки (0)' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('чужой поставщик', () => {
  const withStranger = { ...candidates, items: [...candidates.items, stranger] };

  function mockCandidates(byPath: Record<string, unknown>) {
    apiGet.mockImplementation((path: string) =>
      path in byPath
        ? Promise.resolve(byPath[path])
        : Promise.reject(new Error(`unexpected ${path}`)),
    );
  }

  it('без поиска свёрнут в отдельный блок и раскрывается по клику', async () => {
    mockCandidates({ '/deliveries/d1/edo-candidates': withStranger });
    show();
    await screen.findByText('EXP-1');
    expect(screen.queryByText('УТ-4862')).toBeNull();

    fireEvent.click(screen.getByText('Похожие номера у других поставщиков (1)'));
    expect(await screen.findByText('УТ-4862')).toBeTruthy();
    expect(screen.getByText('Другой поставщик')).toBeTruthy();
  });

  it('в ручном поиске не сворачивается и помечен', async () => {
    mockCandidates({
      '/deliveries/d1/edo-candidates': candidates,
      '/deliveries/d1/edo-candidates?q=4862': { ...candidates, items: [stranger] },
    });
    show();
    await screen.findByText('EXP-1');
    const search = screen.getByPlaceholderText('Номер УПД, поставщик, ИНН или имя файла');
    fireEvent.change(search, { target: { value: '4862' } });
    fireEvent.click(screen.getByRole('button', { name: /Найти/ }));

    expect(await screen.findByText('УТ-4862')).toBeTruthy();
    expect(screen.getByText('Другой поставщик')).toBeTruthy();
    expect(screen.queryByText(/Похожие номера у других поставщиков/)).toBeNull();
  });

  it('без совпадений показывает список по дате сразу, даже если поставщик другой', async () => {
    mockCandidates({
      '/deliveries/d1/edo-candidates': {
        ...candidates,
        items: [stranger],
        diagnostics: { ...candidates.diagnostics, dateFallback: true },
      },
    });
    show();
    expect(await screen.findByText('УТ-4862')).toBeTruthy();
    expect(screen.getByText(/Совпадений по реквизитам нет/)).toBeTruthy();
    expect(screen.queryByText(/Похожие номера у других поставщиков/)).toBeNull();
  });

  it('пустой поиск по короткому номеру прямо сообщает, что такой УПД нет', async () => {
    mockCandidates({
      '/deliveries/d1/edo-candidates': candidates,
      '/deliveries/d1/edo-candidates?q=233': { ...candidates, items: [] },
    });
    show();
    await screen.findByText('EXP-1');
    fireEvent.change(screen.getByPlaceholderText('Номер УПД, поставщик, ИНН или имя файла'), {
      target: { value: '233' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Найти/ }));
    expect(await screen.findByText(/УПД с номером 233 среди доступных документов ЭДО не найдена/)).toBeTruthy();
  });

  it('подтверждение привязки называет оба ИНН', async () => {
    mockCandidates({ '/deliveries/d1/edo-candidates': withStranger });
    const { props } = show();
    await screen.findByText('EXP-1');
    fireEvent.click(screen.getByText('Похожие номера у других поставщиков (1)'));
    const row = (await screen.findByText('УТ-4862')).closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Привязать' }));

    const text = await screen.findByText(/ИНН в УПД: 7816583913; в документах приёмки: 7714333304/);
    expect(props.onPick).not.toHaveBeenCalled();
    // Modal.confirm живёт вне дерева React — cleanup() его не уберёт, и
    // оставшийся диалог перехватил бы фокус в следующих тестах.
    const dialog = text.closest<HTMLElement>('.ant-modal-confirm')!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByText(/ИНН в УПД:/)).toBeNull());
  });
});

describe('блок материалов и другие приёмки', () => {
  const section = { id: 's1', label: 'Накладная № 057/50125' };
  const sectionPath = '/deliveries/d1/edo-candidates?sectionDocumentId=s1';

  function mockPaths(byPath: Record<string, unknown>) {
    apiGet.mockImplementation((path: string) =>
      path in byPath
        ? Promise.resolve(byPath[path])
        : Promise.reject(new Error(`unexpected ${path}`)),
    );
  }

  it('подбор к блоку: эталон — документ блока, рядом с УПД строки блока', async () => {
    mockPaths({
      [sectionPath]: { ...candidates, items: [candidates.items[0]] },
      '/deliveries/d1/edo-candidates/export/exp-1/preview': {
        docNumber: 'EXP-1',
        docDate: '2026-10-05',
        supplierName: 'ООО «Поставщик»',
        supplierInn: '7712345678',
        buyerName: null,
        buyerInn: null,
        totalSum: 1200,
        vatSum: 200,
        shippedAt: null,
        items: [],
      },
    });
    show({ section });

    expect(await screen.findByText('EXP-1')).toBeTruthy();
    expect(screen.getByText('Подобрать УПД из ЭДО к блоку «Накладная № 057/50125»')).toBeTruthy();
    expect(screen.getByText('Сверено с документом блока: Накладная № 057/50125')).toBeTruthy();

    fireEvent.click(document.querySelector<HTMLElement>('.ant-table-row-expand-icon')!);
    expect(await screen.findByText('Строки блока')).toBeTruthy();
  });

  it('поиск в блоке не теряет блок', async () => {
    mockPaths({
      [sectionPath]: candidates,
      '/deliveries/d1/edo-candidates?q=EXP&sectionDocumentId=s1': candidates,
    });
    show({ section });
    await screen.findByText('EXP-1');
    fireEvent.change(screen.getByPlaceholderText('Номер УПД, поставщик, ИНН или имя файла'), {
      target: { value: 'EXP' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Найти/ }));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/deliveries/d1/edo-candidates?q=EXP&sectionDocumentId=s1',
      ),
    );
  });

  it('УПД в другой приёмке — её номер в строке', async () => {
    mockPaths({
      '/deliveries/d1/edo-candidates': {
        ...candidates,
        items: [
          {
            ...candidates.items[0],
            usedElsewhere: 1,
            usedIn: [{ deliveryId: 'x1', displayId: 21041 }],
          },
        ],
      },
    });
    show();
    expect(await screen.findByText('Уже в приёмке 21041')).toBeTruthy();
  });

  it('подтверждение называет приёмки, остаток — числом', async () => {
    mockPaths({
      '/deliveries/d1/edo-candidates': {
        ...candidates,
        items: [
          {
            ...candidates.items[0],
            usedElsewhere: 3,
            usedIn: [
              { deliveryId: 'x1', displayId: 21041 },
              { deliveryId: 'x2', displayId: 21070 },
            ],
          },
        ],
      },
    });
    const { props } = show();
    expect(await screen.findByText('Уже в приёмках 21041, 21070 и ещё 1')).toBeTruthy();
    const row = screen.getByText('EXP-1').closest('tr')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Привязать' }));

    const text = await screen.findByText(
      'УПД уже привязана к приёмкам 21041, 21070 и ещё 1. Привязать и к этой?',
    );
    const dialog = text.closest<HTMLElement>('.ant-modal-confirm')!;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Привязать' }));
    await waitFor(() => expect(props.onPick).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Привязать и к этой/)).toBeNull());
  });
});

describe('свежесть реестра', () => {
  /** Поля диагностики поверх фикстуры; тип свободный — фикстура выведена из литералов. */
  function withDiagnostics(diagnostics: Record<string, unknown>) {
    apiGet.mockImplementation((path: string) =>
      path === '/deliveries/d1/edo-candidates'
        ? Promise.resolve({ ...candidates, diagnostics: { ...candidates.diagnostics, ...diagnostics } })
        : Promise.reject(new Error(`unexpected ${path}`)),
    );
  }

  const account = {
    accountId: 'a1',
    name: 'Диадок_СУ10',
    state: 'ok',
    checkedAt: '2026-10-13T12:30:00.000Z',
    failedPending: 0,
    nextRetryAt: null,
    failedFinal: 0,
  };

  it('документы приёмки позже реестра — плашка с номерами, без «быть не может»', async () => {
    withDiagnostics({
      registryReceivedUntil: '2026-10-05T13:40:59.928Z',
      registryAsOf: { at: '2026-10-05T13:40:59.928Z', basis: 'received' },
      referencesAfterRegistry: [{ label: 'TK-04861', date: '2026-10-12' }],
    });
    show();
    expect(await screen.findByText(/последней УПД в реестре ЭДО.*№ TK-04861 от 12\.10\.2026/)).toBeTruthy();
    expect(screen.getByText(/Скорее всего, их ещё не выгрузили/)).toBeTruthy();
  });

  it('после полной проверки — «реестр проверен», плашка опирается на проверку', async () => {
    withDiagnostics({
      registryReceivedUntil: '2026-10-13T12:10:00.000Z',
      registryAsOf: { at: '2026-10-13T12:30:00.000Z', basis: 'checked' },
      referencesAfterRegistry: [{ label: 'TK-1', date: '2026-10-14' }],
      registry: [account],
    });
    show();
    expect(await screen.findByText(/Реестр ЭДО проверен/)).toBeTruthy();
    expect(screen.getByText(/позже последней проверки реестра ЭДО/)).toBeTruthy();
    expect(screen.queryByText(/Автообновление реестра ЭДО/)).toBeNull();
  });

  it('у каждого состояния автообновления — своё сообщение, сбои — отдельно', async () => {
    for (const [state, text] of [
      ['never', /ещё ни разу не дочитало ленту/],
      ['catching_up', /догоняет ленту/],
      ['stale', /не работает: последняя полная проверка/],
    ] as const) {
      withDiagnostics({ registry: [{ ...account, state, checkedAt: state === 'never' ? null : account.checkedAt }] });
      show();
      expect(await screen.findByText(text)).toBeTruthy();
      cleanup();
    }
    withDiagnostics({
      registry: [{ ...account, failedPending: 2, nextRetryAt: '2026-10-13T13:30:00.000Z', failedFinal: 1 }],
    });
    show();
    expect(await screen.findByText(/2 УПД не удалось выгрузить — повтор с .*; 1 УПД не выгружены окончательно/)).toBeTruthy();
  });

  it('сканы поставщика из переписи — плашка с числом и видами документов', async () => {
    withDiagnostics({
      census: {
        count: 3,
        withoutUtd: 2,
        lastReceivedAt: '2026-10-12T09:00:00.000Z',
        categories: ['scan', 'invoice'],
        fromTitle: 'ООО «ТПК ПромАэроТехника»',
      },
    });
    show();
    expect(
      await screen.findByText(/не в формате УПД от «ООО «ТПК ПромАэроТехника»»: 3 \(сканы, счета-фактуры\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Без УПД в том же сообщении: 2/)).toBeTruthy();
  });
});

describe('закрытие панели', () => {
  it('фокус возвращается в окно подбора — ESC снова закроет его', async () => {
    show();
    const [exportButton] = await openFileButtons();
    fireEvent.click(exportButton!);
    const drawer = (await screen.findByTitle('УПД EXP-1')).closest<HTMLElement>('.ant-drawer')!;

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(document.activeElement?.classList.contains('ant-modal-wrap')).toBe(true);
    });
    await waitFor(() => expect(screen.queryByTitle('УПД EXP-1')).toBeNull());
  });

  it('окно закрыли с открытой панелью — при следующем открытии панели нет', async () => {
    const { rerender } = show();
    const [exportButton] = await openFileButtons();
    fireEvent.click(exportButton!);
    await screen.findByTitle('УПД EXP-1');

    rerender({ open: false });
    rerender({ open: true });
    await screen.findByText('EXP-1');
    await waitFor(() => expect(screen.queryByTitle('УПД EXP-1')).toBeNull());
  });
});

describe('операторы ЭДО (Диадок и СБИС)', () => {
  function respond(over: { items?: unknown[]; diagnostics?: Record<string, unknown> }) {
    apiGet.mockImplementation((path: string) =>
      path === '/deliveries/d1/edo-candidates'
        ? Promise.resolve({
            ...candidates,
            ...(over.items ? { items: over.items } : {}),
            diagnostics: { ...candidates.diagnostics, ...over.diagnostics },
          })
        : Promise.reject(new Error(`unexpected ${path}`)),
    );
  }

  const diadocAccount = {
    accountId: 'a1',
    name: 'Диадок_СУ10',
    provider: 'diadoc',
    state: 'ok',
    checkedAt: '2026-10-13T12:30:00.000Z',
    failedPending: 0,
    nextRetryAt: null,
    failedFinal: 0,
  };
  const sbisAccount = { ...diadocAccount, accountId: 'a2', name: 'СБИС_СУ10', provider: 'sbis' };

  /** Строка таблицы, в которой стоит номер УПД. */
  const rowOf = (number: string) => screen.getByText(number).closest<HTMLElement>('tr')!;

  it('у строки — метка оператора; копия, которую сервер свернул, помечена «есть и в СБИС»', async () => {
    respond({
      items: [
        { ...base, id: 'd-1', source: 'export', docNumber: 'D-1', docDate: '2026-10-05', operator: 'diadoc', alsoInOperators: ['sbis'] },
        { ...base, id: 's-2', source: 'export', docNumber: 'S-2', docDate: '2026-10-06', operator: 'sbis', alsoInOperators: [] },
      ],
    });
    show();
    await screen.findByText('D-1');
    expect(within(rowOf('D-1')).getByText('Диадок')).toBeTruthy();
    expect(within(rowOf('D-1')).getByText('есть и в СБИС')).toBeTruthy();
    expect(within(rowOf('S-2')).getByText('СБИС')).toBeTruthy();
    expect(within(rowOf('S-2')).queryByText(/есть и в/)).toBeNull();
  });

  it('прежний ответ без оператора — меток нет, строка как раньше', async () => {
    respond({});
    show();
    await screen.findByText('EXP-1');
    expect(screen.queryByText('Диадок')).toBeNull();
    expect(screen.queryByText('СБИС')).toBeNull();
  });

  it('одна шапка у разных операторов — подсказка сверить позиции у обеих строк, строки не склеены', async () => {
    const header = { ...base, source: 'export', docNumber: '671', docDate: '2026-08-31', totalSum: '8378000.00' };
    respond({
      items: [
        { ...header, id: 'd-671', operator: 'diadoc', alsoInOperators: [] },
        { ...header, id: 's-671', operator: 'sbis', alsoInOperators: [], totalSum: '8378000' },
      ],
    });
    show();
    expect(await screen.findAllByText('671')).toHaveLength(2);
    expect(screen.getByText(/Возможно, та же УПД, что из СБИС, — сверьте позиции/)).toBeTruthy();
    expect(screen.getByText(/Возможно, та же УПД, что из Диадока, — сверьте позиции/)).toBeTruthy();
  });

  it('одна шапка у одного оператора — подсказки нет (повторы внутри Диадока)', async () => {
    const header = { ...base, source: 'export', docNumber: '45', docDate: '2026-08-31', operator: 'diadoc', alsoInOperators: [] };
    respond({ items: [{ ...header, id: 'd-45a' }, { ...header, id: 'd-45b' }] });
    show();
    expect(await screen.findAllByText('45')).toHaveLength(2);
    expect(screen.queryByText(/Возможно, та же УПД/)).toBeNull();
  });

  it('свежесть: у учётки СБИС — «ленту СБИС», у Диадока прежний текст; при двух учётках — имя и оператор', async () => {
    respond({
      diagnostics: {
        registry: [
          { ...diadocAccount, state: 'never', checkedAt: null },
          { ...sbisAccount, state: 'catching_up' },
        ],
      },
    });
    show();
    expect(
      await screen.findByText(/^Диадок_СУ10 \(Диадок\): Автообновление реестра ЭДО ещё ни разу не дочитало ленту Диадока/),
    ).toBeTruthy();
    expect(screen.getByText(/^СБИС_СУ10 \(СБИС\): Реестр ЭДО догоняет ленту СБИС/)).toBeTruthy();
  });

  it('«нет в реестре»: с учёткой СБИС — «из ЭДО СУ-10 (Диадок и СБИС)», без неё — прежний текст', async () => {
    respond({ diagnostics: { innsAbsentInRegistry: ['7700000000'], registry: [diadocAccount, sbisAccount] } });
    show();
    expect(await screen.findByText(/из ЭДО СУ-10 \(Диадок и СБИС\)/)).toBeTruthy();
    cleanup();

    respond({ diagnostics: { innsAbsentInRegistry: ['7700000000'], registry: [diadocAccount] } });
    show();
    expect(await screen.findByText(/только формализованные УПД из ящика ЭДО СУ-10\./)).toBeTruthy();
  });
});

describe('учётки реестра без замечаний', () => {
  const ok = (accountId: string, name: string, provider: string) => ({
    accountId,
    name,
    provider,
    state: 'ok',
    checkedAt: '2026-10-26T12:03:00.000Z',
    failedPending: 0,
    nextRetryAt: null,
    failedFinal: 0,
  });

  function withRegistry(registry: unknown[]) {
    apiGet.mockImplementation((path: string) =>
      path === '/deliveries/d1/edo-candidates'
        ? Promise.resolve({ ...candidates, diagnostics: { ...candidates.diagnostics, registry } })
        : Promise.reject(new Error(`unexpected ${path}`)),
    );
  }

  it('две учётки в порядке — пустых блоков над поиском нет; замечание у одной — только её плашка', async () => {
    withRegistry([ok('a1', 'Диадок_СУ10', 'diadoc'), ok('a2', 'СБИС', 'sbis')]);
    show();
    await screen.findByText('EXP-1');
    const body = document.querySelector('.ant-modal-body')!;
    expect(body.querySelectorAll('.ant-space:empty')).toHaveLength(0);
    expect(within(body as HTMLElement).queryByRole('alert')).toBeNull();
    cleanup();

    withRegistry([ok('a1', 'Диадок_СУ10', 'diadoc'), { ...ok('a2', 'СБИС', 'sbis'), state: 'catching_up' }]);
    show();
    expect(await screen.findByText(/^СБИС \(СБИС\): Реестр ЭДО догоняет ленту СБИС/)).toBeTruthy();
    expect(document.querySelectorAll('.ant-modal-body .ant-space:empty')).toHaveLength(0);
    expect(screen.queryByText(/Диадок_СУ10/)).toBeNull();
  });
});
