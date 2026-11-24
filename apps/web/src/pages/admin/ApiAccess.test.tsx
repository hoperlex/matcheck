// @vitest-environment jsdom
/**
 * «Администрирование → API-доступ».
 *
 * Главное обещание — секрет показывается один раз и нигде не остаётся: ни в
 * состоянии после закрытия окна, ни в кэше мутаций TanStack (MutationCache
 * держит ответ до gcTime, reset() его сразу не стирает), ни после ухода со
 * страницы, ни когда ответ пришёл уже после ухода.
 *
 * Плюс: статусы, у отозванного нет кнопок, подсказка «включение — с нового
 * токена», «Новый секрет» шлёт поколение, «Отозвать» — через подтверждение.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();

vi.mock('../../services/api', () => ({
  ApiError: class extends Error {},
  api: { get: apiGet, post: apiPost, patch: apiPatch, delete: vi.fn() },
}));

const { default: AdminApiAccessPage } = await import('./ApiAccess');

const SECRET = 'mcs_SECRET_value_only_once_0123456789abcdefghijklmn';

const base = {
  description: null,
  scopes: ['onec.deliveries:read'],
  allowAck: false,
  allowedCidrs: null,
  createdAt: '2026-11-24T08:00:00.000Z',
  createdByName: 'Админ',
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: '2026-11-24T09:00:00.000Z',
  lastTokenIp: '203.0.113.5',
  secretGeneration: 1,
};
const active = { ...base, id: '11111111-1111-4111-8111-111111111111', clientId: 'api-aaaaaaaaaaaa', name: 'api_1C', status: 'active' };
const expired = {
  ...base,
  id: '22222222-2222-4222-8222-222222222222',
  clientId: 'api-bbbbbbbbbbbb',
  name: 'api_1C_test',
  status: 'expired',
  expiresAt: '2026-11-01T00:00:00.000Z',
};
const revoked = {
  ...base,
  id: '33333333-3333-4333-8333-333333333333',
  clientId: 'api-cccccccccccc',
  name: 'старый ключ',
  status: 'revoked',
  revokedAt: '2026-11-20T00:00:00.000Z',
};

let client: QueryClient;

beforeEach(() => {
  apiGet.mockReset().mockImplementation(async (url: string) => {
    if (url === '/admin/api-keys') return [active, expired, revoked];
    throw new Error(`unexpected GET ${url}`);
  });
  apiPost.mockReset();
  apiPatch.mockReset().mockResolvedValue(active);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => cleanup());

function renderPage() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AdminApiAccessPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const rowOf = (name: string) => screen.getByText(name).closest<HTMLElement>('tr')!;
/** Всё, что TanStack держит про мутации, — строкой. */
const mutationCacheDump = () => JSON.stringify(client.getMutationCache().getAll().map((m) => m.state));

async function createKey() {
  fireEvent.click(screen.getByRole('button', { name: 'Новый ключ' }));
  const dialog = await screen.findByRole('dialog', { name: 'Новый API-ключ' });
  fireEvent.change(within(dialog).getByLabelText('Название'), { target: { value: '1С бухгалтерия' } });
  fireEvent.click(within(dialog).getByRole('checkbox'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Создать ключ' }));
}

describe('список ключей', () => {
  it('статусы и кнопки; у отозванного кнопок нет', async () => {
    renderPage();
    await screen.findByText('api_1C');
    expect(within(rowOf('api_1C')).getByText('Активен')).toBeTruthy();
    expect(within(rowOf('api_1C_test')).getByText('Истёк')).toBeTruthy();
    expect(within(rowOf('старый ключ')).getByText('Отозван')).toBeTruthy();
    expect(within(rowOf('api_1C')).getByRole('button', { name: 'Новый секрет' })).toBeTruthy();
    expect(within(rowOf('старый ключ')).queryByRole('button', { name: 'Отозвать' })).toBeNull();
    expect(within(rowOf('старый ключ')).queryByRole('button', { name: 'Доступы' })).toBeNull();
  });
});

describe('секрет — один раз и нигде не остаётся', () => {
  it('создание: секрет в окне, в кэше мутаций его нет; закрытие стирает', async () => {
    apiPost.mockResolvedValue({ key: { ...active, name: '1С бухгалтерия' }, clientSecret: SECRET });
    renderPage();
    await screen.findByText('api_1C');
    await createKey();
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/admin/api-keys', {
        name: '1С бухгалтерия',
        description: undefined,
        allowAck: true,
        expiresAt: null,
      }),
    );
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(mutationCacheDump()).not.toContain(SECRET);

    fireEvent.click(screen.getByRole('button', { name: 'Я сохранил секрет' }));
    await waitFor(() => expect(screen.queryByDisplayValue(SECRET)).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(mutationCacheDump()).not.toContain(SECRET);
  });

  it('уход со страницы с открытым окном: секрета нет ни в DOM, ни в кэше', async () => {
    apiPost.mockResolvedValue({ key: active, clientSecret: SECRET });
    const view = renderPage();
    await screen.findByText('api_1C');
    await createKey();
    await screen.findByDisplayValue(SECRET);
    view.unmount();
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(mutationCacheDump()).not.toContain(SECRET);
  });

  it('ответ пришёл после ухода со страницы: секрет нигде не появился', async () => {
    let resolve: (v: unknown) => void = () => {};
    apiPost.mockReturnValue(new Promise((r) => (resolve = r)));
    const view = renderPage();
    await screen.findByText('api_1C');
    await createKey();
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    view.unmount();
    resolve({ key: active, clientSecret: SECRET });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(mutationCacheDump()).not.toContain(SECRET);
  });

  it('«Новый секрет» — через подтверждение, с поколением; секрет показывается и в кэше его нет', async () => {
    apiPost.mockResolvedValue({ key: { ...active, secretGeneration: 2 }, clientSecret: SECRET });
    renderPage();
    await screen.findByText('api_1C');
    fireEvent.click(within(rowOf('api_1C')).getByRole('button', { name: 'Новый секрет' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Выпустить' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/admin/api-keys/${active.id}/rotate-secret`, { expectedGeneration: 1 }),
    );
    expect(await screen.findByDisplayValue(SECRET)).toBeTruthy();
    expect(mutationCacheDump()).not.toContain(SECRET);
  });
});

describe('доступы и отзыв', () => {
  it('в «Доступах» подсказка: включение подтверждения — с нового токена; сохранение шлёт поля', async () => {
    renderPage();
    await screen.findByText('api_1C');
    fireEvent.click(within(rowOf('api_1C')).getByRole('button', { name: 'Доступы' }));
    const dialog = await screen.findByRole('dialog', { name: 'Доступы: api_1C' });
    expect(within(dialog).getByText(/когда 1С получит новый токен/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/admin/api-keys/${active.id}`, {
        name: 'api_1C',
        description: '',
        allowAck: true,
        expiresAt: null,
      }),
    );
  });

  it('«Отозвать» — только после подтверждения', async () => {
    apiPost.mockResolvedValue({ ...active, status: 'revoked' });
    renderPage();
    await screen.findByText('api_1C');
    fireEvent.click(within(rowOf('api_1C')).getByRole('button', { name: 'Отозвать' }));
    expect(apiPost).not.toHaveBeenCalled();
    const popover = await screen.findByText('Ключ перестанет работать сразу. Отменить нельзя.');
    const confirm = popover.closest<HTMLElement>('.ant-popover')!;
    fireEvent.click(within(confirm).getByRole('button', { name: 'Отозвать' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith(`/admin/api-keys/${active.id}/revoke`));
  });
});
