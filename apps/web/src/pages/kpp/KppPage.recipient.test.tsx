// @vitest-environment jsdom
/**
 * Общий получатель приёмки сохраняется сразу (PATCH /deliveries/:id/recipient).
 *
 * Жалоба мониторинга 18.11.2026: получатель жил в форме до «Сохранить» и
 * терялся при уходе из карточки, обновлении портала и перечитке формы. Теперь
 * выбор в чипе и «Подставить» пишутся PATCH-ем; «Сохранить» получателя не шлёт
 * (уходит keepRecipient), а на время PATCH ждёт; перечитка формы не стирает
 * набранные комментарий и госномер. Прежний режим «до Сохранить» остаётся у
 * роли без возможности — см. KppPage.purpose.test.tsx.
 */
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delivery } from '@matcheck/contracts';
import type * as ApiModuleNs from '../../services/api';
import type * as DeliveriesModuleNs from '../../services/deliveries';
import type * as MutationQueueNs from '../../services/mutationQueue';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  applyLocalEdit: vi.fn(),
  enqueueMutation: vi.fn(),
  flushMutation: vi.fn(),
  deniedCapabilities: new Set<string>(),
}));

vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof ApiModuleNs>('../../services/api');
  return {
    ...actual,
    api: { get: mocks.apiGet, post: mocks.apiPost, patch: mocks.apiPatch, delete: vi.fn() },
    apiDownload: vi.fn(),
  };
});
vi.mock('../../services/deliveries', async () => {
  const actual = await vi.importActual<typeof DeliveriesModuleNs>('../../services/deliveries');
  return {
    ...actual,
    applyLocalEdit: mocks.applyLocalEdit,
    enqueueMutation: mocks.enqueueMutation,
  };
});
// withQueueLock — настоящий: порядок «идущий проход очереди → PATCH» и есть
// предмет одного из тестов.
vi.mock('../../services/mutationQueue', async () => {
  const actual = await vi.importActual<typeof MutationQueueNs>('../../services/mutationQueue');
  return { ...actual, flushMutation: mocks.flushMutation };
});
vi.mock('../../services/sync', () => ({ runSync: vi.fn(async () => undefined) }));
vi.mock('../../services/photoPipeline', () => ({
  capturePhoto: vi.fn(),
  onPhotoUploadSettled: () => () => undefined,
}));
vi.mock('../../shared/hooks/usePermissions', () => ({
  usePermissions: () => ({
    can: () => true,
    canView: () => true,
    canViewGroup: () => true,
    hasCapability: (capability: string) => !mocks.deniedCapabilities.has(capability),
    enforced: true,
    loading: false,
  }),
}));
const authUser = { id: 'u-1', email: 'monitor@test.com', role: 'monitor', siteId: null };
vi.mock('../../stores/auth', () => ({
  useAuthStore: Object.assign((selector: (s: unknown) => unknown) => selector({ user: authUser }), {
    getState: () => ({ user: authUser, accessToken: 'token' }),
  }),
}));

const { default: KppPage } = await import('./KppPage');
const { withQueueLock } = await import('../../services/mutationQueue');

const ID = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const SITE = '55555555-5555-4555-8555-555555555555';
const CONTRACTOR = '88888888-8888-4888-8888-888888888888';
const SUGGESTED = '77777777-7777-4777-8777-777777777777';
const MOL = '99999999-9999-4999-8999-999999999999';

type Status = 'filled' | 'confirmed_mol';

function delivery(over: Partial<Delivery> & { statusCode?: Status; tick?: number } = {}): Delivery {
  const { statusCode = 'filled', tick = 1, ...rest } = over;
  return {
    id: ID,
    displayId: 25946,
    status: {
      id: 's',
      entityType: 'delivery',
      code: statusCode,
      label: statusCode === 'filled' ? 'Оформлена' : 'Подтверждено МОЛ',
      color: 'green',
      sortOrder: 30,
    },
    siteId: SITE,
    supplierId: null,
    contractorId: null,
    recipientMolId: null,
    siteName: 'Объект',
    supplierName: null,
    contractorName: null,
    // Госномер и фото — условия кнопки «Сохранить» (verifyReason).
    vehiclePlate: 'А243МХ550',
    driverName: null,
    arrivedAt: null,
    inspectorId: null,
    comment: null,
    inTransit: false,
    isAssets: false,
    purpose: null,
    confirmedByMolUserId: null,
    confirmedByMolUserEmail: null,
    confirmedByMolAt: null,
    reviewState: null,
    reviewNote: null,
    reviewedByUserId: null,
    reviewedByUserEmail: null,
    reviewedAt: null,
    pendingDeletionAt: null,
    pendingDeletionByUserId: null,
    pendingDeletionByUserEmail: null,
    pendingDeletionReason: null,
    version: 3,
    sourceDocumentIds: [DOC],
    sourceShipmentId: null,
    sourceShipmentShippedAt: null,
    sourceShipmentSiteId: null,
    sourceShipmentSiteCode: null,
    items: [],
    photos: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        kind: 'cargo',
        stage: 'before',
        s3Key: 'k',
        thumbS3Key: null,
        contentHash: null,
        takenAt: '2026-11-18T10:00:00.000Z',
        uploadedAt: '2026-11-18T10:00:00.000Z',
      },
    ],
    itemCount: 0,
    photoCount: 1,
    itemsTotal: null,
    itemsVatSum: null,
    primarySourceDocument: null,
    sourceDocuments: [
      {
        id: DOC,
        kind: 'upd',
        status: 'parsed',
        docNumber: 'УПД-1',
        docDate: '2026-11-18',
        expectedDate: null,
        totalSum: '100.00',
        vatSum: null,
        linked: true,
      },
    ],
    docAttention: false,
    createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: `2026-11-18T10:00:0${tick}.000Z`,
    ...rest,
  } as unknown as Delivery;
}

let current: Delivery;
let suggestion: unknown = null;

function route(url: string): unknown {
  if (url === `/deliveries/${ID}`) return current;
  if (url === `/deliveries/${ID}/recipient-suggestion`) return { suggestion };
  if (url.startsWith('/customer-counterparties')) {
    return {
      items: [{ id: SUGGESTED, name: 'ООО «Альфа»', inn: '1234567890', aliases: [] }],
      total: 1,
    };
  }
  if (url.startsWith('/responsible-persons')) {
    return { items: [{ id: MOL, fullName: 'Иванов Иван Иванович', isActive: true }], total: 1 };
  }
  if (url.startsWith('/source-documents/')) {
    return { id: DOC, kind: 'upd', docNumber: 'УПД-1', items: [], supplierName: null, siteId: SITE };
  }
  if (url.includes('supplier-orders')) return { items: [], sync: { enabled: false } };
  if (url.endsWith('/contract')) {
    return { contract: null, perDocument: false, documents: [], catalog: { total: 0, importedAt: null } };
  }
  if (url === `/deliveries/${ID}/edo-matches`) return { items: [] };
  return { items: [], total: 0 };
}

function renderCard() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[`/operations?type=delivery&delivery=${ID}`]}>
        <KppPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const recipientChip = () => screen.findByText('Получатель:');
const saveButton = () => screen.getByRole('button', { name: 'Сохранить' }) as HTMLButtonElement;

/** Карточка загружена, получатель подхвачен с сервера, «Сохранить» доступна. */
async function ready(): Promise<void> {
  await waitFor(() => expect(saveButton().disabled).toBe(false), { timeout: 4000 });
}

/** Открыть чип получателя и выбрать МОЛ. */
async function pickMol(): Promise<void> {
  fireEvent.click(await recipientChip());
  const popover = (await screen.findByText('МОЛ')).closest('.ant-popover') as HTMLElement;
  fireEvent.click(within(popover).getByText('МОЛ'));
  const box = await within(popover).findByRole('combobox');
  fireEvent.mouseDown(box);
  fireEvent.click(await screen.findByTitle('Иванов Иван Иванович'));
}

beforeEach(() => {
  current = delivery();
  suggestion = null;
  mocks.apiGet.mockImplementation(async (url: string) => route(url));
  mocks.flushMutation.mockResolvedValue({ outcome: 'queued' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  authUser.role = 'monitor';
  mocks.deniedCapabilities.clear();
});

describe('общий получатель приёмки — сразу', () => {
  it('выбор МОЛ сразу уходит PATCH-ем, без «Сохранить»', async () => {
    mocks.apiPatch.mockImplementation(async () => {
      current = delivery({ recipientMolId: MOL, purpose: 'own_forces', tick: 2 });
      return current;
    });
    renderCard();
    await ready();
    await pickMol();

    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(`/deliveries/${ID}/recipient`, {
        recipientMolId: MOL,
      }),
    );
    expect(await screen.findByText('МОЛ: Иванов Иван Иванович')).toBeTruthy();
    expect(mocks.applyLocalEdit).not.toHaveBeenCalled();
  });

  it('«Подставить» из подсказки тоже сохраняет PATCH-ем', async () => {
    suggestion = {
      customerCounterpartyId: SUGGESTED,
      name: 'ООО «Альфа»',
      inn: '1234567890',
      from: 'consignee',
      sourceDocumentId: DOC,
    };
    mocks.apiPost.mockResolvedValue({ id: CONTRACTOR, name: 'ООО «Альфа»', inn: '1234567890' });
    mocks.apiPatch.mockImplementation(async () => {
      current = delivery({ contractorId: CONTRACTOR, contractorName: 'ООО «Альфа»', tick: 2 });
      return current;
    });
    renderCard();
    await ready();
    fireEvent.click(await screen.findByRole('button', { name: 'Подставить' }));
    await waitFor(() =>
      expect(mocks.apiPatch).toHaveBeenCalledWith(`/deliveries/${ID}/recipient`, {
        contractorId: CONTRACTOR,
      }),
    );
    expect(await screen.findByText('Подрядчик: ООО «Альфа»')).toBeTruthy();
  });

  it('«Сохранить» не кладёт получателя в правку — уходит keepRecipient', async () => {
    current = delivery({ contractorId: CONTRACTOR, contractorName: 'ООО «Бета»' });
    renderCard();
    await ready();
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.applyLocalEdit).toHaveBeenCalled());
    const patch = mocks.applyLocalEdit.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty('contractorId');
    expect(patch).not.toHaveProperty('recipientMolId');
  });

  it('у confirmed_mol набранные комментарий и госномер переживают сохранение получателя', async () => {
    current = delivery({ statusCode: 'confirmed_mol' });
    mocks.apiPatch.mockImplementation(async () => {
      // Ответ PATCH сдвигает updatedAt — форма confirmed_mol перечитывается.
      current = delivery({ statusCode: 'confirmed_mol', recipientMolId: MOL, tick: 2 });
      return current;
    });
    renderCard();
    await ready();

    fireEvent.click(await screen.findByText('Комментарий'));
    const textarea = (await screen.findByRole('textbox', { name: '' })) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'набрано до выбора получателя' } });
    fireEvent.click(await screen.findByText('Госномер:'));
    const plateBox = (await screen.findByDisplayValue('А243МХ550')) as HTMLInputElement;
    fireEvent.change(plateBox, { target: { value: 'В777ВВ77' } });

    await pickMol();
    // Ответ PATCH пришёл, форма перечиталась (updatedAt сдвинулся).
    await waitFor(() => expect(mocks.apiPatch).toHaveBeenCalledTimes(1));
    await ready();
    expect(await screen.findByText('МОЛ: Иванов Иван Иванович')).toBeTruthy();
    expect(screen.getByDisplayValue('набрано до выбора получателя')).toBeTruthy();

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(mocks.applyLocalEdit).toHaveBeenCalledWith(
        ID,
        expect.objectContaining({
          comment: 'набрано до выбора получателя',
          vehiclePlate: 'В777ВВ77',
        }),
      ),
    );
  });

  it('пока PATCH идёт, «Сохранить» и чип заблокированы; второй выбор не уходит', async () => {
    const pending = deferred<Delivery>();
    mocks.apiPatch.mockImplementation(() => pending.promise);
    renderCard();
    await ready();
    await pickMol();
    await waitFor(() => expect(mocks.apiPatch).toHaveBeenCalledTimes(1));

    expect(saveButton().disabled).toBe(true);
    // Чип выключен: клик не открывает окно выбора.
    fireEvent.click(await recipientChip());
    expect(screen.queryByText('Подрядчик')).toBeNull();
    expect(mocks.apiPatch).toHaveBeenCalledTimes(1);

    current = delivery({ recipientMolId: MOL, tick: 2 });
    pending.resolve(current);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it('ошибка PATCH возвращает серверного получателя', async () => {
    current = delivery({ contractorId: CONTRACTOR, contractorName: 'ООО «Бета»' });
    mocks.apiPatch.mockRejectedValue(new Error('Сервер не ответил'));
    renderCard();
    await ready();
    expect(await screen.findByText('Подрядчик: ООО «Бета»')).toBeTruthy();
    await pickMol();
    await waitFor(() => expect(mocks.apiPatch).toHaveBeenCalled());
    expect(await screen.findByText('Подрядчик: ООО «Бета»')).toBeTruthy();
    expect(screen.queryByText('МОЛ: Иванов Иван Иванович')).toBeNull();
    // Разблокировка — сразу, а не когда закроется сообщение об ошибке (~3 с):
    // thenable от message.error в onError держал мутацию «идущей».
    await waitFor(() => expect(saveButton().disabled).toBe(false), { timeout: 1000 });
  });

  it('PATCH ждёт идущий проход очереди: старый upsert уходит раньше', async () => {
    mocks.apiPatch.mockImplementation(async () => {
      current = delivery({ recipientMolId: MOL, tick: 2 });
      return current;
    });
    renderCard();
    await ready();
    // Проход очереди уже идёт (замок занят) — например, отправка старого
    // «Сохранить» с прежним получателем.
    const gate = deferred<void>();
    const queuePass = withQueueLock(() => gate.promise);
    await pickMol();
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.apiPatch).not.toHaveBeenCalled();
    gate.resolve();
    await queuePass;
    await waitFor(() => expect(mocks.apiPatch).toHaveBeenCalledTimes(1));
  });

  it('без возможности — прежний режим: выбор в форме, PATCH не уходит', async () => {
    mocks.deniedCapabilities.add('operations.edit.recipient');
    renderCard();
    await ready();
    await pickMol();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(mocks.applyLocalEdit).toHaveBeenCalledWith(
        ID,
        expect.objectContaining({ recipientMolId: MOL, contractorId: null }),
      ),
    );
    expect(mocks.apiPatch).not.toHaveBeenCalled();
  });
});
