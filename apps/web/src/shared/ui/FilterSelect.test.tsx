// @vitest-environment jsdom
/**
 * Геометрия панели фильтров не должна зависеть от того, что в ней выбрано.
 *
 * Названия контрагентов бывают по 150–200 символов. Пока поля были
 * эластичными (minWidth) и сворачивали теги в режиме "responsive", выбор такого
 * значения расширял поле, сдвигал соседние контролы и заставлял rc-overflow
 * пересчитывать ширину на каждый кадр — панель дрожала.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FilterSelect } from './FilterSelect';

const LONG = 'ООО «Специализированное строительно-монтажное управление номер семнадцать дробь два»'.repeat(2);

const OPTIONS = [
  { value: 'a', label: LONG },
  { value: 'b', label: 'ООО «Ромашка»' },
  { value: 'c', label: 'ООО «Лютик»' },
];

afterEach(cleanup);

describe('FilterSelect', () => {
  it('ширина поля фиксирована и не зависит от выбранного значения', () => {
    const { container, rerender } = render(
      <FilterSelect mode="multiple" width={240} value={[]} onChange={() => {}} options={OPTIONS} />,
    );
    const select = container.querySelector('.ant-select') as HTMLElement;
    expect(select.style.width).toBe('240px');

    rerender(
      <FilterSelect
        mode="multiple"
        width={240}
        value={['a']}
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    expect((container.querySelector('.ant-select') as HTMLElement).style.width).toBe('240px');
  });

  it('длинное название обрезается внутри поля, а не растягивает его', () => {
    const { container } = render(
      <FilterSelect
        mode="multiple"
        width={240}
        value={['a']}
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    const tag = container.querySelector('.ant-tag') as HTMLElement;

    expect(tag.textContent).toContain('ООО «Специализированное');
    expect(tag.style.textOverflow).toBe('ellipsis');
    expect(tag.style.whiteSpace).toBe('nowrap');
    // Тег заведомо уже поля: иначе крестик очистки и «+N» выдавливались бы.
    expect(Number.parseInt(tag.style.maxWidth, 10)).toBeLessThan(240);
  });

  it('второе и последующие значения дают стабильный «+N», а не список тегов', () => {
    const { container } = render(
      <FilterSelect
        mode="multiple"
        width={240}
        value={['a', 'b', 'c']}
        onChange={() => {}}
        options={OPTIONS}
      />,
    );

    // Один тег со значением + отдельный «+2»; списка из трёх названий нет.
    const texts = Array.from(container.querySelectorAll('.ant-tag')).map((t) => t.textContent);
    expect(texts.filter((t) => t?.startsWith('ООО'))).toHaveLength(1);
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.queryByText('ООО «Лютик»')).toBeNull();
  });

  it('одиночный режим тоже обрезает длинное значение', () => {
    const { container } = render(
      <FilterSelect width={150} value="a" onChange={() => {}} options={OPTIONS} />,
    );
    const item = container.querySelector('.ant-select-selection-item span') as HTMLElement;

    expect(item.style.textOverflow).toBe('ellipsis');
    expect(Number.parseInt(item.style.maxWidth, 10)).toBeLessThan(150);
  });
});
