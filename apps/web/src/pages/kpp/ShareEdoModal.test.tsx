// @vitest-environment jsdom
/**
 * Окно «К другим приёмкам»: одна УПД из ЭДО — к нескольким приёмкам объекта.
 *
 * Обещания: из карточки заранее не отмечено ничего, из списка — отмеченные;
 * приёмки, где УПД уже стоит, отметить нельзя; блок по умолчанию — документ с
 * тем же номером, иначе приёмка целиком; отказ сервера виден в окне с
 * номерами приёмок, а успех — числом привязанных.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { ShareCandidate } from './ShareEdoModal';

const get = vi.fn();
const post = vi.fn();

vi.mock('../../services/api', () => ({
  api: { get, post },
  ApiError: class extends Error {},
}));

const { ShareEdoModal, batchResultText } = await import('./ShareEdoModal');
type Props = ComponentProps<typeof ShareEdoModal>;
type Candidate = ShareCandidate;

const base: Candidate = {
  deliveryId: 'd-same',
  displayId: 17733,
  arrivedAt: '2026-09-30T08:37:00Z',
  vehiclePlate: 'Х409НЕ977',
  supplierName: 'ТК ЦЕНТРОСТРОЙ',
  documents: [{ id: 'paper-17733', kind: 'upd', docNumber: '201/21127556', docDate: '2026-09-30' }],
  photoNumbers: [],
  otherEdo: [],
  state: 'available',
  reasons: ['match'],
  level: 'high',
  score: 90,
  matches: ['номер', 'ИНН', 'дата'],
  conflicts: [],
  otherSupplier: false,
  defaultSectionId: 'paper-17733',
};

const rows: Candidate[] = [
  base,
  {
    ...base,
    deliveryId: 'd-nodoc',
    displayId: 17741,
    vehiclePlate: 'Е448ЕМ799',
    supplierName: null,
    documents: [],
    reasons: ['no_document'],
    level: 'weak',
    matches: [],
    defaultSectionId: null,
  },
  { ...base, deliveryId: 'd-linked', displayId: 17713, state: 'linked', reasons: [] },
];

function serve(items: Candidate[] = rows) {
  get.mockResolvedValue({
    document: {
      docNumber: '201/21127556',
      docDate: '2026-09-30',
      supplierName: 'ТК ЦЕНТРОСТРОЙ',
      supplierInn: '7710959468',
      totalSum: '1311117.30',
    },
    siteId: 'site-1',
    items,
    truncated: false,
  });
}

function show(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    anchorDeliveryId: 'd-anchor',
    document: {
      source: 'export',
      id: 'reg-1',
      docNumber: '201/21127556',
      docDate: '2026-09-30',
      operator: 'sbis',
    },
    onCancel: vi.fn(),
    onDone: vi.fn(),
    ...over,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ShareEdoModal {...props} />
    </QueryClientProvider>,
  );
  return props;
}

const rowOf = async (displayId: number) =>
  (await screen.findByText(String(displayId))).closest('tr') as HTMLElement;
const checkboxOf = async (displayId: number) =>
  within(await rowOf(displayId)).getByRole('checkbox') as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: /^Привязать/ });

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  serve();
});
afterEach(cleanup);

describe('ShareEdoModal', () => {
  it('из карточки ничего не отмечено; «уже привязана» не отмечается; кнопка считает выбранные', async () => {
    show();
    expect((await checkboxOf(17733)).checked).toBe(false);
    expect((await checkboxOf(17713)).disabled).toBe(true);
    expect(within(await rowOf(17713)).getByText('Уже привязана')).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await checkboxOf(17733));
    expect(submit().textContent).toBe('Привязать к 1 приёмке');
    expect(get).toHaveBeenCalledWith(
      '/deliveries/d-anchor/edo-share-candidates?source=export&documentId=reg-1',
    );
  });

  it('блок по умолчанию — документ с тем же номером; без документа — приёмка целиком; тело запроса', async () => {
    post.mockResolvedValue({
      linked: [{ deliveryId: 'd-same', displayId: 17733 }],
      alreadyLinked: [],
    });
    const props = show();
    expect(
      within(await rowOf(17733)).getByText('УПД № 201/21127556', {
        selector: '.ant-select-selection-item',
      }),
    ).toBeTruthy();
    expect(within(await rowOf(17741)).getByText('Ко всей приёмке')).toBeTruthy();
    expect(within(await rowOf(17741)).getByText('Без документа')).toBeTruthy();
    fireEvent.click(await checkboxOf(17733));
    fireEvent.click(await checkboxOf(17741));
    fireEvent.click(submit());
    await waitFor(() => expect(props.onDone).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/deliveries/d-anchor/edo-matches/batch', {
      documentId: 'reg-1',
      source: 'export',
      targets: [
        { deliveryId: 'd-same', sectionDocumentId: 'paper-17733' },
        { deliveryId: 'd-nodoc', sectionDocumentId: null },
      ],
    });
  });

  it('из списка: отмеченные приёмки уже выбраны и уходят в запрос', async () => {
    show({ preselected: ['d-same', 'd-nodoc'] });
    expect((await checkboxOf(17733)).checked).toBe(true);
    expect((await checkboxOf(17741)).checked).toBe(true);
    expect(submit().textContent).toBe('Привязать к 2 приёмкам');
    expect(get).toHaveBeenCalledWith(
      '/deliveries/d-anchor/edo-share-candidates?source=export&documentId=reg-1&include=d-same%2Cd-nodoc',
    );
  });

  it('отказ сервера — в окне, с его текстом; окно не закрывается', async () => {
    post.mockRejectedValue(new Error('Приёмка 17741 помечена на удаление. Ничего не привязано.'));
    const props = show({ preselected: ['d-nodoc'] });
    await checkboxOf(17741);
    fireEvent.click(submit());
    expect(
      await screen.findByText('Приёмка 17741 помечена на удаление. Ничего не привязано.'),
    ).toBeTruthy();
    expect(props.onDone).not.toHaveBeenCalled();
  });

  it('итог привязки — числом привязанных и «уже была»', () => {
    const d = (displayId: number) => ({ deliveryId: `d${displayId}`, displayId });
    expect(batchResultText({ linked: [d(1), d(2), d(3)], alreadyLinked: [] })).toBe(
      'УПД привязана к 3 приёмкам',
    );
    expect(batchResultText({ linked: [d(1)], alreadyLinked: [d(2)] })).toBe(
      'УПД привязана к 1 приёмке, в 1 уже была',
    );
    expect(batchResultText({ linked: [], alreadyLinked: [d(2)] })).toBe(
      'УПД уже была во всех выбранных приёмках',
    );
  });
});
