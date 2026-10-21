// @vitest-environment jsdom
/**
 * ResponsiveTable в стиле FOT: текст ячеек — до двух строк (ClampText), JSX
 * остаётся как есть, колонки с явным ellipsis — прежним однострочным путём.
 *
 * Отдельно держим fixed-раскладку: раньше её включал общий ellipsis колонок,
 * и без явного tableLayout таблицы без scroll.y (Роли, позиции приёмки) перешли
 * бы на auto — колонки растянулись бы по тексту.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Tag } from 'antd';
import { afterEach, describe, expect, it } from 'vitest';
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
    expect(container.querySelectorAll('.mc-clamp2')).toHaveLength(2);
  });

  it('суммы, даты и номера из цифр не переносятся — одна строка с подсказкой', () => {
    // formatMoneyRu разделяет разряды узким неразрывным пробелом (U+202F): для
    // браузера «1 564 512,34» — одно слово, и перенос до двух строк резал его
    // по цифрам («1 564 5» / «₽»).
    type Cell = { id: string; value: string };
    const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(1564512.34);
    const values = [`${money} ₽`, '04.09.2026', '20.10.2026 07:58', '201/2112732', '1 234,5'];
    const { container } = render(
      <ResponsiveTable<Cell>
        items={[
          ...values.map((value, i) => ({ id: String(i), value })),
          { id: 'text', value: 'ЖК МАРК (ЛОТ №33)' },
          { id: 'code', value: 'АМА5-021457/4' },
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
    // Текст с буквами по-прежнему переносится до двух строк.
    expect(screen.getByText('ЖК МАРК (ЛОТ №33)').classList.contains('mc-clamp2')).toBe(true);
    expect(screen.getByText('АМА5-021457/4').classList.contains('mc-clamp2')).toBe(true);
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
