// @vitest-environment jsdom
/**
 * Подсказка «Признака» по справочнику «Объекты и вид» в карточке приёмки (0161):
 *   - поставил справочник → «📒 по справочнику», кнопка в цвете вида;
 *   - человек выбрал то же → «✓ совпадает со справочником»;
 *   - выбрано другое или пусто → серым «справочник: …»; «оба вида» — два пункта;
 *   - пункты меню из справочника помечены, остальные — без пометки.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeliveryPurposeHint } from '@matcheck/contracts';
import {
  PurposeDirectoryMark,
  purposeButtonColor,
  purposeDirectoryState,
  purposeMenuLabel,
} from './purposeDirectoryHint';

afterEach(cleanup);

const tolling: DeliveryPurposeHint = { kind: 'tolling_act', manual: false, siteCode: 'ИНДЖ' };
const both: DeliveryPurposeHint = { kind: 'realization_tolling', manual: false, siteCode: 'Д56' };
const own: DeliveryPurposeHint = { kind: 'contractor_materials', manual: true, siteCode: 'СОБ62' };

describe('purposeDirectoryState', () => {
  it('источник и совпадение', () => {
    expect(purposeDirectoryState(tolling, 'tolling_act', true)).toBe('auto');
    expect(purposeDirectoryState(tolling, 'tolling_act', false)).toBe('match');
    expect(purposeDirectoryState(tolling, 'contractor_materials', false)).toBe('differs');
    expect(purposeDirectoryState(tolling, null, false)).toBe('differs');
    expect(purposeDirectoryState(both, 'realization', false)).toBe('match');
    expect(purposeDirectoryState(both, null, false)).toBe('differs');
    expect(purposeDirectoryState(null, 'tolling_act', true)).toBe('none');
    expect(purposeDirectoryState(undefined, null, false)).toBe('none');
  });

  it('кнопка окрашена только у подставленного признака', () => {
    expect(purposeButtonColor(tolling, 'auto')).toBe('orange');
    expect(purposeButtonColor(own, 'auto')).toBe('green');
    expect(purposeButtonColor(tolling, 'match')).toBeUndefined();
    expect(purposeButtonColor(null, 'auto')).toBeUndefined();
  });
});

describe('PurposeDirectoryMark', () => {
  it('подставлен справочником — цветная метка', () => {
    render(<PurposeDirectoryMark hint={tolling} state="auto" />);
    const mark = screen.getByTestId('purpose-directory-mark');
    expect(mark.textContent).toBe('📒 по справочнику');
    expect(mark.className).toContain('ant-tag-orange');
  });

  it('выбран тот же — «совпадает со справочником»', () => {
    render(<PurposeDirectoryMark hint={tolling} state="match" />);
    expect(screen.getByTestId('purpose-directory-mark').textContent).toBe(
      '✓ совпадает со справочником',
    );
  });

  it('выбрано другое — серым вид справочника; «оба вида» — два пункта', () => {
    render(<PurposeDirectoryMark hint={tolling} state="differs" />);
    expect(screen.getByTestId('purpose-directory-mark').textContent).toBe(
      'справочник: Давальческий акт',
    );
    cleanup();
    render(<PurposeDirectoryMark hint={both} state="differs" />);
    expect(screen.getByTestId('purpose-directory-mark').textContent).toBe(
      'справочник: Реализация / Давальческий акт',
    );
  });

  it('нет подсказки — ничего', () => {
    const { container } = render(<PurposeDirectoryMark hint={null} state="none" />);
    expect(container.textContent).toBe('');
  });
});

describe('purposeMenuLabel', () => {
  it('пункты из справочника помечены, остальные — как есть', () => {
    render(
      <div data-testid="m">{purposeMenuLabel('tolling_act', '3 Давальческий акт', tolling)}</div>,
    );
    expect(screen.getByTestId('m').textContent).toBe('3 Давальческий акт 📒 по справочнику');
    expect(purposeMenuLabel('realization', '2 Реализация', tolling)).toBe('2 Реализация');
    expect(purposeMenuLabel('realization', '2 Реализация', null)).toBe('2 Реализация');
    cleanup();
    render(<div data-testid="b">{purposeMenuLabel('realization', '2 Реализация', both)}</div>);
    expect(screen.getByTestId('b').textContent).toBe('2 Реализация 📒 по справочнику');
  });
});
