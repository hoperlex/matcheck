// @vitest-environment jsdom
/**
 * Отметка «просмотрено» в галерее фото приёмки.
 *
 * Просмотренным считается ОРИГИНАЛ, успешно нарисованный на экране и
 * простоявший секунду. Миниатюра (растянутая в просмотре antd или
 * приглушённая в окне документа), спиннер и ошибка загрузки отметку не дают.
 *
 * Окно документа подменено: его собственная часть — «оригинал на экране»
 * сообщается только для оригинала — проверена в PhotoDocumentPreview.test.
 * Здесь — что делает с этим сигналом галерея. Просмотр груза/машины —
 * настоящий antd PreviewGroup.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { message } from 'antd';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { __resetPhotoViewedCacheForTests, markPhotoViewed } from '../../lib/photoViewed';
import type { PhotoDocumentNav } from './PhotoDocumentPreview';

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => false, hasCapability: () => false, loading: false }),
}));
vi.mock('../../lib/db', () => ({
  withDb: async <T,>(fn: (dbi: unknown) => Promise<T>) =>
    fn({ get: async () => undefined, delete: async () => undefined }),
}));
vi.mock('../../lib/thumbQueue', () => ({
  enqueueThumbLoad: <T,>(fn: () => Promise<T>) => fn(),
  enqueueFullLoad: <T,>(fn: () => Promise<T>) => fn(),
}));

/** Оригиналы отдаём по команде теста: так видно, что до них отметки нет. */
const fullLoads = new Map<string, { resolve: () => void; reject: () => void }>();
vi.mock('../../services/api', () => ({
  api: { delete: vi.fn(), patch: vi.fn() },
  apiDownload: (path: string) => {
    if (path.includes('thumb=true')) return Promise.resolve({ blob: new Blob(['t']) });
    const id = path.split('/')[2]!;
    return new Promise((resolve, reject) => {
      fullLoads.set(id, {
        resolve: () => resolve({ blob: new Blob([`full-${id}`]) }),
        reject: () => reject(new Error('S3 недоступен')),
      });
    });
  },
  ApiError: class extends Error {},
}));
vi.mock('../../services/photoPipeline', () => ({ uploadPhoto: vi.fn() }));

type PreviewProps = {
  open: boolean;
  photoId: string;
  imageSrc?: string;
  nav?: PhotoDocumentNav;
  onOriginalDisplayed?: (id: string) => void;
};
let preview: PreviewProps | null = null;
vi.mock('./PhotoDocumentPreview', () => ({
  PhotoDocumentPreview: (p: PreviewProps) => {
    preview = p;
    return null;
  },
}));

const { PhotoGallery } = await import('./PhotoGallery');
type Gallery = Parameters<typeof PhotoGallery>[0]['photos'];

const DOC1 = 'd1111111-1111-1111-1111-111111111111';
const DOC2 = 'd2222222-2222-2222-2222-222222222222';
const DOC3 = 'd3333333-3333-3333-3333-333333333333';
const CARGO1 = 'c1111111-1111-1111-1111-111111111111';
const CARGO2 = 'c2222222-2222-2222-2222-222222222222';

function photo(id: string, kind: string, minute: number, uploaded = true): Gallery[number] {
  const at = new Date(Date.UTC(2026, 10, 18, 10, minute)).toISOString();
  return {
    id,
    kind,
    stage: 'before',
    s3Key: `k/${id}`,
    thumbS3Key: null,
    contentHash: null,
    takenAt: at,
    uploadedAt: uploaded ? at : null,
  } as Gallery[number];
}

const viewedKey = (id: string) => `matcheck.photoViewed.v1:u1:${id}`;

function renderGallery(photos: Gallery) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (p: Gallery) => (
    <QueryClientProvider client={client}>
      <PhotoGallery deliveryId="dddddddd-dddd-dddd-dddd-dddddddddddd" photos={p} />
    </QueryClientProvider>
  );
  const utils = render(ui(photos));
  return { ...utils, rerenderPhotos: (p: Gallery) => utils.rerender(ui(p)) };
}

/** Пробный Image галереи (декодируется ли оригинал) — в jsdom сам не грузится. */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 100;
  naturalHeight = 100;
  private value = '';
  set src(v: string) {
    this.value = v;
    setTimeout(() => this.onload?.(), 0);
  }
  get src(): string {
    return this.value;
  }
}

/**
 * Настоящее ожидание короткими шагами: внутри одного долгого act React
 * откладывает обновления до его конца, и отсчёт «простояло секунду»
 * стартовал бы уже после проверки. Шагами — как в браузере.
 */
async function sleep(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 50) {
    await act(() => new Promise<void>((r) => setTimeout(r, 50)));
  }
}

beforeAll(() => {
  vi.stubGlobal('Image', FakeImage);
});

beforeEach(() => {
  localStorage.clear();
  __resetPhotoViewedCacheForTests();
  useAuthStore.setState({ user: { id: 'u1' } as unknown as UserDto });
  fullLoads.clear();
  preview = null;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null });
});

/** Клик по миниатюре фото-документа (порядок миниатюр = порядок галереи). */
async function openDocument(index: number): Promise<void> {
  await waitFor(() =>
    expect(document.querySelectorAll('.ant-image').length).toBeGreaterThan(index),
  );
  fireEvent.click(document.querySelectorAll<HTMLElement>('.ant-image img')[index]!);
}

describe('PhotoGallery: отметка документа', { timeout: 20_000 }, () => {
  it('оригинал нарисован и простоял секунду — отмечен; раньше — нет', async () => {
    renderGallery([photo(DOC1, 'document', 1)]);
    await openDocument(0);
    expect(preview?.open).toBe(true);
    expect(preview?.photoId).toBe(DOC1);

    // Пока на экране миниатюра или спиннер — сигнала нет, отметки тоже.
    await sleep(1200);
    expect(localStorage.getItem(viewedKey(DOC1))).toBeNull();

    act(() => preview!.onOriginalDisplayed!(DOC1));
    await sleep(500);
    expect(localStorage.getItem(viewedKey(DOC1))).toBeNull();
    await sleep(700);
    expect(localStorage.getItem(viewedKey(DOC1))).not.toBeNull();
    // Галочка появилась на миниатюре.
    expect(await screen.findByLabelText('Просмотрено')).toBeTruthy();
  });

  it('листание: соседний документ, плейсхолдер — его миниатюра; пролистанный мимо не отмечен', async () => {
    renderGallery([
      photo(DOC1, 'document', 1),
      photo(DOC2, 'document', 2),
      photo(CARGO1, 'cargo', 3),
    ]);
    await openDocument(0);
    expect(preview?.nav).toMatchObject({ index: 0, total: 2 });

    act(() => preview!.onOriginalDisplayed!(DOC1));
    await sleep(300);
    act(() => preview!.nav!.onNext());
    expect(preview?.photoId).toBe(DOC2);
    expect(preview?.nav).toMatchObject({ index: 1, total: 2 });
    expect(preview?.imageSrc).toMatch(/^blob:/);

    // DOC1 простоял меньше секунды; DOC2 ещё не нарисован.
    await sleep(1200);
    expect(localStorage.getItem(viewedKey(DOC1))).toBeNull();
    expect(localStorage.getItem(viewedKey(DOC2))).toBeNull();
    act(() => preview!.onOriginalDisplayed!(DOC2));
    await sleep(1100);
    expect(localStorage.getItem(viewedKey(DOC2))).not.toBeNull();
    expect(localStorage.getItem(viewedKey(DOC1))).toBeNull();
  });

  it('документ, открытый до подтверждения загрузки, — без листания и без отметки', async () => {
    // Локальное фото с миниатюрой из IDB рисуется обычной плиткой; здесь
    // достаточно, что оно не подтверждено сервером.
    renderGallery([photo(DOC1, 'document', 1), photo(DOC2, 'document', 2)]);
    await openDocument(0);
    expect(preview?.nav).toBeDefined();
    cleanup();
    preview = null;
    markPhotoViewed(DOC3, 1);
    renderGallery([photo(DOC3, 'document', 1, false)]);
    // Неподтверждённое фото без локальной миниатюры — плитка «Загружается…»,
    // галочки на ней нет, хотя отметка с таким id в хранилище есть.
    expect(await screen.findByText('Загружается…')).toBeTruthy();
    expect(screen.queryByLabelText('Просмотрено')).toBeNull();
  });

  it('открытый документ удалили с другого клиента — окно переходит на соседний', async () => {
    const info = vi.spyOn(message, 'info').mockImplementation(() => undefined as never);
    const all = [
      photo(DOC1, 'document', 1),
      photo(DOC2, 'document', 2),
      photo(DOC3, 'document', 3),
    ];
    const { rerenderPhotos } = renderGallery(all);
    await openDocument(1);
    expect(preview?.photoId).toBe(DOC2);

    rerenderPhotos([all[0]!, all[2]!]);
    expect(preview?.photoId).toBe(DOC3);
    expect(preview?.open).toBe(true);
    expect(preview?.nav).toMatchObject({ index: 1, total: 2 });
    expect(info).toHaveBeenCalledWith('Документ удалён или сменил тип');

    // Был последним — на предыдущий.
    rerenderPhotos([all[0]!]);
    expect(preview?.photoId).toBe(DOC1);
    expect(preview?.nav).toBeUndefined();

    // Документов не осталось — окно закрывается.
    rerenderPhotos([photo(CARGO1, 'cargo', 5)]);
    expect(preview?.open).toBe(false);
    expect(info).toHaveBeenCalledTimes(3);
  });

  it('сменил тип на «Груз/машина» — тоже уходит из листания', async () => {
    vi.spyOn(message, 'info').mockImplementation(() => undefined as never);
    const { rerenderPhotos } = renderGallery([
      photo(DOC1, 'document', 1),
      photo(DOC2, 'document', 2),
    ]);
    await openDocument(0);
    rerenderPhotos([photo(DOC1, 'cargo', 1), photo(DOC2, 'document', 2)]);
    expect(preview?.photoId).toBe(DOC2);
  });
});

// Ожидания здесь настоящие (секунда «простоя» на каждое фото) — шире лимит.
describe('PhotoGallery: отметка фото груза в просмотре antd', { timeout: 20_000 }, () => {
  it('растянутая миниатюра — не просмотр; оригинал пришёл — отметка через секунду', async () => {
    renderGallery([photo(CARGO1, 'cargo', 1), photo(CARGO2, 'cargo', 2)]);
    await openDocument(0);
    await waitFor(() => expect(document.querySelector('.ant-image-preview-wrap')).toBeTruthy());

    await sleep(1300);
    expect(localStorage.getItem(viewedKey(CARGO1))).toBeNull();

    await waitFor(() => expect(fullLoads.has(CARGO1)).toBe(true));
    await act(async () => fullLoads.get(CARGO1)!.resolve());
    await sleep(1300);
    expect(localStorage.getItem(viewedKey(CARGO1))).not.toBeNull();
    // Соседнее фото, на которое не листали, не отмечено, даже с оригиналом.
    await act(async () => fullLoads.get(CARGO2)?.resolve());
    await sleep(1300);
    expect(localStorage.getItem(viewedKey(CARGO2))).toBeNull();

    // Листание стрелкой — отмечается фото, которое теперь на экране.
    fireEvent.keyDown(window, { key: 'ArrowRight', keyCode: 39 });
    await sleep(1300);
    expect(localStorage.getItem(viewedKey(CARGO2))).not.toBeNull();
  });

  it('оригинал не загрузился — отметки нет', async () => {
    renderGallery([photo(CARGO1, 'cargo', 1)]);
    await openDocument(0);
    await waitFor(() => expect(fullLoads.has(CARGO1)).toBe(true));
    await act(async () => fullLoads.get(CARGO1)!.reject());
    await sleep(1300);
    expect(localStorage.getItem(viewedKey(CARGO1))).toBeNull();
  });

  it('просмотр закрыт до истечения секунды — отметки нет; открыли снова — есть', async () => {
    renderGallery([photo(CARGO1, 'cargo', 1)]);
    await openDocument(0);
    await waitFor(() => expect(fullLoads.has(CARGO1)).toBe(true));
    await act(async () => fullLoads.get(CARGO1)!.resolve());
    await sleep(300);
    fireEvent.click(document.querySelector('.ant-image-preview-close')!);
    await sleep(1300);
    expect(localStorage.getItem(viewedKey(CARGO1))).toBeNull();

    // Открыли то же фото снова — оригинал уже в кэше, отметка через секунду.
    await openDocument(0);
    await sleep(1300);
    expect(localStorage.getItem(viewedKey(CARGO1))).not.toBeNull();
  });
});
