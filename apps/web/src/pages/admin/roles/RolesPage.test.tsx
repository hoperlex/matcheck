// @vitest-environment jsdom
/**
 * Проводка вкладки «Роли»: что именно уходит в PATCH и что происходит с
 * черновиком после ответа.
 *
 * Юнит-тесты matrixDraft проверяют правила черновика, но не связку. А ломалась
 * именно она: «Сохранить» отправлял правки ВСЕХ ролей сразу, поэтому застрявшая
 * ячейка одной вкладки отменяла транзакцию целиком — и правки роли, которую
 * человек редактировал прямо сейчас, не доезжали никогда.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MATRIX,
  LOCKED_CELLS,
  PAGE_CATALOG,
  type RolePermissionsResponse,
} from '@matcheck/contracts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock('../../../services/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
      public payload?: unknown,
    ) {
      super(message);
    }
  },
  api: { get: mocks.get, patch: mocks.patch, delete: mocks.del },
}));

/** Ответ сервера: дефолтная матрица, каталог как есть. */
function response(): RolePermissionsResponse {
  return {
    enforced: true,
    catalog: PAGE_CATALOG.map((p) => ({
      id: p.id,
      group: p.group,
      label: p.label,
      actions: p.actions,
      hidden: p.hidden ?? false,
      base: p.base,
    })),
    matrix: structuredClone(DEFAULT_MATRIX),
    lockedCells: [...LOCKED_CELLS],
    overrideRows: {},
    cellCoverage: {},
  } as RolePermissionsResponse;
}

import RolesPage from './RolesPage';

async function renderPage(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <RolesPage />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByText('Справочники')).toBeDefined());
  return container;
}

/** Групповой чекбокс действия в шапке раздела — им удобно наполнять черновик. */
function groupBox(container: HTMLElement, group: string, action: string): HTMLInputElement {
  const card = [...container.querySelectorAll('.ant-card')].find((c) =>
    c.querySelector('.ant-card-head')?.textContent?.includes(group),
  );
  if (!card) throw new Error(`раздел «${group}» не найден`);
  const label = [...card.querySelectorAll('.ant-card-head label')].find(
    (l) => l.textContent?.trim() === action,
  );
  if (!label) throw new Error(`действие «${action}» в разделе «${group}» не найдено`);
  return label.querySelector('input')!;
}

const tab = (name: string) => screen.getByRole('button', { name });
const button = (name: string) => screen.getByRole('button', { name });

/** Наполнить черновики двух ролей: у менеджера — удаление, у монитора — просмотр. */
async function dirtyBothRoles(container: HTMLElement) {
  fireEvent.click(groupBox(container, 'Справочники', 'Удалять'));
  fireEvent.click(tab('Мониторинг'));
  await waitFor(() => expect(groupBox(container, 'Справочники', 'Просмотр')).toBeDefined());
  fireEvent.click(groupBox(container, 'Справочники', 'Просмотр'));
  fireEvent.click(tab('Менеджер'));
}

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(response());
  mocks.patch.mockReset().mockResolvedValue(response());
  mocks.del.mockReset().mockResolvedValue(response());
});
afterEach(() => cleanup());

describe('вкладка «Роли»: сохранение', () => {
  it('отправляет правки только активной роли', async () => {
    const container = await renderPage();
    await dirtyBothRoles(container);

    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalled());
    const [, body] = mocks.patch.mock.calls[0] as [string, { changes: { role: string }[] }];
    expect(body.changes.length).toBeGreaterThan(0);
    expect(body.changes.every((c) => c.role === 'manager')).toBe(true);
  });

  it('черновик соседней роли переживает сохранение', async () => {
    const container = await renderPage();
    await dirtyBothRoles(container);

    fireEvent.click(button('Сохранить'));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalled());

    // Менеджер сохранён — его тег ушёл...
    await waitFor(() => expect(screen.queryByText('Есть несохранённые изменения')).toBeNull());
    // ...а незавершённая работа на вкладке монитора осталась.
    fireEvent.click(tab('Мониторинг'));
    await waitFor(() => expect(screen.getByText('Есть несохранённые изменения')).toBeDefined());
  });

  it('тег несохранённого — про активную вкладку, а не про все роли', async () => {
    // Общий тег висел из-за правок соседней роли и читался как «сохранение не
    // прошло»: именно с этого начиналась путаница.
    const container = await renderPage();
    fireEvent.click(tab('Мониторинг'));
    await waitFor(() => expect(groupBox(container, 'Справочники', 'Просмотр')).toBeDefined());
    fireEvent.click(groupBox(container, 'Справочники', 'Просмотр'));

    fireEvent.click(tab('Менеджер'));

    await waitFor(() => expect(screen.queryByText('Есть несохранённые изменения')).toBeNull());
  });

  it('«Отменить» откатывает только активную роль', async () => {
    const container = await renderPage();
    await dirtyBothRoles(container);

    fireEvent.click(button('Отменить'));

    await waitFor(() => expect(screen.queryByText('Есть несохранённые изменения')).toBeNull());
    fireEvent.click(tab('Мониторинг'));
    await waitFor(() => expect(screen.getByText('Есть несохранённые изменения')).toBeDefined());
  });

  it('на вкладке «Администратор» сохранять нечего', async () => {
    // `role` продолжает хранить последнюю managed-роль, поэтому без отдельного
    // понятия активной роли кнопки работали бы здесь от имени скрытой вкладки.
    const container = await renderPage();
    fireEvent.click(groupBox(container, 'Справочники', 'Удалять'));
    fireEvent.click(tab('Администратор'));

    await waitFor(() =>
      expect(screen.getByText('Права администратора не настраиваются')).toBeDefined(),
    );
    expect(button('Сохранить').hasAttribute('disabled')).toBe(true);
    expect(button('Отменить').hasAttribute('disabled')).toBe(true);
    expect(button('Сбросить к дефолту').hasAttribute('disabled')).toBe(true);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe('вкладка «Роли»: отказ сервера', () => {
  it('конфликт от старого сервера не запирает страницу навсегда', async () => {
    // Сервер прошлой версии подробностей не присылает. Двигать снимок вслепую
    // нечем, поэтому роль откатывается к серверу — иначе повтор уходил бы с тем
    // же устаревшим expected и получал тот же отказ, сколько ни жми.
    const { ApiError } = await import('../../../services/api');
    mocks.patch.mockRejectedValue(new ApiError(409, 'stale_cell', 'конфликт'));

    const container = await renderPage();
    fireEvent.click(groupBox(container, 'Справочники', 'Удалять'));
    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Есть несохранённые изменения')).toBeNull());
  });

  it('конфликт с подробностями сдвигает снимок и не теряет галочки', async () => {
    const { ApiError } = await import('../../../services/api');
    mocks.patch.mockRejectedValue(
      new ApiError(409, 'stale_cell', 'конфликт', {
        details: {
          conflicts: [
            { role: 'manager', page: 'references.sites', action: 'delete', actual: true },
          ],
        },
      }),
    );

    const container = await renderPage();
    fireEvent.click(groupBox(container, 'Справочники', 'Удалять'));
    fireEvent.click(button('Сохранить'));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalled());

    // Галочка осталась выбором человека: сдвинулся снимок, а не черновик.
    await waitFor(() => expect(groupBox(container, 'Справочники', 'Удалять').checked).toBe(true));

    // И главное: повтор уходит уже без конфликтной ячейки. Фактическое значение
    // совпало с желаемым, поэтому правка исчезла как применённая — раньше она
    // возвращалась в дельту с тем же устаревшим expected и отбивалась вечно.
    mocks.patch.mockResolvedValue(response());
    fireEvent.click(button('Сохранить'));

    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(2));
    const [, body] = mocks.patch.mock.calls[1] as [string, { changes: { page: string }[] }];
    expect(body.changes.some((c) => c.page === 'references.sites')).toBe(false);
    expect(body.changes.length).toBeGreaterThan(0);
  });
});
