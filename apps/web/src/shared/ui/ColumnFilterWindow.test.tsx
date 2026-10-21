// @vitest-environment jsdom
/**
 * Окно фильтра колонки в стиле FOT. Поведение одно для всех таблиц:
 * - набранное в окне действует только после «Применить»;
 * - «Сбросить» сразу снимает фильтр колонки и закрывает окно;
 * - Esc закрывает без изменений.
 *
 * Плюс подключение к antd Table: одно применение — ровно один Table.onChange
 * (страница пишет адрес от снимка параметров, второй вызов затёр бы первый), и
 * повторное открытие показывает действующий фильтр, а не набранное в прошлый раз.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Table, type TableProps } from 'antd';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { antdColumnFilter, ColumnFilterWindow, type FilterOption } from './ColumnFilterWindow';

const OPTIONS: FilterOption[] = [
  { value: 'a', label: 'Альфа', count: 3 },
  { value: 'b', label: 'Бета', count: 1 },
  { value: 'c', label: 'Гамма', count: 0 },
];

afterEach(cleanup);

function checkbox(label: string): HTMLInputElement {
  return screen.getByText(label).closest('label')!.querySelector('input')!;
}

describe('ColumnFilterWindow: значения', () => {
  it('поиск сужает список, «Выбрать показанные» берёт только найденное', () => {
    const onApply = vi.fn();
    render(
      <ColumnFilterWindow
        kind="values"
        title="Объект"
        options={OPTIONS}
        selected={[]}
        showCounts
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    fireEvent.change(screen.getByLabelText('Найти значение'), { target: { value: 'ета' } });
    expect(screen.queryByText('Альфа')).toBeNull();
    expect(screen.getByText('Бета')).toBeTruthy();

    fireEvent.click(screen.getByText('Выбрать показанные'));
    expect(screen.getByText('Выбрано: 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    expect(onApply).toHaveBeenCalledWith(['b']);
  });

  it('«Снять всё» и «Применить» снимают фильтр', () => {
    const onApply = vi.fn();
    render(
      <ColumnFilterWindow
        kind="values"
        title="Объект"
        options={OPTIONS}
        selected={['a', 'b']}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    expect(checkbox('Альфа').checked).toBe(true);
    fireEvent.click(screen.getByText('Снять всё'));
    expect(checkbox('Альфа').checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it('«Сбросить» снимает фильтр сразу, без «Применить»', () => {
    const onApply = vi.fn();
    render(
      <ColumnFilterWindow
        kind="values"
        title="Объект"
        options={OPTIONS}
        selected={['a']}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    fireEvent.click(checkbox('Бета'));
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it('Esc закрывает окно и ничего не применяет', () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <ColumnFilterWindow
        kind="values"
        title="Объект"
        options={OPTIONS}
        selected={[]}
        onClose={onClose}
        onApply={onApply}
      />,
    );
    fireEvent.click(checkbox('Альфа'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('выбранное значение вне списка вариантов видно и снимается', () => {
    render(
      <ColumnFilterWindow
        kind="values"
        title="Объект"
        options={OPTIONS}
        selected={['архивный']}
        onClose={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(checkbox('архивный').checked).toBe(true);
  });
});

describe('ColumnFilterWindow: даты и текст', () => {
  it('«с» позже «по» — «Применить» недоступна', () => {
    render(
      <ColumnFilterWindow
        kind="dates"
        title="Дата"
        from="2026-08-10"
        to="2026-08-01"
        onClose={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('позже');
    expect((screen.getByRole('button', { name: 'Применить' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('пустой диапазон по «Применить» — снять фильтр', () => {
    const onApply = vi.fn();
    render(
      <ColumnFilterWindow
        kind="dates"
        title="Дата"
        from={null}
        to={null}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    expect(onApply).toHaveBeenCalledWith(null);
  });

  it('текст применяется по Enter, очистка ввода на лету', () => {
    const onApply = vi.fn();
    render(
      <ColumnFilterWindow
        kind="text"
        title="id"
        value=""
        placeholder="Номер"
        sanitize={(s) => s.replace(/\D/g, '')}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    const input = screen.getByLabelText('Номер') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12a3' } });
    expect(input.value).toBe('123');
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(onApply).toHaveBeenCalledWith('123');
  });
});

type Row = { id: string; kind: string };
const ROWS: Row[] = [
  { id: '1', kind: 'a' },
  { id: '2', kind: 'b' },
];

/** Таблица, которая держит фильтр сама — как серверные страницы портала. */
function ControlledTable({
  onChange,
  external,
}: {
  onChange: NonNullable<TableProps<Row>['onChange']>;
  external?: string[] | null;
}) {
  const [value, setValue] = useState<string[] | null>(external ?? null);
  return (
    <>
      <button type="button" onClick={() => setValue(null)}>
        снять снаружи
      </button>
      <Table<Row>
        rowKey="id"
        dataSource={ROWS}
        pagination={false}
        onChange={(p, filters, s, extra) => {
          setValue((filters['kind'] as string[] | null) ?? null);
          onChange(p, filters, s, extra);
        }}
        columns={[
          {
            title: 'Тип',
            key: 'kind',
            dataIndex: 'kind',
            ...antdColumnFilter<Row>({ kind: 'values', title: 'Тип', options: OPTIONS }),
            filteredValue: value,
          },
        ]}
      />
    </>
  );
}

function openFunnel(container: HTMLElement): void {
  fireEvent.click(container.querySelector('.ant-table-filter-trigger')!);
}

describe('antdColumnFilter в таблице', () => {
  it('«Применить» — один Table.onChange с выбранными значениями', async () => {
    const onChange = vi.fn();
    const { container } = render(<ControlledTable onChange={onChange} />);
    openFunnel(container);
    fireEvent.click(checkbox('Альфа'));
    fireEvent.click(screen.getByRole('button', { name: 'Применить' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]![1]).toEqual({ kind: ['a'] });
    expect(container.querySelector('.ant-table-filter-trigger.active')).toBeTruthy();
  });

  it('«Сбросить» — один Table.onChange со снятым фильтром', async () => {
    const onChange = vi.fn();
    const { container } = render(<ControlledTable onChange={onChange} external={['a']} />);
    openFunnel(container);
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]![1]).toEqual({ kind: null });
  });

  it('повторное открытие показывает действующий фильтр', async () => {
    const onChange = vi.fn();
    const { container } = render(<ControlledTable onChange={onChange} external={['a']} />);
    openFunnel(container);
    expect(checkbox('Альфа').checked).toBe(true);
    // Набрали и закрыли без применения.
    fireEvent.click(checkbox('Бета'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    // Фильтр сняли снаружи (чип, адрес).
    fireEvent.click(screen.getByText('снять снаружи'));
    openFunnel(container);
    await waitFor(() => expect(checkbox('Альфа').checked).toBe(false));
    expect(checkbox('Бета').checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
