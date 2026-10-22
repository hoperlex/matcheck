// @vitest-environment jsdom
/**
 * Чипы привязанных УПД из ЭДО в шапке приёмки.
 *
 * Главное: «Файл» у УПД из реестра открывает PDF рядом с фото (панель сверки),
 * а не ссылку на сырой XML; XML остаётся запасным путём. Документ из импорта
 * открывается оригиналом, как раньше. После панели фокус возвращается в
 * карточку-модалку, иначе ESC её не закроет.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Modal } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

const apiDownload = vi.fn();

vi.mock('../../services/api', () => ({
  apiDownload,
  saveBlobAsFile: vi.fn(),
  ApiError: class extends Error {},
}));

const { LinkedEdoChips, deliveryNumbersText } = await import('./LinkedEdoChips');
type Props = ComponentProps<typeof LinkedEdoChips>;
type LinkedDoc = Props['documents'][number];

const PDF_PATH = '/deliveries/d1/edo-candidates/export/reg-3180/pdf';

const exported: LinkedDoc = {
  id: 'm-export',
  documentId: 'reg-3180',
  source: 'export',
  docNumber: '3180',
  docDate: '2026-10-15',
  supplierName: 'ООО «ТК ЗИТАР-С»',
  supplierInn: '5029153320',
  totalSum: '14040.00',
  linkedAt: '2026-10-19T10:34:00Z',
  sectionDocumentId: null,
  alsoIn: [],
  alsoInCount: 0,
};

const imported: LinkedDoc = {
  ...exported,
  id: 'm-import',
  documentId: 'src-77',
  source: 'import',
  docNumber: '77',
};

function serve() {
  apiDownload.mockImplementation((path: string) =>
    Promise.resolve(
      path === PDF_PATH
        ? { blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }), filename: 'УПД.pdf' }
        : { blob: new Blob(['jpg'], { type: 'image/jpeg' }), filename: '' },
    ),
  );
}

function show(over: Partial<Props> = {}, { inModal = false } = {}) {
  const props: Props = {
    deliveryId: 'd1',
    documents: [exported, imported],
    photos: [
      {
        id: 'p1',
        kind: 'document',
        stage: 'before',
        takenAt: '2026-10-15T12:28:00Z',
        uploadedAt: '2026-10-15T12:29:00Z',
      },
    ],
    unlinkDisabled: false,
    onUnlink: vi.fn(),
    onOpenOriginal: vi.fn(),
    ...over,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const chips = <LinkedEdoChips {...props} />;
  render(
    <QueryClientProvider client={client}>
      {inModal ? (
        <Modal open title="Приёмка 20238" footer={null}>
          {chips}
        </Modal>
      ) : (
        chips
      )}
    </QueryClientProvider>,
  );
  return props;
}

const fileButtons = () => screen.getAllByRole('button', { name: 'Файл' });

beforeEach(() => {
  apiDownload.mockReset();
  serve();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('«Файл»', () => {
  it('у УПД из реестра открывает PDF рядом с фото, а не ссылку на XML', async () => {
    const props = show();
    fireEvent.click(fileButtons()[0]!);

    const frame = await screen.findByTitle('УПД 3180');
    expect(frame.getAttribute('src')).toMatch(/^blob:/);
    expect(apiDownload).toHaveBeenCalledWith(PDF_PATH);
    expect(screen.getByText(/УПД 3180 от 15\.10\.2026 · ООО «ТК ЗИТАР-С»/)).toBeTruthy();
    expect(props.onOpenOriginal).not.toHaveBeenCalled();
  });

  it('у документа из импорта открывает оригинал, как раньше', () => {
    const props = show();
    fireEvent.click(fileButtons()[1]!);

    expect(props.onOpenOriginal).toHaveBeenCalledWith(imported);
    expect(screen.queryByTitle('УПД 77')).toBeNull();
    expect(apiDownload).not.toHaveBeenCalled();
  });

  it('XML остаётся в шапке панели и открывается через ссылку этой привязки', async () => {
    const props = show();
    fireEvent.click(fileButtons()[0]!);
    await screen.findByTitle('УПД 3180');

    fireEvent.click(screen.getByRole('button', { name: 'Открыть XML' }));
    expect(props.onOpenOriginal).toHaveBeenCalledWith(exported);
  });
});

describe('закрытие панели', () => {
  it('фокус возвращается в карточку-модалку — ESC снова закроет её', async () => {
    show({}, { inModal: true });
    fireEvent.click(fileButtons()[0]!);
    const drawer = (await screen.findByTitle('УПД 3180')).closest<HTMLElement>('.ant-drawer')!;

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(document.activeElement?.classList.contains('ant-modal-wrap')).toBe(true);
    });
    await waitFor(() => expect(screen.queryByTitle('УПД 3180')).toBeNull());
  });
});

describe('«×»', () => {
  it('после подтверждения снимает связь именно этого документа', async () => {
    const props = show();
    fireEvent.click(screen.getAllByRole('button', { name: '×' })[1]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Убрать' }));
    expect(props.onUnlink).toHaveBeenCalledWith(imported);
  });

  it('пока идёт другая операция, подтверждение не открывается', () => {
    const props = show({ unlinkDisabled: true });
    fireEvent.click(screen.getAllByRole('button', { name: '×' })[0]!);
    expect(screen.queryByRole('button', { name: 'Убрать' })).toBeNull();
    expect(props.onUnlink).not.toHaveBeenCalled();
  });
});

describe('другие приёмки с той же УПД', () => {
  it('без других приёмок дописки нет', () => {
    show({ documents: [exported] });
    expect(screen.queryByText(/ещё в/)).toBeNull();
  });

  it('номера других приёмок прямо в чипе, длинный список — числом', () => {
    show({
      documents: [
        {
          ...exported,
          alsoIn: [
            { deliveryId: 'x1', displayId: 21041 },
            { deliveryId: 'x2', displayId: 21070 },
            { deliveryId: 'x3', displayId: 21071 },
          ],
          alsoInCount: 4,
        },
      ],
    });
    expect(screen.getByText(/ещё в 21041, 21070 и ещё 2/)).toBeTruthy();
  });

  it('текст номеров: остаток считается от общего числа, а не от показанных', () => {
    const two = [{ displayId: 1 }, { displayId: 2 }];
    expect(deliveryNumbersText(two, 2)).toBe('1, 2');
    expect(deliveryNumbersText(two, 12)).toBe('1, 2 и ещё 10');
    expect(deliveryNumbersText(two, 12, 1)).toBe('1 и ещё 11');
  });
});
