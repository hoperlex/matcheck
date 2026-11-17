// @vitest-environment jsdom
/**
 * Выбор объектов наблюдателя в админке.
 *
 * Каждое сохранение завершает сессии наблюдателя, поэтому изменение уходит не
 * на каждый щелчок в открытом списке, а когда список закрыт. Снятие тега
 * крестиком при закрытом списке — законченное действие, уходит сразу.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Site } from '@matcheck/contracts';
import { ObserverSitesSelect } from './ObserverSitesSelect';

const site = (id: string, code: string): Site =>
  ({ id, code, name: `Объект ${code}`, isActive: true }) as unknown as Site;
const A = site('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'A1');
const B = site('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'B2');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Закрыть список так, как его закрывает уход фокуса: rc-select делает это таймером. */
function closeByBlur(box: HTMLElement) {
  act(() => {
    fireEvent.blur(box);
    vi.runAllTimers();
  });
}

describe('ObserverSitesSelect', () => {
  it('изменения в открытом списке уходят одним сохранением при закрытии', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<ObserverSitesSelect value={[]} sites={[A, B]} onCommit={onCommit} />);
    const box = screen.getByRole('combobox', { name: 'Объекты наблюдателя' });
    fireEvent.mouseDown(box);
    fireEvent.click(screen.getByTitle('A1 · Объект A1'));
    fireEvent.click(screen.getByTitle('B2 · Объект B2'));
    expect(onCommit).not.toHaveBeenCalled();
    closeByBlur(box);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith([A.id, B.id]);
  });

  it('снятие тега при закрытом списке уходит сразу', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <ObserverSitesSelect value={[A.id, B.id]} sites={[A, B]} onCommit={onCommit} />,
    );
    const remove = container.querySelectorAll('.ant-select-selection-item-remove');
    expect(remove).toHaveLength(2);
    fireEvent.click(remove[0]!);
    expect(onCommit).toHaveBeenCalledWith([B.id]);
  });

  it('тот же набор не сохраняется — сессии наблюдателя зря не гасятся', () => {
    vi.useFakeTimers();
    const onCommit = vi.fn();
    render(<ObserverSitesSelect value={[A.id]} sites={[A, B]} onCommit={onCommit} />);
    const box = screen.getByRole('combobox', { name: 'Объекты наблюдателя' });
    fireEvent.mouseDown(box);
    closeByBlur(box);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('без права правки выбор отключён', () => {
    const { container } = render(
      <ObserverSitesSelect value={[A.id]} sites={[A, B]} disabled onCommit={vi.fn()} />,
    );
    expect(container.querySelectorAll('.ant-select-disabled')).toHaveLength(1);
  });
});
