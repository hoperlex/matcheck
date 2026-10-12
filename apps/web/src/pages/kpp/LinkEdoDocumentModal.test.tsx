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
  foundBy: ['number'],
  reference: { origin: 'paper', label: 'EXP-1' },
  score: 10,
  level: 'high',
  matches: ['номер УПД'],
  conflicts: [],
  missing: [],
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
    innsAbsentInRegistry: [],
    innUnreadable: false,
    contractorDelivery: false,
    dateOnly: false,
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
