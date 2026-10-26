// @vitest-environment jsdom
/**
 * Блок материалов с привязанной УПД из ЭДО.
 *
 * Обещания: строки ЭДО — сверху и только для чтения; факт приёмки — свёрнутым
 * подблоком, но под рукой, пока строк ЭДО нет (загрузка, сбой); у каждого
 * сбоя своё объяснение и своя кнопка; PDF не предлагается там, где он упадёт.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps, ReactNode } from 'react';

vi.mock('../../services/api', () => ({
  apiDownload: vi.fn(() => new Promise(() => undefined)),
  saveBlobAsFile: vi.fn(),
  ApiError: class extends Error {},
}));

const { DeliveryEdoOnlyBlocks, DeliveryEdoSectionBody, allEdoReady, edoCountLabel, useFactPanels } =
  await import('./DeliveryEdoSectionBody');
type Entry = ComponentProps<typeof DeliveryEdoSectionBody>['entries'][number];

const match: Entry['match'] = {
  id: 'm-41296',
  documentId: 'reg-41296',
  source: 'export',
  docNumber: '41296',
  docDate: '2026-10-23',
  supplierName: 'ООО «Фаворит-Электро»',
  supplierInn: '7701677700',
  totalSum: '14180.40',
  linkedAt: '2026-10-26T10:00:00Z',
  sectionDocumentId: 'paper-41296',
  alsoIn: [],
  alsoInCount: 0,
  operator: 'sbis',
};

const readyData: NonNullable<Entry['data']> = {
  matchId: 'm-41296',
  source: 'export',
  label: { operator: 'sbis', docNumber: '41296', docDate: '2026-10-23', correctionNumber: '1' },
  state: 'ready',
  totals: { totalSum: 14180.4, totalExVat: 11623.28, vatSum: 2557.12 },
  reasons: [],
  items: [
    {
      position: 0,
      lineNo: 1,
      nameRaw: 'Бирка кабельная «У-136» белая REXANT',
      qty: 45,
      unit: 'упак',
      unitCode: '778',
      price: 128.79,
      sumExVat: 5795.55,
      vatRate: 22,
      vatSum: 1275.02,
      sum: 7070.57,
      itemKind: 1,
      productCode: null,
    },
    {
      position: 1,
      lineNo: 2,
      nameRaw: 'Доставка',
      qty: 0,
      unit: 'усл',
      unitCode: null,
      price: 5827.73,
      sumExVat: 5827.73,
      vatRate: 22,
      vatSum: 1282.1,
      sum: 7109.83,
      itemKind: 3,
      productCode: null,
    },
  ],
};

const entry = (over: Partial<Entry> = {}): Entry => ({
  match,
  status: 'done',
  data: readyData,
  refetch: vi.fn(),
  ...over,
});

const failedData = (state: NonNullable<Entry['data']>['state'], reasons: string[] = []) => ({
  ...readyData,
  state,
  totals: null,
  reasons,
  items: [],
});

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function renderBody(props: Partial<ComponentProps<typeof DeliveryEdoSectionBody>> = {}) {
  const handlers = {
    onFactOpenChange: vi.fn(),
    onOpenXml: vi.fn(),
  };
  const view = render(
    wrap(
      <DeliveryEdoSectionBody
        deliveryId="d1"
        entries={[entry()]}
        factTable={<div>таблица факта</div>}
        factRows={[
          { qtyActual: null, qtyPlanned: '45', price: '128.79', vatRate: null, vatSum: '1275.02' },
        ]}
        factCaption="Факт приёмки — распознано со скана (1)"
        factOpen={false}
        photos={[]}
        {...handlers}
        {...props}
      />,
    ),
  );
  return { ...view, ...handlers };
}

afterEach(cleanup);

describe('DeliveryEdoSectionBody', () => {
  it('строки ЭДО сверху: подпись с оператором и исправлением, метка услуги, нет количества — «—»', () => {
    renderBody();
    expect(
      screen.getByText('По УПД из ЭДО · СБИС № 41296 от 23.10.2026 · исправление № 1'),
    ).toBeTruthy();
    expect(screen.getByText('Бирка кабельная «У-136» белая REXANT')).toBeTruthy();
    expect(screen.getByText('услуга')).toBeTruthy();
    // У строки с ПрТовРаб=1 пометки нет — она одна на весь блок.
    expect(screen.getAllByText(/^(услуга|работа|иное|имущественные права)$/)).toHaveLength(1);
    const deliveryRow = screen.getByText('Доставка').closest('tr')!;
    expect(deliveryRow.textContent).toContain('—');
  });

  it('факт свёрнут, когда велено; его заголовок виден, таблица — нет', () => {
    renderBody({ factOpen: false });
    expect(screen.getByText('Факт приёмки — распознано со скана (1)')).toBeTruthy();
    expect(screen.queryByText('таблица факта')).toBeNull();
  });

  it('факт раскрыт, когда велено; клик по заголовку — выбор человека', () => {
    const { onFactOpenChange } = renderBody({ factOpen: true });
    expect(screen.getByText('таблица факта')).toBeTruthy();
    fireEvent.click(screen.getByText('Факт приёмки — распознано со скана (1)'));
    expect(onFactOpenChange).toHaveBeenCalledWith(false);
  });

  it('сводка: ЭДО и факт рядом, без вердикта', () => {
    renderBody();
    expect(screen.getByText(/^ЭДО: строк 2 · без НДС 11.623,28 ₽ · НДС 2.557,12 ₽$/)).toBeTruthy();
    expect(screen.getByText(/^Факт: строк 1 · без НДС 5.795,55 ₽ · НДС 1.275,02 ₽$/)).toBeTruthy();
    expect(screen.queryByText(/расход|совпал/i)).toBeNull();
  });

  it('загрузка — «Загружаю строки УПД…» и «ЭДО: …»', () => {
    renderBody({ entries: [entry({ status: 'loading', data: null })] });
    expect(screen.getByText('Загружаю строки УПД…')).toBeTruthy();
    // Подпись берётся из привязки, пока ответа нет.
    expect(screen.getByText('По УПД из ЭДО · СБИС № 41296 от 23.10.2026')).toBeTruthy();
    expect(screen.getByText('ЭДО: …')).toBeTruthy();
  });

  it('запрос не дошёл и хранилище не ответило — «Повторить» перечитывает', () => {
    for (const failed of [
      entry({ status: 'error', data: null }),
      entry({ data: failedData('storage_failed') }),
    ]) {
      renderBody({ entries: [failed] });
      expect(screen.getByText('Строки УПД не загрузились')).toBeTruthy();
      fireEvent.click(screen.getByText('Повторить'));
      expect(failed.refetch).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Открыть файл')).toBeNull();
      cleanup();
    }
  });

  it('файл не разобрался или слишком большой — только «Открыть XML», без PDF', () => {
    for (const [state, text] of [
      ['parse_failed', 'Файл УПД не разобрался'],
      ['too_large', 'УПД слишком большая для карточки'],
    ] as const) {
      const { onOpenXml } = renderBody({ entries: [entry({ data: failedData(state) })] });
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByText('Открыть файл')).toBeNull();
      fireEvent.click(screen.getByText('Открыть XML'));
      expect(onOpenXml).toHaveBeenCalledWith(match);
      cleanup();
    }
  });

  it('позиции не прочитаны — причины, PDF и XML', () => {
    renderBody({
      entries: [
        entry({
          data: {
            ...failedData('incomplete', ['не прочитана ни одна позиция']),
            totals: readyData.totals,
          },
        }),
      ],
    });
    expect(screen.getByText('В файле УПД не прочитаны позиции')).toBeTruthy();
    expect(screen.getByText('не прочитана ни одна позиция')).toBeTruthy();
    expect(screen.getByText('Открыть файл')).toBeTruthy();
    expect(screen.getByText('Открыть XML')).toBeTruthy();
  });

  it('у карточки импорта PDF не строится — при incomplete только XML', () => {
    renderBody({
      entries: [
        entry({
          match: { ...match, source: 'import' },
          data: { ...failedData('incomplete', ['не прочитана ни одна позиция']), source: 'import' },
        }),
      ],
    });
    expect(screen.queryByText('Открыть файл')).toBeNull();
    expect(screen.getByText('Открыть XML')).toBeTruthy();
  });
});

describe('счётчик заголовка и готовность', () => {
  it('строки готовых УПД; «…» пока грузится; пусто при сбое', () => {
    const second = entry({ match: { ...match, id: 'm2' } });
    expect(edoCountLabel([entry(), second])).toBe(' (4)');
    expect(edoCountLabel([entry(), entry({ status: 'loading', data: null })])).toBe(' (…)');
    expect(edoCountLabel([entry(), entry({ data: failedData('parse_failed') })])).toBe('');
  });

  it('готовы — только если готовы все', () => {
    expect(allEdoReady([entry()])).toBe(true);
    expect(allEdoReady([entry(), entry({ status: 'error', data: null })])).toBe(false);
    expect(allEdoReady([entry({ data: failedData('incomplete') })])).toBe(false);
    expect(allEdoReady([])).toBe(false);
  });
});

describe('useFactPanels — раскрыт ли факт', () => {
  it('без выбора: раскрыт, пока ЭДО не готово, свёрнут, когда готово', () => {
    const { result } = renderHook(() => useFactPanels());
    expect(result.current.isOpen('doc', [entry({ status: 'loading', data: null })])).toBe(true);
    expect(result.current.isOpen('doc', [entry({ status: 'error', data: null })])).toBe(true);
    expect(result.current.isOpen('doc', [entry()])).toBe(false);
  });

  it('выбор человека важнее готовности', () => {
    const { result } = renderHook(() => useFactPanels());
    act(() => result.current.setOpen('doc', false));
    expect(result.current.isOpen('doc', [entry({ status: 'loading', data: null })])).toBe(false);
    act(() => result.current.setOpen('doc', true));
    expect(result.current.isOpen('doc', [entry()])).toBe(true);
    // Выбор — по документу: соседний блок живёт своим правилом.
    expect(result.current.isOpen('other', [entry()])).toBe(false);
  });

  it('новая строка раскрывает факт и у готового ЭДО', () => {
    const { result } = renderHook(() => useFactPanels());
    act(() => result.current.rowAdded('doc'));
    expect(result.current.isOpen('doc', [entry()])).toBe(true);
  });
});

describe('DeliveryEdoOnlyBlocks — УПД без блока бумажного документа', () => {
  it('свой блок на каждую УПД, раскрыт сразу; свёрнутый человеком не раскрывается снова', () => {
    const props = {
      deliveryId: 'd1',
      entries: [entry({ match: { ...match, sectionDocumentId: null } })],
      photos: [],
      onOpenXml: vi.fn(),
    };
    const view = render(wrap(<DeliveryEdoOnlyBlocks {...props} />));
    const title = 'Материалы · УПД № 41296 из ЭДО · СБИС (2)';
    const isOpen = () =>
      screen
        .getByText(title)
        .closest('.ant-collapse-item')!
        .classList.contains('ant-collapse-item-active');
    expect(isOpen()).toBe(true);
    expect(screen.getByText('Бирка кабельная «У-136» белая REXANT')).toBeTruthy();

    fireEvent.click(screen.getByText(title));
    expect(isOpen()).toBe(false);
    // Перерисовка с тем же составом (опрос карточки) блок не раскрывает.
    view.rerender(wrap(<DeliveryEdoOnlyBlocks {...props} entries={[...props.entries]} />));
    expect(isOpen()).toBe(false);
  });

  it('без УПД — ничего', () => {
    const { container } = render(
      wrap(<DeliveryEdoOnlyBlocks deliveryId="d1" entries={[]} photos={[]} onOpenXml={vi.fn()} />),
    );
    expect(container.textContent).toBe('');
  });
});
