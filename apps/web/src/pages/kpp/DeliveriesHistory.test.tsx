// @vitest-environment jsdom
/**
 * Действия в строке истории поступлений — по матрице, а не по имени роли.
 *
 * До шага 7 весь блок действий прятался за `isMonitor`/`isContractor`, и
 * выданное администратором право не давало ничего. Здесь проверяется обратное:
 * контрол появляется ровно тогда, когда право есть, и исчезает, когда снято.
 *
 * Отдельным сценарием — «Поделиться»: у создания ссылки свой allow-list, и
 * одной ячейки `edit` для неё мало. Ревью нашло это дефектом №5.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const can = vi.fn();
const hasCapability = vi.fn();
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can, hasCapability, canView: () => true, loading: false }),
}));

const authUser = { id: 'u-1', email: 'manager@test.com', role: 'manager' };
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: authUser }),
}));

const row = {
  id: '11111111-1111-1111-1111-111111111111',
  displayId: 7,
  // draft — ветка hard-delete: кнопка удаления рисуется прямо в строке.
  status: { code: 'draft', label: 'Черновик', color: null },
  siteId: '33333333-3333-3333-3333-333333333333',
  siteName: 'Объект 1',
  supplierId: null,
  contractorId: null,
  supplierName: null,
  contractorName: null,
  vehiclePlate: 'А123ВС77',
  driverName: null,
  arrivedAt: '2026-08-13T10:00:00.000Z',
  inTransit: false,
  isAssets: false,
  pendingDeletionAt: null,
  pendingDeletionByUserId: null,
  reviewState: 'approved',
  items: [],
  photos: [],
  sourceDocumentIds: [],
  primarySourceDocument: null,
  itemCount: 0,
  photoCount: 0,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z',
};

// Сеть заменена данными: предмет теста — разметка строки, а не загрузка.
vi.mock('../../services/api', () => ({
  ApiError: class extends Error {},
  api: {
    get: async (url: string) =>
      url.startsWith('/deliveries') ? { items: [row], total: 1 } : { items: [], total: 0 },
  },
}));
vi.mock('../../services/deliveries', () => ({
  hardDeleteDelivery: vi.fn(),
  markDeletion: vi.fn(),
  unmarkDeletion: vi.fn(),
}));
// Модалки к предмету теста отношения не имеют и тянут галерею с IndexedDB.
vi.mock('./DeliveryViewModal', () => ({ DeliveryViewModal: () => null }));
vi.mock('../../components/ShareLinkModal', () => ({ ShareLinkModal: () => null }));

import { DeliveriesHistory } from './DeliveriesHistory';

async function renderHistory(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DeliveriesHistory onOpen={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  // Строка приезжает асинхронно — до неё проверять нечего.
  await waitFor(() => expect(screen.getByText('А123ВС77')).toBeDefined());
  return container;
}

const hasIcon = (c: HTMLElement, name: string) => c.querySelector(`.anticon-${name}`) !== null;

beforeEach(() => {
  can.mockReset();
  hasCapability.mockReset();
});
afterEach(() => cleanup());

/**
 * Подрядчик убран из СПИСКА, но не из системы.
 *
 * В списке это поле почти всегда повторяло покупателя документа и занимало
 * ширину, поэтому колонку убрали — и из десктопной таблицы, и из карточки на
 * узком экране (там таблица не рендерится вовсе, и поле рисовалось отдельным
 * JSX). А вот фильтр «Подрядчик» над таблицей остался: отбирать поступления по
 * подрядчику по-прежнему нужно. Тест держит обе границы сразу.
 */
describe('DeliveriesHistory: подрядчик не показывается в списке', () => {
  const CONTRACTOR = 'ООО «Подрядчик Тест»';

  beforeEach(() => {
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(true);
    // contractorId обязателен, а не «для полноты»: прежний renderContractor
    // начинался с resolveContractor и на пустом id возвращал прочерк — тест на
    // одном лишь contractorName проходил бы и со старым кодом, ничего не
    // проверяя.
    row.contractorId = '44444444-4444-4444-4444-444444444444';
    row.contractorName = CONTRACTOR;
  });
  afterEach(() => {
    row.contractorId = null;
    row.contractorName = null;
  });

  it('имени подрядчика нет ни в таблице, ни в карточке', async () => {
    await renderHistory();
    expect(screen.queryByText(CONTRACTOR)).toBeNull();
    // Объект остался — проверяем, что исчез именно подрядчик, а не вся строка
    // вторичных данных рядом с ним.
    expect(screen.getByText('Объект 1')).toBeDefined();
  });

  it('заголовка колонки «Подрядчик» в таблице нет', async () => {
    const container = await renderHistory();
    const headers = [...container.querySelectorAll('th')].map((th) => th.textContent ?? '');
    expect(headers).not.toContain('Подрядчик');
    // Соседние колонки на месте — правка не задела остальной набор.
    expect(headers.some((h) => h.includes('Объект'))).toBe(true);
  });

  it('фильтр «Подрядчик» над таблицей остаётся', async () => {
    const container = await renderHistory();
    const placeholders = [...container.querySelectorAll('.ant-select-selection-placeholder')].map(
      (el) => el.textContent ?? '',
    );
    expect(placeholders).toContain('Подрядчик');
  });
});

describe('DeliveriesHistory: действия в строке', () => {
  it('права выданы — правка, удаление и ссылка на месте', async () => {
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(true);
    const c = await renderHistory();
    expect(hasIcon(c, 'edit')).toBe(true);
    expect(hasIcon(c, 'delete')).toBe(true);
    expect(hasIcon(c, 'share-alt')).toBe(true);
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'edit');
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'delete');
  });

  it('прав нет — остаётся только просмотр', async () => {
    can.mockReturnValue(false);
    hasCapability.mockReturnValue(true);
    const c = await renderHistory();
    expect(hasIcon(c, 'edit')).toBe(false);
    expect(hasIcon(c, 'delete')).toBe(false);
    expect(hasIcon(c, 'share-alt')).toBe(false);
    // Просмотр — базовое право видящей роли, его убирать нечем.
    expect(hasIcon(c, 'eye')).toBe(true);
  });

  it('РЕГРЕСС: снят edit — ссылки нет, хотя возможность есть', async () => {
    // Список ссылок открыт всем (always), поэтому одна возможность оставила бы
    // кнопку менеджеру со снятой правкой — и создание вернуло бы 403.
    can.mockImplementation((_page: string, action: string) => action !== 'edit');
    hasCapability.mockReturnValue(true);
    const c = await renderHistory();
    expect(hasIcon(c, 'share-alt')).toBe(false);
    expect(hasIcon(c, 'edit')).toBe(false);
    // Удаление независимо и остаётся.
    expect(hasIcon(c, 'delete')).toBe(true);
  });

  it('возможности нет — ссылки нет, хотя edit выдан', async () => {
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(false);
    const c = await renderHistory();
    expect(hasIcon(c, 'share-alt')).toBe(false);
    expect(hasIcon(c, 'edit')).toBe(true);
    expect(hasCapability).toHaveBeenCalledWith('operations.share.manage');
  });
});

describe('DeliveriesHistory: отметка проверки по матрице', () => {
  it('право review выдано — значок и легенда на месте', async () => {
    // До этой правки видимость отметки решал список ролей
    // (isAdmin || manager || monitor). Роль без базовых прав в него не попадала,
    // и выданная галочка «Проверять» не давала ничего: кнопка отметки была, а
    // увидеть результат было негде.
    can.mockReturnValue(true);
    hasCapability.mockReturnValue(true);
    const c = await renderHistory();
    expect(can).toHaveBeenCalledWith('operations.deliveries', 'review');
    expect(screen.getAllByText('Проверено').length).toBeGreaterThan(0);
    expect(hasIcon(c, 'safety-certificate')).toBe(true);
  });

  it('право review снято — легенды нет', async () => {
    // Значок в строке проверяется отдельно: он приходит из DTO, который сервер
    // обнуляет при снятой галочке (canSeeReviewInMatrix). Здесь предмет —
    // именно решение интерфейса: расшифровку значков рисовать или нет.
    can.mockImplementation((_page: string, action: string) => action !== 'review');
    hasCapability.mockReturnValue(true);
    await renderHistory();
    expect(screen.queryByText('Проверено')).toBeNull();
    expect(screen.queryByText('Есть замечания')).toBeNull();
  });
});
