// @vitest-environment jsdom
/**
 * «ЭДО учётки» с учёткой СБИС рядом с Диадоком.
 *
 * Обещания выпуска Р3:
 *   - у каждой учётки виден оператор; у СБИС нет кнопок Диадока (ящик, импорт,
 *     журнал, опрос) — сервер на них отвечает отказом;
 *   - «Проверить доступ» у СБИС показывает организации кабинета, организация
 *     выбирается ссылкой из ответа; без ЭДО — не выбрать;
 *   - заведение СБИС отправляет три ключа и ничего от Диадока;
 *   - правка СБИС не шлёт пустые ключи;
 *   - отказ сервера показывается его текстом;
 *   - строка Диадока — с прежними кнопками.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({ can: () => true, hasCapability: () => true, canView: () => true, loading: false }),
}));

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiDelete = vi.fn();

vi.mock('../../services/api', () => ({
  ApiError: class extends Error {},
  api: { get: apiGet, post: apiPost, patch: apiPatch, delete: apiDelete },
}));

const { default: AdminEdoAccountsPage } = await import('./EdoAccounts');

const common = {
  isActive: true,
  pollEnabled: false,
  importEnabled: false,
  environment: 'production',
  orgInn: null,
  defaultSiteId: null,
  hasClientSecret: false,
  hasRefreshToken: false,
  clientId: null,
  clientSecretLength: null,
  refreshTokenLength: null,
  clientSecretFingerprint: null,
  refreshTokenFingerprint: null,
  refreshTokenAgeDays: null,
  lastEventAt: null,
  lastSyncAt: null,
  lastOkAt: null,
  lastError: null,
  backfillSince: null,
};

const diadoc = {
  ...common,
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'diadoc',
  authMode: 'oidc_refresh',
  name: 'Диадок СУ-10',
  boxId: 'e4f1c2d3-0000-4000-8000-000000000000',
  clientId: 'ci_su-10',
  refreshTokenAgeDays: 3,
};

const sbis = {
  ...common,
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'sbis',
  authMode: 'sbis_service_key',
  name: 'СБИС СУ-10',
  boxId: null,
  sbisAppClientId: '1025293145607151',
  sbisAppSecretLength: 24,
  sbisAppSecretFingerprint: 'a1b2c3d4',
  sbisSecretKeyLength: 36,
  sbisSecretKeyFingerprint: 'e5f6a7b8',
};

const SU10 = 'legal:7736255508:774550001:';
const checkResult = {
  provider: 'sbis',
  complete: true,
  organizations: [
    { ref: SU10, kind: 'legal', inn: '7736255508', kpp: '774550001', branch: null, name: 'СУ-10', edo: true },
    { ref: 'person:500100732259::', kind: 'person', inn: '500100732259', kpp: null, branch: null, name: 'Иванов', edo: false },
  ],
};

let accounts: unknown[] = [];

beforeEach(() => {
  accounts = [diadoc, sbis];
  apiGet.mockReset().mockImplementation(async (url: string) => {
    if (url === '/admin/edo-accounts') return accounts;
    throw new Error(`unexpected GET ${url}`);
  });
  apiPost.mockReset();
  apiPatch.mockReset().mockResolvedValue({});
  apiDelete.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AdminEdoAccountsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByText('СБИС СУ-10');
}

const rowOf = (name: string) => screen.getByText(name).closest<HTMLElement>('tr')!;

describe('таблица учёток', () => {
  it('у каждой учётки оператор; у СБИС — свои кнопки, у Диадока — прежние', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: 'ЭДО учётки' })).toBeTruthy();

    const sbisRow = within(rowOf('СБИС СУ-10'));
    expect(sbisRow.getByText('СБИС')).toBeTruthy();
    expect(sbisRow.getByText('организация не выбрана')).toBeTruthy();
    expect(sbisRow.getByRole('button', { name: 'Проверить доступ' })).toBeTruthy();
    expect(sbisRow.queryByRole('button', { name: 'Осмотреть ящик' })).toBeNull();
    expect(sbisRow.queryByRole('button', { name: 'Синхронизировать' })).toBeNull();
    expect(sbisRow.queryByRole('switch')).toBeNull();

    const diadocRow = within(rowOf('Диадок СУ-10'));
    expect(diadocRow.getByText('Диадок')).toBeTruthy();
    expect(diadocRow.getByRole('button', { name: 'Осмотреть ящик' })).toBeTruthy();
    expect(diadocRow.getByRole('button', { name: 'Синхронизировать' })).toBeTruthy();
    expect(diadocRow.getByRole('switch')).toBeTruthy();
  });

  it('выбранная организация СБИС подписана ИНН и КПП', async () => {
    accounts = [diadoc, { ...sbis, boxId: SU10, orgInn: '7736255508' }];
    await renderPage();
    const row = within(rowOf('СБИС СУ-10'));
    expect(row.getByText('7736255508')).toBeTruthy();
    expect(row.getByText('774550001')).toBeTruthy();
    expect(row.queryByText('организация не выбрана')).toBeNull();
  });
});

describe('«Проверить доступ» у СБИС', () => {
  it('организации кабинета; «Использовать» шлёт ссылку из ответа; без ЭДО — не выбрать', async () => {
    apiPost.mockResolvedValue(checkResult);
    await renderPage();
    fireEvent.click(within(rowOf('СБИС СУ-10')).getByRole('button', { name: 'Проверить доступ' }));

    const dialog = await screen.findByRole('dialog', { name: 'Доступ к СБИС' });
    expect(apiPost).toHaveBeenCalledWith(`/admin/edo-accounts/${sbis.id}/check`);
    expect(within(dialog).getByText('ИНН 7736255508 · КПП 774550001')).toBeTruthy();
    expect(within(dialog).getByText('ЭДО не подключён')).toBeTruthy();

    const buttons = within(dialog).getAllByRole('button', { name: 'Использовать эту организацию' });
    expect(buttons).toHaveLength(2);
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/admin/edo-accounts/${sbis.id}`, { boxId: SU10 }),
    );
  });

  it('у выбранной организации вместо кнопки — «выбрана»; неполный список — предупреждение', async () => {
    accounts = [diadoc, { ...sbis, boxId: SU10 }];
    apiPost.mockResolvedValue({ ...checkResult, complete: false });
    await renderPage();
    fireEvent.click(within(rowOf('СБИС СУ-10')).getByRole('button', { name: 'Проверить доступ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Доступ к СБИС' });
    expect(within(dialog).getByText('выбрана')).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: 'Использовать эту организацию' })).toHaveLength(1);
    expect(within(dialog).getByText('Список организаций неполный')).toBeTruthy();
  });

  it('отказ ключей — текст сервера, окно не открывается', async () => {
    apiPost.mockRejectedValue(new Error('СБИС отклонил ключи: неверный сервисный ключ'));
    await renderPage();
    fireEvent.click(within(rowOf('СБИС СУ-10')).getByRole('button', { name: 'Проверить доступ' }));
    expect(await screen.findByText('СБИС отклонил ключи: неверный сервисный ключ')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Доступ к СБИС' })).toBeNull();
  });
});

describe('заведение и правка СБИС', () => {
  it('новая учётка СБИС — три ключа без пробелов, без полей Диадока', async () => {
    apiPost.mockResolvedValue({});
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }));
    const drawer = (await screen.findByText('Новая учётная запись ЭДО')).closest<HTMLElement>('.ant-drawer')!;
    fireEvent.click(within(drawer).getByText('СБИС'));

    fireEvent.change(within(drawer).getByLabelText('Название'), { target: { value: 'СБИС СУ-10 новый' } });
    fireEvent.change(within(drawer).getByLabelText('ID подключения'), { target: { value: ' 1025 ' } });
    fireEvent.change(within(drawer).getByLabelText('Защищённый ключ'), { target: { value: 'secret ' } });
    fireEvent.change(within(drawer).getByLabelText('Сервисный ключ'), { target: { value: ' service' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith('/admin/edo-accounts', {
        provider: 'sbis',
        name: 'СБИС СУ-10 новый',
        isActive: true,
        credentials: {
          authMode: 'sbis_service_key',
          appClientId: '1025',
          appSecret: 'secret',
          secretKey: 'service',
        },
      }),
    );
  });

  it('правка: пустые ключи не уходят, выключение учётки — уходит; отказ удаления — текстом сервера', async () => {
    await renderPage();
    fireEvent.click(within(rowOf('СБИС СУ-10')).getByRole('button', { name: /edit/i }));
    const drawer = (await screen.findByText('Изменить: СБИС СУ-10')).closest<HTMLElement>('.ant-drawer')!;
    expect(within(drawer).getByText('Сейчас сохранено: 36 символов, отпечаток e5f6a7b8')).toBeTruthy();

    fireEvent.click(within(drawer).getByRole('switch'));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/admin/edo-accounts/${sbis.id}`, {
        name: 'СБИС СУ-10',
        isActive: false,
      }),
    );

    apiDelete.mockRejectedValue(new Error('У учётки СБИС есть выгруженные УПД — отключите её вместо удаления.'));
    fireEvent.click(within(rowOf('СБИС СУ-10')).getByRole('button', { name: /delete/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText(/отключите её вместо удаления/)).toBeTruthy();
  });
});
