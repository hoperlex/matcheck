// @vitest-environment jsdom
/**
 * Плашка шапки карточек: один вид, окна открываются кликом и с клавиатуры.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Popover } from 'antd';
import { HeaderChip, HeaderRow, OperationHeader } from './HeaderChip';
import { chipText } from '../../test/chipText';

afterEach(cleanup);

describe('HeaderChip', () => {
  it('подпись и значение — одна плашка «Подпись: значение»', () => {
    render(<HeaderChip label="Дата документа" value="25.11.2026" />);
    expect(screen.getByText(chipText('Дата документа: 25.11.2026'))).toBeTruthy();
  });

  it('обёрнутая в Popover открывает его кликом — ref и обработчики доходят до плашки', async () => {
    render(
      <Popover content={<span>подробности</span>} trigger="click">
        <HeaderChip label="Договор" value="№ 1" interactive />
      </Popover>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Договор/ }));
    expect(await screen.findByText('подробности')).toBeTruthy();
  });

  it('с клавиатуры: Enter на плашке открывает окно так же, как клик', async () => {
    render(
      <Popover content={<span>редактор</span>} trigger="click">
        <HeaderChip label="Объект" value="СОБ62" interactive />
      </Popover>,
    );
    const chip = screen.getByRole('button', { name: /Объект/ });
    expect(chip.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(await screen.findByText('редактор')).toBeTruthy();
  });

  it('только для чтения — не кнопка и не в порядке Tab', () => {
    render(<HeaderChip label="Поставщик" value="АО «ТД»" />);
    expect(screen.queryByRole('button')).toBeNull();
    const chip = screen.getByText(chipText('Поставщик: АО «ТД»'));
    expect(chip.getAttribute('tabindex')).toBeNull();
  });

  it('недоступная плашка не открывается с клавиатуры', () => {
    render(<HeaderChip label="Объект" value="СОБ62" interactive disabled />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(chipText('Объект: СОБ62')).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('OperationHeader', () => {
  it('ряд — подпись и плашки', () => {
    render(
      <OperationHeader>
        <HeaderRow label="Учёт">
          <HeaderChip color="orange">🚚 Транзит</HeaderChip>
        </HeaderRow>
      </OperationHeader>,
    );
    expect(screen.getByText('Учёт')).toBeTruthy();
    expect(screen.getByText('🚚 Транзит')).toBeTruthy();
  });
});
