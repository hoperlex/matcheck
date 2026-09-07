// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { OperationItemsSections } from './OperationItemsSections';

/**
 * Подсветка строки, к которой сверка документа предъявила претензию.
 *
 * Проверяются ОБА режима ResponsiveTable. Карточный — не формальность: раньше
 * rowClassName уходил только в десктопную таблицу, и на планшете подсветка
 * пропадала как раз там, где карточку чаще всего и открывают.
 */

type Row = {
  clientKey: string;
  sourceDocumentId: string | null;
  sourceDocumentItemId?: string | null;
  nameRaw: string;
};

const DOC_ID = '00000000-0000-0000-0000-0000000000d1';
const BAD_ITEM = '00000000-0000-0000-0000-000000000001';
const GOOD_ITEM = '00000000-0000-0000-0000-000000000002';

const document_: OperationSourceDocument = {
  id: DOC_ID,
  kind: 'upd',
  status: 'parsed',
  docNumber: '1282',
  docDate: '2026-09-01',
  expectedDate: null,
  totalSum: '185909.16',
  vatSum: '33524.60',
  linked: true,
};

const rows: Row[] = [
  {
    clientKey: 'k1',
    sourceDocumentId: DOC_ID,
    sourceDocumentItemId: BAD_ITEM,
    nameRaw: 'Воздуховод 600',
  },
  {
    clientKey: 'k2',
    sourceDocumentId: DOC_ID,
    sourceDocumentItemId: GOOD_ITEM,
    nameRaw: 'Воздуховод 1150',
  },
];

function renderSections() {
  return render(
    <OperationItemsSections<Row>
      items={rows}
      documents={[document_]}
      columns={[{ title: 'Название', dataIndex: 'nameRaw', key: 'nameRaw' }]}
      cardRender={(row) => <div>{row.nameRaw}</div>}
      emptyHint="пусто"
      problemItemIds={new Set([BAD_ITEM])}
    />,
  );
}

/** Блоки материалов свёрнуты по умолчанию — раскрываем перед проверкой строк. */
function expandBlock() {
  fireEvent.click(screen.getByText(/Материалы · УПД № 1282/));
}

function setWidth(px: number) {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true, writable: true });
}

describe('подсветка проблемной строки в блоке материалов', () => {
  beforeEach(() => {
    setWidth(1440);
  });

  // Автоочистки нет: в конфиге web-тестов globals не включены, и без явного
  // cleanup предыдущий рендер остаётся в документе — соседний тест находит два
  // блока «Материалы» вместо одного.
  afterEach(() => {
    cleanup();
  });

  it('таблица: подсвечена только строка из сводки', () => {
    const { container } = renderSections();
    expandBlock();

    const highlighted = container.querySelectorAll('tr.matcheck-row-mismatch');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.textContent).toContain('Воздуховод 600');
  });

  it('карточный режим: класс доезжает и до List.Item', () => {
    setWidth(500);
    const { container } = renderSections();
    expandBlock();

    const highlighted = container.querySelectorAll('.ant-list-item.matcheck-row-mismatch');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.textContent).toContain('Воздуховод 600');
  });

  it('без сводки подсветки нет вовсе', () => {
    setWidth(1440);
    const { container } = render(
      <OperationItemsSections<Row>
        items={rows}
        documents={[document_]}
        columns={[{ title: 'Название', dataIndex: 'nameRaw', key: 'nameRaw' }]}
        cardRender={(row) => <div>{row.nameRaw}</div>}
        emptyHint="пусто"
      />,
    );
    expandBlock();
    expect(container.querySelectorAll('.matcheck-row-mismatch')).toHaveLength(0);
  });
});

describe('заголовок блока показывает недобор позиций', () => {
  afterEach(() => {
    cleanup();
  });

  function renderWith(doc: OperationSourceDocument, items: Row[] = rows) {
    return render(
      <OperationItemsSections<Row>
        items={items}
        documents={[doc]}
        columns={[{ title: 'Название', dataIndex: 'nameRaw', key: 'nameRaw' }]}
        cardRender={(row) => <div>{row.nameRaw}</div>}
        emptyHint="пусто"
      />,
    );
  }

  it('доехали не все позиции — в заголовке «2 из 3»', () => {
    // Приёмка 13157: в УПД три позиции, в приёмке две. Счётчик «(2)» выглядел
    // так, будто столько в документе и было.
    renderWith({ ...document_, itemsCount: 3, coveredItemsCount: 2 });
    expect(screen.getByText(/Материалы · УПД № 1282 \(2 из 3\)/)).toBeTruthy();
  });

  it('доехали все — счётчик прежний, лишней дроби нет', () => {
    renderWith({ ...document_, itemsCount: 2, coveredItemsCount: 2 });
    expect(screen.getByText(/Материалы · УПД № 1282 \(2\)/)).toBeTruthy();
  });

  it('счётчиков нет вовсе (офлайн, черновик) — заголовок как раньше', () => {
    renderWith(document_);
    expect(screen.getByText(/Материалы · УПД № 1282 \(2\)/)).toBeTruthy();
  });

  it('не доехало ничего — «0 из 3», а не пустой блок без объяснения', () => {
    renderWith({ ...document_, itemsCount: 3, coveredItemsCount: 0 }, []);
    expect(screen.getByText(/Материалы · УПД № 1282 \(0 из 3\)/)).toBeTruthy();
  });
});
