// @vitest-environment jsdom
/**
 * ResponsiveTable в стиле FOT: текст ячеек — до двух строк (ClampText), JSX
 * остаётся как есть, колонки с явным ellipsis — прежним однострочным путём.
 *
 * Отдельно держим fixed-раскладку: раньше её включал общий ellipsis колонок,
 * и без явного tableLayout таблицы без scroll.y (Роли, позиции приёмки) перешли
 * бы на auto — колонки растянулись бы по тексту.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Tag } from 'antd';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveTable } from './ResponsiveTable';

type Row = { id: string; name: string; note: string; status: string };

const ROWS: Row[] = [
  { id: '1', name: 'АЛ13 · ЖК АЛИЯ, БЛОКИ 13А, 13В', note: 'короткая', status: 'ok' },
  { id: '2', name: 'Склад', note: 'длинная заметка', status: 'bad' },
];

function renderTable(props: Partial<Parameters<typeof ResponsiveTable<Row>>[0]> = {}) {
  return render(
    <ResponsiveTable<Row>
      items={ROWS}
      rowKey="id"
      cardRender={(r) => r.name}
      columns={[
        { title: 'Объект', dataIndex: 'name' },
        { title: 'Заметка', dataIndex: 'note', ellipsis: true },
        {
          title: 'Статус',
          dataIndex: 'status',
          render: (v: string) => <Tag>{v}</Tag>,
        },
        { title: '', key: 'actions', render: () => <button type="button">x</button> },
      ]}
      {...props}
    />,
  );
}

afterEach(cleanup);

describe('ResponsiveTable: вид FOT', () => {
  it('строковая ячейка переносится до двух строк, JSX — как есть', () => {
    const { container } = renderTable();
    const clamp = screen.getByText('АЛ13 · ЖК АЛИЯ, БЛОКИ 13А, 13В');
    expect(clamp.classList.contains('mc-clamp2')).toBe(true);
    // Тег не превращается в текст и не получает обёртку переноса.
    const tag = screen.getByText('ok');
    expect(tag.closest('.ant-tag')).toBeTruthy();
    expect(tag.closest('.mc-clamp2')).toBeNull();
    // «Склад» — одно слово: переносить нечего, идёт одной строкой.
    expect(container.querySelectorAll('.mc-clamp2')).toHaveLength(1);
    expect(screen.getByText('Склад').classList.contains('mc-clamp2')).toBe(false);
  });

  it('суммы, даты, номера и коды без пробелов не переносятся — одна строка с подсказкой', () => {
    // formatMoneyRu разделяет разряды узким неразрывным пробелом (U+202F): для
    // браузера «1 564 512,34» — одно слово, и перенос до двух строк резал его
    // по цифрам («1 564 5» / «₽»). Так же резался номер с буквами без пробелов:
    // «МО/25347/2017» → «МО/25347/201» / «7».
    type Cell = { id: string; value: string };
    const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(1564512.34);
    const values = [
      `${money} ₽`,
      '04.09.2026',
      '20.10.2026 07:58',
      '201/2112732',
      '1 234,5',
      'МО/25347/2017',
      'АМА5-021457/4',
    ];
    const { container } = render(
      <ResponsiveTable<Cell>
        items={[
          ...values.map((value, i) => ({ id: String(i), value })),
          { id: 'text', value: 'ЖК МАРК (ЛОТ №33)' },
        ]}
        rowKey="id"
        cardRender={(r) => r.value}
        columns={[{ title: 'Значение', dataIndex: 'value' }]}
      />,
    );
    // Ищем по textContent как есть: нормализатор testing-library схлопывает
    // узкий неразрывный пробел суммы, и getByText её не находит.
    const spans = Array.from(container.querySelectorAll<HTMLElement>('td span'));
    for (const v of values) {
      const cell = spans.find((el) => el.textContent === v);
      expect(cell, v).toBeTruthy();
      expect(cell!.classList.contains('mc-clamp2'), v).toBe(false);
    }
    // Текст из нескольких слов по-прежнему переносится до двух строк.
    expect(screen.getByText('ЖК МАРК (ЛОТ №33)').classList.contains('mc-clamp2')).toBe(true);
  });

  it('колонка с явным ellipsis остаётся однострочной', () => {
    renderTable();
    const note = screen.getByText('короткая');
    expect(note.closest('.mc-clamp2')).toBeNull();
    expect(note.closest('td')?.classList.contains('ant-table-cell-ellipsis')).toBe(true);
  });

  it('служебные колонки получают свои классы, таблица — fixed-раскладку', () => {
    const { container } = renderTable({ numbered: true });
    expect(container.querySelector('.ant-table-wrapper.mc-rt')).toBeTruthy();
    expect(container.querySelector('.ant-table-layout-fixed')).toBeTruthy();
    expect(container.querySelectorAll('td.mc-col-actions')).toHaveLength(2);
    const nums = container.querySelectorAll('td.mc-col-num');
    expect(Array.from(nums).map((td) => td.textContent)).toEqual(['1', '2']);
  });

  it('при numberedSortable={false} «№» без сортировки', () => {
    const { container } = renderTable({ numbered: true, numberedSortable: false });
    const numTh = Array.from(container.querySelectorAll('.ant-table-thead th')).find(
      (th) => th.textContent === '№',
    );
    expect(numTh).toBeTruthy();
    expect(numTh!.classList.contains('ant-table-column-has-sorters')).toBe(false);
  });

  it('по умолчанию «№» сортируемый, как раньше', () => {
    const { container } = renderTable({ numbered: true });
    const numTh = Array.from(container.querySelectorAll('.ant-table-thead th')).find(
      (th) => th.textContent === '№',
    )!;
    expect(numTh.classList.contains('ant-table-column-has-sorters')).toBe(true);
    // Клик по «№» разворачивает исходный порядок: первая строка — вторая запись.
    fireEvent.click(numTh);
    fireEvent.click(numTh);
    const firstRow = container.querySelector('.ant-table-tbody > tr.ant-table-row');
    expect(firstRow?.textContent).toContain('Склад');
  });
});

type City = { id: string; name: string; city: string };
const CITIES: City[] = [
  { id: '1', name: 'Бета', city: 'Москва' },
  { id: '2', name: 'Альфа', city: 'Казань' },
  { id: '3', name: 'Гамма', city: 'Москва' },
];

function cityTable(props: Partial<Parameters<typeof ResponsiveTable<City>>[0]> = {}) {
  return render(
    <ResponsiveTable<City>
      items={CITIES}
      rowKey="id"
      cardRender={(r) => r.name}
      // Страница из двух строк: сортировка и фильтр обязаны работать по всему
      // списку, а не по видимой странице.
      pagination={{ pageSize: 2 }}
      autoColumnTools={{ total: CITIES.length }}
      columns={[
        { title: 'Название', dataIndex: 'name' },
        { title: 'Город', dataIndex: 'city' },
      ]}
      {...props}
    />,
  );
}

function th(container: HTMLElement, title: string): HTMLElement {
  return Array.from(container.querySelectorAll<HTMLElement>('.ant-table-thead th')).find(
    (el) => el.textContent?.trim() === title,
  )!;
}
const shownNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.ant-table-tbody > tr.ant-table-row')).map(
    (tr) => tr.querySelectorAll('td')[0]?.textContent,
  );

describe('ResponsiveTable: сортировка и фильтр в колонках (autoColumnTools)', () => {
  it('сортировка — по всему списку, а не по странице', () => {
    const { container } = cityTable();
    expect(shownNames(container)).toEqual(['Бета', 'Альфа']);
    fireEvent.click(th(container, 'Название'));
    // «Альфа» и «Бета» — первые по алфавиту из ВСЕХ трёх, «Гамма» уехала на 2-ю.
    expect(shownNames(container)).toEqual(['Альфа', 'Бета']);
    fireEvent.click(th(container, 'Название'));
    expect(shownNames(container)).toEqual(['Гамма', 'Бета']);
  });

  it('фильтр по значениям — по всему списку, со счётчиками', async () => {
    const { container } = cityTable();
    fireEvent.click(th(container, 'Город').querySelector('.ant-table-filter-trigger')!);
    const dialog = await screen.findByRole('dialog');
    const moscow = within(dialog).getByText('Москва').closest('label')!;
    expect(moscow.textContent).toContain('2');
    fireEvent.click(moscow.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(shownNames(container)).toEqual(['Бета', 'Гамма']));
  });

  it('применение фильтра снимает массовый выбор', async () => {
    const onSelect = vi.fn();
    const { container } = cityTable({
      rowSelection: { selectedRowKeys: ['2'], onChange: onSelect },
    });
    fireEvent.click(th(container, 'Город').querySelector('.ant-table-filter-trigger')!);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByText('Москва').closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith([], [], { type: 'none' }));
  });

  it('неполный список — без стрелок и воронок, с подсказкой', () => {
    const { container } = cityTable({ autoColumnTools: { total: 501 } });
    expect(container.querySelector('.ant-table-filter-trigger')).toBeNull();
    expect(th(container, 'Название').classList.contains('ant-table-column-has-sorters')).toBe(
      false,
    );
    expect(container.textContent).toContain('Показаны первые 3 из 501');
  });

  it('серверная пагинация — инструменты не включаются', () => {
    const { container } = cityTable({ pagination: { pageSize: 2, total: 3 } });
    expect(container.querySelector('.ant-table-filter-trigger')).toBeNull();
    expect(container.textContent).not.toContain('Показаны первые');
  });

  it('без autoColumnTools — как раньше', () => {
    const { container } = cityTable({ autoColumnTools: undefined });
    expect(container.querySelector('.ant-table-filter-trigger')).toBeNull();
    expect(th(container, 'Город').classList.contains('ant-table-column-has-sorters')).toBe(false);
  });
});

/**
 * Группы приёмок: строки групп добавляются к странице сверх pageSize. antd при
 * `items.length > pageSize` и `< total` режет массив сам — на второй странице
 * от 50 приёмок и трёх строк групп осталось бы три строки. Отдельный
 * переключатель страниц этого не допускает.
 */
describe('ResponsiveTable: строки сверх страницы и колонка левее галочек', () => {
  type Line = { id: string; name: string };
  const page2: Line[] = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `head-${i}`, name: `Группа ${i}` })),
    ...Array.from({ length: 50 }, (_, i) => ({ id: `d-${i}`, name: `Приёмка ${51 + i}` })),
  ];
  const table = (props: Partial<Parameters<typeof ResponsiveTable<Line>>[0]> = {}) =>
    render(
      <ResponsiveTable<Line>
        items={page2}
        rowKey="id"
        cardRender={(r) => r.name}
        columns={[{ title: 'Название', dataIndex: 'name' }]}
        pagination={{ current: 2, pageSize: 50, total: 120, onChange: () => {} }}
        {...props}
      />,
    );
  const bodyRows = (c: HTMLElement) =>
    c.querySelectorAll('.ant-table-tbody > tr.ant-table-row').length;

  it('встроенная пагинация antd режет 53 строки второй страницы — поэтому и нужен отдельный переключатель', () => {
    const { container } = table();
    expect(bodyRows(container)).toBe(3);
  });

  it('externalPagination: все 53 строки на месте, переключатель страниц под таблицей', () => {
    const onChange = vi.fn();
    const { container } = table({
      externalPagination: true,
      pagination: { current: 2, pageSize: 50, total: 120, onChange },
    });
    expect(bodyRows(container)).toBe(53);
    expect(screen.getByText('Приёмка 100')).toBeTruthy();
    const pager = container.querySelector('.ant-table-pagination');
    expect(pager).not.toBeNull();
    expect(pager!.querySelector('.ant-pagination-item-active')?.textContent).toBe('2');
    fireEvent.click(pager!.querySelector('.ant-pagination-item-3')!);
    expect(onChange).toHaveBeenCalledWith(3, 50);
  });

  it('leadingColumn стоит левее галочек выбора', () => {
    const { container } = table({
      items: page2.slice(3, 5),
      pagination: false,
      rowSelection: { selectedRowKeys: [], onChange: () => {} },
      leadingColumn: { key: 'gutter', width: 28, render: () => <span>скобка</span> },
    });
    const firstRow = container.querySelector('.ant-table-tbody > tr.ant-table-row')!;
    const cells = [...firstRow.querySelectorAll('td')];
    expect(cells[0]!.textContent).toBe('скобка');
    expect(cells[1]!.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(cells[2]!.textContent).toContain('Приёмка 51');
  });
});
