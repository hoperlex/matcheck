// @vitest-environment jsdom
/**
 * Управление кадрами в галерее: ячейка И возможность.
 *
 * Ровно этот контрол ревью нашло дефектом №1: галерея гейтилась одной ячейкой
 * матрицы, а `DELETE`/`PATCH /photos/:id` открыты только admin/manager — у
 * инспектора `operations.*:delete` базовое, и ему рисовалась кнопка,
 * отвечающая 403. Здесь закрепляется, что нужны ОБА условия: снятая ячейка
 * убирает кнопку даже при доступном маршруте, а отсутствие возможности — даже
 * при выданной ячейке.
 */
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.fn();
const hasCapability = vi.fn();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability, loading: false }),
}));

// IndexedDB, очередь загрузки и сеть к предмету теста отношения не имеют:
// проверяется, какие контролы попали в разметку, а не как грузится кадр.
vi.mock('../../lib/db', () => ({
  db: async () => ({ get: async () => undefined, delete: async () => undefined }),
}));
vi.mock('../../lib/thumbQueue', () => ({
  enqueueThumbLoad: <T,>(fn: () => Promise<T>) => fn(),
  enqueueFullLoad: <T,>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../../services/api', () => ({
  api: { delete: vi.fn(), patch: vi.fn() },
  apiDownload: async () => ({ blob: new Blob(['x']) }),
  ApiError: class extends Error {},
}));
vi.mock('../../services/photoPipeline', () => ({ uploadPhoto: vi.fn() }));
vi.mock('./PhotoDocumentPreview', () => ({ PhotoDocumentPreview: () => null }));

import { PhotoGallery, type GalleryPhoto } from './PhotoGallery';

const photo = {
  id: '22222222-2222-2222-2222-222222222222',
  // uploadedAt непустой — иначе плитка уходит в ветку «Загружается…», где
  // управления типом нет по замыслу.
  uploadedAt: new Date('2026-08-13T10:00:00Z').toISOString(),
  takenAt: new Date('2026-08-13T10:00:00Z').toISOString(),
  kind: 'document',
  stage: null,
} as unknown as GalleryPhoto;

function renderGallery(readOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PhotoGallery deliveryId="11111111-1111-1111-1111-111111111111" photos={[photo]} readOnly={readOnly} />
    </QueryClientProvider>,
  );
}

/** Иконочные кнопки antd подписи не имеют — ищем по классу иконки. */
const hasIcon = (c: HTMLElement, name: string) => c.querySelector(`.anticon-${name}`) !== null;

beforeEach(() => {
  can.mockReset();
  hasCapability.mockReset();
});
afterEach(() => cleanup());

describe('PhotoGallery: удаление и смена типа кадра', () => {
  it('ячейка и возможность есть — обе кнопки на месте', () => {
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(true);
    const { container } = renderGallery();
    expect(hasIcon(container, 'delete')).toBe(true);
    expect(hasIcon(container, 'edit')).toBe(true);
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'delete');
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'edit');
    expect(hasCapability).toHaveBeenCalledWith('operations.photo.manage');
  });

  it('РЕГРЕСС: возможности нет — кнопок нет, хотя ячейки выданы', () => {
    // Случай инспектора: ячейки базовые, а маршрут фото ему закрыт.
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(false);
    const { container } = renderGallery();
    expect(hasIcon(container, 'delete')).toBe(false);
    expect(hasIcon(container, 'edit')).toBe(false);
  });

  it('ячейки сняты — кнопок нет, хотя маршрут роль пропускает', () => {
    // Случай менеджера со снятым правом: allow-list его пускает, но
    // администратор запретил — интерфейс обязан подчиниться матрице.
    can.mockReturnValue(false);
    hasCapability.mockReturnValue(true);
    const { container } = renderGallery();
    expect(hasIcon(container, 'delete')).toBe(false);
    expect(hasIcon(container, 'edit')).toBe(false);
  });

  it('режим просмотра гасит управление независимо от прав', () => {
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(true);
    const { container } = renderGallery(true);
    expect(hasIcon(container, 'delete')).toBe(false);
    expect(hasIcon(container, 'edit')).toBe(false);
  });
});
