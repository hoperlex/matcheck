// @vitest-environment jsdom
/**
 * Справочник поставщиков: сортировка и фильтр в колонках работают по ВСЕМУ
 * списку, а не по видимой странице из 100 строк.
 *
 * Плюс две защиты:
 * - фильтр по колонке снимает массовый выбор — иначе «Удалить выбранные» ушло
 *   бы в строки, которые фильтр спрятал;
 * - если сервер отдал не весь справочник (total больше загруженного), стрелок
 *   и воронок нет: сортировать срез значило бы врать.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

function supplier(i: number, name: string, aliases: string[] = []) {
  return {
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    name,
    inn: `77${String(i).padStart(8, '0')}`,
    kpp: null,
    address: null,
    aliases,
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

// 120 поставщиков: на первой странице (100) нет «Ярославского», он на второй.
const SUPPLIERS = [
  ...Array.from({ length: 118 }, (_, i) => supplier(i + 1, `ООО «Поставщик ${i + 1}»`)),
  supplier(200, 'АО «Альфа»', ['Альфа-Строй']),
  supplier(201, 'ООО «Ярославский»', ['Альфа-Строй']),
];

const apiState = vi.hoisted(() => ({ total: null as number | null }));

vi.mock('../../services/api', () => ({
  api: {
    get: async () => ({ items: SUPPLIERS, total: apiState.total ?? SUPPLIERS.length }),
    post: async () => ({ ok: true }),
    patch: async () => ({}),
    delete: async () => ({}),
  },
  ApiError: class extends Error {},
}));

const { default: SuppliersPage } = await import('./Suppliers');

afterEach(() => {
  cleanup();
  apiState.total = null;
});

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SuppliersPage />
    </QueryClientProvider>,
  );
}

function th(container: HTMLElement, title: string): HTMLElement {
  return Array.from(container.querySelectorAll<HTMLElement>('.ant-table-thead th')).find(
    (el) => el.textContent?.trim() === title,
  )!;
}

function shownNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.ant-table-tbody > tr.ant-table-row')).map(
    (tr) => tr.textContent ?? '',
  );
}

describe('Справочник поставщиков: сортировка и фильтр в колонках', () => {
  it('сортировка по названию — по всему справочнику, а не по странице', async () => {
    const { container } = renderPage();
    await screen.findByText('ООО «Поставщик 1»');
    const name = th(container, 'Название');
    fireEvent.click(name); // по возрастанию
    fireEvent.click(name); // по убыванию
    // «Ярославский» пришёл последним и до сортировки был на второй странице.
    await waitFor(() => expect(shownNames(container)[0]).toContain('ООО «Ярославский»'));
  });

  it('фильтр по альтернативному названию находит строки с обеих страниц', async () => {
    const { container } = renderPage();
    await screen.findByText('ООО «Поставщик 1»');
    fireEvent.click(
      th(container, 'Альтернативные названия').querySelector('.ant-table-filter-trigger')!,
    );
    const dialog = await screen.findByRole('dialog');
    const option = within(dialog).getByText('Альфа-Строй').closest('label')!;
    expect(option.textContent).toContain('2');
    fireEvent.click(option.querySelector('input')!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(shownNames(container)).toHaveLength(2));
    const names = shownNames(container).join(' | ');
    expect(names).toContain('АО «Альфа»');
    expect(names).toContain('ООО «Ярославский»');
  });

  it('счётчики окна учитывают фильтр соседней колонки', async () => {
    const { container } = renderPage();
    await screen.findByText('ООО «Поставщик 1»');
    // Сначала оставляем только «Альфа-Строй»…
    fireEvent.click(
      th(container, 'Альтернативные названия').querySelector('.ant-table-filter-trigger')!,
    );
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByText('Альфа-Строй').closest('label')!.querySelector('input')!,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(shownNames(container)).toHaveLength(2));
    // …и в окне «Названия» остаются только два названия.
    fireEvent.click(th(container, 'Название').querySelector('.ant-table-filter-trigger')!);
    dialog = await screen.findByRole('dialog');
    const options = within(dialog).getAllByRole('checkbox');
    expect(options).toHaveLength(2);
  });

  it('фильтр по колонке снимает массовый выбор', async () => {
    const { container } = renderPage();
    await screen.findByText('ООО «Поставщик 1»');
    fireEvent.click(container.querySelector('.ant-table-tbody .ant-checkbox-input')!);
    expect(await screen.findByText('Выбрано:')).toBeTruthy();
    fireEvent.click(
      th(container, 'Альтернативные названия').querySelector('.ant-table-filter-trigger')!,
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByText('Альфа-Строй').closest('label')!.querySelector('input')!,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(screen.queryByText('Выбрано:')).toBeNull());
  });

  it('справочник загружен не целиком — без стрелок и воронок, с подсказкой', async () => {
    apiState.total = 6000;
    const { container } = renderPage();
    await screen.findByText('ООО «Поставщик 1»');
    expect(container.querySelector('.ant-table-filter-trigger')).toBeNull();
    expect(screen.getByText(/Показаны первые 120 из 6000/)).toBeTruthy();
  });
});
