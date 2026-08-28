// @vitest-environment jsdom
/**
 * Блоки материалов по документам поставки.
 *
 * Проверяем то, что нельзя увидеть в чистой группировке: заголовки блоков,
 * куда попадает новая строка и что свёрнутый блок не теряет свои позиции —
 * сохранение приёмки переписывает delivery_items целиком, и «невидимая» строка
 * означала бы потерю данных.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { OperationItemsSections } from './OperationItemsSections';

type Row = { clientKey: string; sourceDocumentId: string | null; nameRaw: string };

const doc = (over: Partial<OperationSourceDocument> = {}): OperationSourceDocument => ({
  id: 'd1',
  kind: 'upd',
  status: 'parsed',
  docNumber: '0000-0082603',
  docDate: '2026-08-26',
  expectedDate: null,
  totalSum: '747171.00',
  vatSum: null,
  linked: true,
  ...over,
});

const columns = [{ title: 'Название', dataIndex: 'nameRaw', key: 'nameRaw' }];

function renderSections(props: Partial<Parameters<typeof OperationItemsSections<Row>>[0]> = {}) {
  const items: Row[] = props.items ?? [
    { clientKey: 'k1', sourceDocumentId: 'd1', nameRaw: 'Труба SML DN 80' },
    { clientKey: 'k2', sourceDocumentId: 'd2', nameRaw: 'Хомут CON-PIPE' },
  ];
  return render(
    <OperationItemsSections<Row>
      items={items}
      documents={props.documents ?? [doc(), doc({ id: 'd2', docNumber: '0000-0082604' })]}
      columns={columns}
      cardRender={(row) => <span>{row.nameRaw}</span>}
      onAddItem={props.onAddItem}
      emptyHint="Материалы можно не добавлять"
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('OperationItemsSections', () => {
  it('на каждый документ свой блок с номером и числом позиций', () => {
    renderSections();

    expect(screen.getByText('Материалы · УПД № 0000-0082603 (1)')).toBeTruthy();
    expect(screen.getByText('Материалы · УПД № 0000-0082604 (1)')).toBeTruthy();
  });

  it('блоки свёрнуты, раскрытие показывает позиции своего документа', () => {
    renderSections();

    expect(screen.queryByText('Труба SML DN 80')).toBeNull();
    fireEvent.click(screen.getByText('Материалы · УПД № 0000-0082603 (1)'));

    expect(screen.getByText('Труба SML DN 80')).toBeTruthy();
    // Чужая строка не подмешалась: у соседнего документа свой блок.
    expect(screen.queryByText('Хомут CON-PIPE')).toBeNull();
  });

  it('«Материал» добавляет строку в свой документ и не переключает блок', () => {
    const onAddItem = vi.fn();
    renderSections({ onAddItem });

    // Кнопка «+ Материал» стоит в заголовке каждого блока, куда можно добавлять.
    const buttons = screen.getAllByText('Материал');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);

    expect(onAddItem).toHaveBeenCalledWith('d2');
  });

  it('в блоке отвязанного документа добавить строку нельзя', () => {
    // Сервер принимает происхождение новой строки только для связанного
    // документа — кнопка молча превратила бы её в «без привязки».
    const onAddItem = vi.fn();
    renderSections({
      documents: [doc({ id: 'd2', docNumber: '0000-0082604', linked: false })],
      items: [{ clientKey: 'k2', sourceDocumentId: 'd2', nameRaw: 'Хомут CON-PIPE' }],
      onAddItem,
    });

    expect(screen.getByText('Материалы · отвязан УПД № 0000-0082604 (1)')).toBeTruthy();
    expect(screen.queryByText('Материал')).toBeNull();
  });

  it('строки без происхождения живут в своём блоке', () => {
    renderSections({
      items: [
        { clientKey: 'k1', sourceDocumentId: 'd1', nameRaw: 'Труба SML DN 80' },
        { clientKey: 'k9', sameKey: undefined, sourceDocumentId: null, nameRaw: 'Песок' } as Row,
      ],
      documents: [doc()],
    });

    expect(screen.getByText('Материалы · без привязки к документу (1)')).toBeTruthy();
  });

  it('приёмка без документов — один блок «Материалы» с подсказкой', () => {
    renderSections({ items: [], documents: [], onAddItem: vi.fn() });

    fireEvent.click(screen.getByText('Материалы (0)'));
    expect(screen.getByText('Материалы можно не добавлять')).toBeTruthy();
  });

  it('связанный документ без позиций виден отдельным блоком', () => {
    renderSections({
      items: [{ clientKey: 'k1', sourceDocumentId: 'd1', nameRaw: 'Труба SML DN 80' }],
      documents: [doc(), doc({ id: 'd2', docNumber: '0000-0082604' })],
    });

    fireEvent.click(screen.getByText('Материалы · УПД № 0000-0082604 (0)'));
    expect(screen.getByText('В этом документе не распознано ни одной позиции.')).toBeTruthy();
  });
});
