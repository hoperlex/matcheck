// @vitest-environment jsdom
/**
 * Чип «Поставщик» в шапке приёмки.
 *
 * При привязанном УПД поставщик — свойство документа. Неверно распознанного
 * поставщика админ и Мониторинг правят в самом документе, и тест держит, куда
 * уходит запрос: PATCH документа с id справочника, а не поставщик операции
 * (его сервер при УПД отклоняет). Окно обязано назвать документ и сказать, что
 * правка видна во всех приёмках с ним, а при нескольких документах — что
 * меняется только основной.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

const DOC = '11111111-1111-4111-8111-111111111111';
const DELIVERY = '22222222-2222-4222-8222-222222222222';

let directory: { id: string; inn: string; name: string; aliases: string[] }[] = [];
const BASE_DIRECTORY = [
  { id: 'sup-1', inn: '7736255508', name: 'ООО «Ошибочный»', aliases: [] },
  { id: 'sup-2', inn: '7729742081', name: 'ООО «Королевская вода»', aliases: [] },
];
// Справочник как в жалобе 26.10 (приёмка 21713): верная запись названа
// «ООО «МОЖАЙСК»», рядом дубли ИСТКУЛЬТ с битыми ИНН — с кавычками и без.
const MOZHAYSK_DIRECTORY = [
  { id: 'dup-quoted', inn: '5028021898', name: 'АО "ИСТКУЛЬТ МОЖАЙСК"', aliases: [] },
  { id: 'dup-plain', inn: '5028024698', name: 'АО ИСТКУЛЬТ МОЖАЙСК', aliases: [] },
  { id: 'right', inn: '5028021698', name: 'ООО «МОЖАЙСК»', aliases: [] },
];
const savedDoc = { id: DOC, supplierName: 'ООО «Королевская вода»' };

const get = vi.fn((url: string) => {
  if (url.startsWith('/suppliers')) {
    return Promise.resolve({ items: directory, total: directory.length });
  }
  return Promise.reject(new Error(`unexpected GET ${url}`));
});
const patch = vi.fn((url: string, _body?: unknown) =>
  Promise.resolve(url.startsWith('/source-documents/') ? savedDoc : { id: DELIVERY }),
);

vi.mock('../../services/api', () => ({
  api: {
    get: (...args: unknown[]) => get(...(args as [string])),
    patch: (...args: unknown[]) => patch(...(args as [string, unknown])),
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../../services/deliveries', () => ({ upsertServerSnapshot: vi.fn() }));
vi.mock('../../services/shipments', () => ({ upsertServerSnapshot: vi.fn() }));

const { SupplierChip } = await import('./SupplierChip');

function wrap(node: ReactElement): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** Выбрать поставщика в открытом окне чипа. */
async function choose(name: string, title: string): Promise<void> {
  const box = await screen.findByRole('combobox', { name });
  fireEvent.mouseDown(box);
  fireEvent.change(box, { target: { value: 'королев' } });
  fireEvent.click(await screen.findByTitle(title));
}

beforeEach(() => {
  directory = BASE_DIRECTORY;
});

afterEach(() => {
  cleanup();
  get.mockClear();
  patch.mockClear();
});

function optionTitles(): (string | null)[] {
  return [...document.querySelectorAll('.ant-select-item-option')].map((el) =>
    el.getAttribute('title'),
  );
}

function renderDocumentChip(docInn: string | null, onSaved = vi.fn()): void {
  render(
    wrap(
      <SupplierChip
        entity="delivery"
        entityId={DELIVERY}
        hasUpd
        displayName="ООО «МОЖАЙСК»"
        invalidateQueryKey={['deliveries', DELIVERY]}
        updEdit={{
          docId: DOC,
          docNumber: '00EP-005791',
          docDate: '2026-10-23',
          linkedCount: 1,
          docInn,
          onSaved,
        }}
      />,
    ),
  );
  fireEvent.click(screen.getByText('ООО «МОЖАЙСК»'));
}

describe('чип «Поставщик» при привязанном УПД', () => {
  it('без права — только подсказка, справочник не грузится', async () => {
    render(
      wrap(
        <SupplierChip
          entity="delivery"
          entityId={DELIVERY}
          hasUpd
          displayName="ООО «Ошибочный»"
          invalidateQueryKey={['deliveries', DELIVERY]}
        />,
      ),
    );

    fireEvent.click(screen.getByText('Поставщик: ООО «Ошибочный»'));
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('с правом — PATCH документа с id справочника, карточка получает ответ', async () => {
    const onSaved = vi.fn();
    render(
      wrap(
        <SupplierChip
          entity="delivery"
          entityId={DELIVERY}
          hasUpd
          displayName="ООО «Ошибочный»"
          invalidateQueryKey={['deliveries', DELIVERY]}
          // Право на выбор поставщика операции к правке документа не относится.
          disabled
          updEdit={{
            docId: DOC,
            docNumber: '240627',
            docDate: '2026-10-13',
            linkedCount: 1,
            docInn: null,
            onSaved,
          }}
        />,
      ),
    );

    fireEvent.click(screen.getByText('ООО «Ошибочный»'));
    expect(
      await screen.findByText(
        'Поставщик в УПД №240627 от 2026-10-13. Меняется в самом документе — во всех приёмках, к которым он привязан.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Меняется только этот/)).toBeNull();

    await choose('Поставщик в документе', 'ООО «Королевская вода» · ИНН 7729742081');

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(savedDoc));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(`/source-documents/${DOC}`, {
      supplierDirectoryId: 'sup-2',
    });
  });

  it('несколько документов — окно предупреждает, что меняется только основной', async () => {
    render(
      wrap(
        <SupplierChip
          entity="delivery"
          entityId={DELIVERY}
          hasUpd
          displayName="ООО «Ошибочный»"
          invalidateQueryKey={['deliveries', DELIVERY]}
          updEdit={{
            docId: DOC,
            docNumber: '240627',
            docDate: null,
            linkedCount: 3,
            docInn: null,
            onSaved: vi.fn(),
          }}
        />,
      ),
    );

    fireEvent.click(screen.getByText('ООО «Ошибочный»'));
    expect(
      await screen.findByText(
        'В приёмке документов: 3. Меняется только этот — его поставщик показан в чипе и в таблице.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Поставщик в УПД №240627\. Меняется в самом документе/)).toBeTruthy();
  });
});

describe('чип «Поставщик» без УПД', () => {
  it('выбор по-прежнему пишет поставщика самой приёмки', async () => {
    render(
      wrap(
        <SupplierChip
          entity="delivery"
          entityId={DELIVERY}
          hasUpd={false}
          displayName={null}
          invalidateQueryKey={['deliveries', DELIVERY]}
        />,
      ),
    );

    fireEvent.click(screen.getByText('— не указан —'));
    const box = await screen.findByRole('combobox');
    fireEvent.mouseDown(box);
    fireEvent.change(box, { target: { value: 'королев' } });
    fireEvent.click(await screen.findByTitle('ООО «Королевская вода» · ИНН 7729742081'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/deliveries/${DELIVERY}/supplier-from-directory`, {
      supplierDirectoryId: 'sup-2',
    });
  });
});

describe('окно поставщика: поиск и ИНН документа (приёмка 21713)', () => {
  it('«АО И» находит записи и с кавычками, и без', async () => {
    directory = MOZHAYSK_DIRECTORY;
    renderDocumentChip(null);
    const box = await screen.findByRole('combobox', { name: 'Поставщик в документе' });
    fireEvent.mouseDown(box);
    fireEvent.change(box, { target: { value: 'АО И' } });
    await waitFor(() =>
      expect(optionTitles()).toEqual([
        'АО "ИСТКУЛЬТ МОЖАЙСК" · ИНН 5028021898 — ИНН не проходит проверку',
        'АО ИСТКУЛЬТ МОЖАЙСК · ИНН 5028024698 — ИНН не проходит проверку',
      ]),
    );
  });

  it('запись с ИНН документа — первой, битые — в конце, и при пустом запросе среди 300 записей', async () => {
    const filler = Array.from({ length: 300 }, (_, i) => ({
      id: `f-${i}`,
      inn: '',
      name: `ООО «Наполнитель ${i}»`,
      aliases: [],
    }));
    directory = [...MOZHAYSK_DIRECTORY, ...filler];
    renderDocumentChip('5028021698');
    expect(await screen.findByText('ИНН поставщика в документе: 5028021698')).toBeTruthy();
    const box = await screen.findByRole('combobox', { name: 'Поставщик в документе' });
    fireEvent.mouseDown(box);
    await waitFor(() =>
      expect(optionTitles()[0]).toBe('ООО «МОЖАЙСК» · ИНН 5028021698 — ИНН как в документе'),
    );
  });

  it('чужой ИНН — PATCH ждёт «Выбрать всё равно»', async () => {
    directory = MOZHAYSK_DIRECTORY;
    const onSaved = vi.fn();
    renderDocumentChip('5028021698', onSaved);
    const box = await screen.findByRole('combobox', { name: 'Поставщик в документе' });
    fireEvent.mouseDown(box);
    fireEvent.change(box, { target: { value: 'исткульт' } });
    fireEvent.click(
      await screen.findByTitle('АО ИСТКУЛЬТ МОЖАЙСК · ИНН 5028024698 — ИНН не проходит проверку'),
    );

    expect(
      await screen.findByText(/ИНН 5028024698 — не совпадает с ИНН в документе 5028021698/),
    ).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Выбрать всё равно' }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/source-documents/${DOC}`, {
      supplierDirectoryId: 'dup-plain',
    });
  });

  it('чужой ИНН и «Отмена» — документ не меняется', async () => {
    directory = MOZHAYSK_DIRECTORY;
    renderDocumentChip('5028021698');
    const box = await screen.findByRole('combobox', { name: 'Поставщик в документе' });
    fireEvent.mouseDown(box);
    fireEvent.change(box, { target: { value: 'исткульт' } });
    fireEvent.click(
      await screen.findByTitle('АО "ИСТКУЛЬТ МОЖАЙСК" · ИНН 5028021898 — ИНН не проходит проверку'),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Отмена' }));

    expect(screen.queryByRole('button', { name: 'Выбрать всё равно' })).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it('ИНН совпал — PATCH сразу, как раньше', async () => {
    directory = MOZHAYSK_DIRECTORY;
    const onSaved = vi.fn();
    renderDocumentChip('5028021698', onSaved);
    const box = await screen.findByRole('combobox', { name: 'Поставщик в документе' });
    fireEvent.mouseDown(box);
    fireEvent.change(box, { target: { value: '5028021698' } });
    fireEvent.click(
      await screen.findByTitle('ООО «МОЖАЙСК» · ИНН 5028021698 — ИНН как в документе'),
    );

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/source-documents/${DOC}`, {
      supplierDirectoryId: 'right',
    });
    expect(screen.queryByRole('button', { name: 'Выбрать всё равно' })).toBeNull();
  });
});
