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

  describe('«Удалить материалы» в блоке отвязанного документа', () => {
    const unlinked = () => [doc(), doc({ id: 'd2', docNumber: '0000-0082604', linked: false })];

    it('есть только у отвязанного блока со строками и убирает весь блок', () => {
      const onRemoveSection = vi.fn();
      renderSections({ documents: unlinked(), onRemoveSection });

      // Одна кнопка — у отвязанного d2; у связанного d1 её нет.
      const buttons = screen.getAllByText('Удалить материалы');
      expect(buttons).toHaveLength(1);
      fireEvent.click(buttons[0]!);
      // Подтверждение говорит, сколько строк уйдёт и что нужно сохранить.
      expect(screen.getByText('Удалить все строки блока (1)?')).toBeTruthy();
      expect(screen.getByText('Изменение применится после сохранения.')).toBeTruthy();
      fireEvent.click(screen.getByText('Удалить'));

      expect(onRemoveSection).toHaveBeenCalledWith('d2');
      // Клик в заголовке не раскрыл блок.
      expect(screen.queryByText('Хомут CON-PIPE')).toBeNull();
    });

    it('без права на правку кнопки нет', () => {
      renderSections({ documents: unlinked() });

      expect(screen.queryByText('Удалить материалы')).toBeNull();
    });
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

  it('содержимое заголовка блока: своё у каждого документа, клик не переключает блок', () => {
    const onPick = vi.fn();
    renderSections({
      sectionExtra: (section) =>
        section.document ? (
          <button type="button" onClick={() => onPick(section.document!.id)}>
            ЭДО {section.document.docNumber}
          </button>
        ) : null,
    });

    fireEvent.click(screen.getByText('ЭДО 0000-0082604'));
    expect(onPick).toHaveBeenCalledWith('d2');
    // Блок не раскрылся: строки документа по-прежнему не видны.
    expect(screen.queryByText('Хомут CON-PIPE')).toBeNull();
    expect(screen.getByText('ЭДО 0000-0082603')).toBeTruthy();
  });

  it('содержимое заголовка стоит рядом с «Материал», а не вместо неё', () => {
    const onAddItem = vi.fn();
    renderSections({ onAddItem, sectionExtra: () => <span>чип</span> });

    expect(screen.getAllByText('чип')).toHaveLength(2);
    expect(screen.getAllByText('Материал')).toHaveLength(2);
  });
});

// Пропы для блока с УПД из ЭДО: строки ЭДО сверху, таблица факта — в подблок.
// Без пропов разметка прежняя — это проверяют кейсы выше без правок.
describe('OperationItemsSections — тело, заголовок и автораскрытие', () => {
  const isOpen = (title: string) =>
    screen
      .getByText(title)
      .closest('.ant-collapse-item')!
      .classList.contains('ant-collapse-item-active');

  it('обёртка тела получает ту же таблицу своего блока', () => {
    renderSections({
      autoOpenKeys: ['d1'],
      renderSectionBody: (section, table) =>
        section.key === 'd1' ? (
          <div>
            <span>строки ЭДО</span>
            {table}
          </div>
        ) : (
          table
        ),
    });
    expect(screen.getByText('строки ЭДО')).toBeTruthy();
    // Таблица в обёртке — та же: строка своего документа на месте, чужой нет.
    expect(screen.getByText('Труба SML DN 80')).toBeTruthy();
    expect(screen.queryByText('Хомут CON-PIPE')).toBeNull();
  });

  it('пустой блок отдаёт обёртке подсказку вместо таблицы', () => {
    const bodies: string[] = [];
    renderSections({
      items: [],
      documents: [doc()],
      autoOpenKeys: ['d1'],
      renderSectionBody: (_section, table) => (
        <div ref={(el) => el && bodies.push(el.textContent ?? '')}>{table}</div>
      ),
    });
    expect(bodies.at(-1)).toBe('В этом документе не распознано ни одной позиции.');
  });

  it('свой заголовок блока; по умолчанию — прежний; кнопки заголовка на месте', () => {
    const onAddItem = vi.fn();
    renderSections({
      onAddItem,
      sectionExtra: () => <span>чип</span>,
      sectionLabel: (section, defaultLabel) =>
        section.key === 'd1' ? 'Материалы · УПД № 0000-0082603 · ЭДО (5)' : defaultLabel,
    });
    expect(screen.getByText('Материалы · УПД № 0000-0082603 · ЭДО (5)')).toBeTruthy();
    expect(screen.getByText('Материалы · УПД № 0000-0082604 (1)')).toBeTruthy();
    expect(screen.getAllByText('чип')).toHaveLength(2);
    expect(screen.getAllByText('Материал')).toHaveLength(2);
  });

  it('автораскрытие — один раз; свёрнутый человеком не раскрывается снова, новый ключ — раскрывается', () => {
    const first = 'Материалы · УПД № 0000-0082603 (1)';
    const second = 'Материалы · УПД № 0000-0082604 (1)';
    const view = renderSections({ autoOpenKeys: ['d1'] });
    expect(isOpen(first)).toBe(true);
    expect(isOpen(second)).toBe(false);

    fireEvent.click(screen.getByText(first));
    expect(isOpen(first)).toBe(false);

    const rerender = (autoOpenKeys: string[]) =>
      view.rerender(
        <OperationItemsSections<Row>
          items={[
            { clientKey: 'k1', sourceDocumentId: 'd1', nameRaw: 'Труба SML DN 80' },
            { clientKey: 'k2', sourceDocumentId: 'd2', nameRaw: 'Хомут CON-PIPE' },
          ]}
          documents={[doc(), doc({ id: 'd2', docNumber: '0000-0082604' })]}
          columns={columns}
          cardRender={(row) => <span>{row.nameRaw}</span>}
          emptyHint="Материалы можно не добавлять"
          autoOpenKeys={autoOpenKeys}
        />,
      );
    // Опрос карточки: тот же состав — новым массивом.
    rerender(['d1']);
    expect(isOpen(first)).toBe(false);
    // Привязали УПД ко второму блоку.
    rerender(['d1', 'd2']);
    expect(isOpen(first)).toBe(false);
    expect(isOpen(second)).toBe(true);
  });
});
