// @vitest-environment jsdom
/**
 * Видимый признак правки названия.
 *
 * Правка существовала и раньше — по клику по тексту, — но ячейка выглядела как
 * обычный текст: за 90 дней из 8106 позиций, приехавших из документов,
 * переименовали ровно одну. Тест стережёт именно распознаваемость: карандаш
 * есть в разметке БЕЗ наведения (карточный режим — планшет, где hover не
 * существует), у ячейки есть доступное имя, а Escape откатывает набранное.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditableItemName } from './EditableItemName';

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof EditableItemName>[0]> = {}) {
  const onChange = vi.fn();
  const onStartEdit = vi.fn();
  const onStopEdit = vi.fn();
  render(
    <EditableItemName
      value="погворгрнт"
      onChange={onChange}
      disabledReason={null}
      editing={false}
      onStartEdit={onStartEdit}
      onStopEdit={onStopEdit}
      {...over}
    />,
  );
  return { onChange, onStartEdit, onStopEdit };
}

describe('EditableItemName', () => {
  it('карандаш виден без наведения', () => {
    const { container } = render(
      <EditableItemName
        value="погворгрнт"
        onChange={vi.fn()}
        disabledReason={null}
        editing={false}
        onStartEdit={vi.fn()}
        onStopEdit={vi.fn()}
      />,
    );
    expect(container.querySelector('.anticon-edit')).not.toBeNull();
  });

  it('у ячейки есть доступное имя с подсказкой о правке', () => {
    setup();
    expect(screen.getByRole('button', { name: /Нажмите, чтобы изменить/ })).toBeTruthy();
  });

  it('клик просит вызывающего открыть правку', () => {
    const { onStartEdit } = setup();
    fireEvent.click(screen.getByRole('button', { name: /Нажмите, чтобы изменить/ }));
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it('Enter открывает правку с клавиатуры', () => {
    const { onStartEdit } = setup();
    fireEvent.keyDown(screen.getByRole('button', { name: /Нажмите, чтобы изменить/ }), {
      key: 'Enter',
    });
    expect(onStartEdit).toHaveBeenCalledTimes(1);
  });

  it('в режиме правки виден инпут и напоминание про «Сохранить»', () => {
    setup({ editing: true });
    expect(screen.getByPlaceholderText('Наименование')).toBeTruthy();
    // Автосохранения в карточке нет: без этой строки человек уходит со
    // страницы, считая правку записанной.
    expect(screen.getByText('Применится после «Сохранить»')).toBeTruthy();
  });

  it('ввод отдаётся наверх', () => {
    const { onChange } = setup({ editing: true });
    fireEvent.change(screen.getByPlaceholderText('Наименование'), {
      target: { value: 'пог/погрузчик' },
    });
    expect(onChange).toHaveBeenCalledWith('пог/погрузчик');
  });

  it('Escape возвращает значение, с которым вошли в правку', () => {
    const onChange = vi.fn();
    const onStopEdit = vi.fn();
    const { rerender } = render(
      <EditableItemName
        value="погворгрнт"
        onChange={onChange}
        disabledReason={null}
        editing={false}
        onStartEdit={vi.fn()}
        onStopEdit={onStopEdit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Нажмите, чтобы изменить/ }));

    const props = {
      onChange,
      disabledReason: null,
      editing: true,
      onStartEdit: vi.fn(),
      onStopEdit,
    };
    rerender(<EditableItemName value="погворгрнт" {...props} />);
    rerender(<EditableItemName value="пог/пог" {...props} />);
    fireEvent.keyDown(screen.getByPlaceholderText('Наименование'), { key: 'Escape' });

    expect(onChange).toHaveBeenLastCalledWith('погворгрнт');
    expect(onStopEdit).toHaveBeenCalled();
  });

  it('без права правки нет ни кнопки, ни входа в режим по клику', () => {
    const { onStartEdit, container } = {
      ...setup({ disabledReason: 'Недостаточно прав для правки названия' }),
      container: document.body,
    };
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.anticon-edit')).toBeNull();
    fireEvent.click(screen.getByText('погворгрнт'));
    expect(onStartEdit).not.toHaveBeenCalled();
  });
});
