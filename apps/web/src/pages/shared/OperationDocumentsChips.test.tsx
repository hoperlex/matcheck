// @vitest-environment jsdom
/**
 * Шапка операции с несколькими документами.
 *
 * Дефект, ради которого всё делалось: у приёмки 12586 привязаны четыре УПД, а
 * в шапке был номер одной и «Сумма: 776 240 ₽» — итог этой одной бумаги вместо
 * 2 523 656 ₽ по всем.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationSourceDocument } from '@matcheck/contracts';
import { OperationDocumentsChips } from './OperationDocumentsChips';

const doc = (over: Partial<OperationSourceDocument> = {}): OperationSourceDocument => ({
  id: 'd1',
  kind: 'upd',
  status: 'parsed',
  docNumber: '0000-0082603',
  docDate: '2026-08-26',
  expectedDate: '2026-08-28',
  totalSum: '747171.00',
  vatSum: null,
  linked: true,
  ...over,
});

const fourUpd = [
  doc({ id: 'a', docNumber: '0000-0082603', totalSum: '747171.00' }),
  doc({ id: 'b', docNumber: '0000-0082604', totalSum: '865655.00' }),
  doc({ id: 'c', docNumber: '0000-0082605', totalSum: '776240.00' }),
  doc({ id: 'd', docNumber: '0000-0082607', totalSum: '134590.00' }),
];

afterEach(cleanup);

describe('OperationDocumentsChips', () => {
  it('перечисляет номера и складывает суммы всех документов', () => {
    render(<OperationDocumentsChips documents={fourUpd} />);

    expect(screen.getByText(/0000-0082603, 0000-0082604, 0000-0082605/)).toBeTruthy();
    // Четвёртый номер свёрнут в «+1», полный список — в поповере по клику.
    expect(screen.getByText(/\+1/)).toBeTruthy();
    expect(screen.getByText(/Сумма по документам: 2 523 656,00/)).toBeTruthy();
  });

  it('один документ — подпись «Сумма», как раньше', () => {
    render(<OperationDocumentsChips documents={[doc()]} />);

    expect(screen.getByText(/^Сумма: 747 171,00/)).toBeTruthy();
    expect(screen.getByText('Дата документа: 2026-08-26')).toBeTruthy();
    expect(screen.getByText('Дата поставки: 2026-08-28')).toBeTruthy();
  });

  it('разные даты дают диапазон, а неполные — честную приписку', () => {
    render(
      <OperationDocumentsChips
        documents={[
          doc({ id: 'a', docDate: '2026-08-26' }),
          doc({ id: 'b', docDate: '2026-08-27' }),
          doc({ id: 'c', docDate: null, totalSum: null }),
        ]}
      />,
    );

    expect(screen.getByText('Дата документа: 2026-08-26 — 2026-08-27 · у 2 из 3')).toBeTruthy();
    // Отсутствующая сумма не считается нулём — об этом сказано прямо.
    expect(screen.getByText(/сумма указана у 2 из 3/)).toBeTruthy();
  });

  it('накладная подписана накладной, а не УПД', () => {
    render(
      <OperationDocumentsChips
        documents={[
          doc({ id: 'a' }),
          doc({ id: 'b', kind: 'transport_waybill', docNumber: 'ТН-7' }),
        ]}
      />,
    );

    expect(screen.getByText('УПД:')).toBeTruthy();
    expect(screen.getByText('Накладная:')).toBeTruthy();
  });

  it('«Отвязать» доступна из списка и зовёт обработчик', () => {
    const onUnlink = vi.fn();
    render(<OperationDocumentsChips documents={[doc()]} onUnlink={onUnlink} />);

    fireEvent.click(screen.getByText('0000-0082603'));
    fireEvent.click(screen.getByText('Отвязать'));
    // Popconfirm: подтверждение обязательно — отвязка меняет смысл всех строк.
    fireEvent.click(screen.getAllByText('Отвязать').slice(-1)[0]!);

    expect(onUnlink).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
  });

  it('без права отвязки кнопки нет', () => {
    render(<OperationDocumentsChips documents={[doc()]} />);

    fireEvent.click(screen.getByText('0000-0082603'));
    expect(screen.queryByText('Отвязать')).toBeNull();
  });

  it('номер открывает оригинал — именно свой, а не соседний', () => {
    const onOpenOriginal = vi.fn();
    render(
      <OperationDocumentsChips
        documents={[
          doc({ id: 'a', docNumber: '0000-0082603' }),
          doc({ id: 'b', docNumber: '0000-0082604' }),
        ]}
        onOpenOriginal={onOpenOriginal}
      />,
    );

    fireEvent.click(screen.getByText(/0000-0082603, 0000-0082604/));
    fireEvent.click(screen.getByText('УПД 0000-0082604'));

    expect(onOpenOriginal).toHaveBeenCalledTimes(1);
    expect(onOpenOriginal).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('клик по номеру закрывает поповер — иначе он повиснет поверх окна просмотра', () => {
    render(<OperationDocumentsChips documents={[doc()]} onOpenOriginal={vi.fn()} />);

    fireEvent.click(screen.getByText('0000-0082603'));
    expect(document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')).toHaveLength(1);

    fireEvent.click(screen.getByText('УПД 0000-0082603'));

    expect(document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')).toHaveLength(0);
  });

  it('без обработчика номер остаётся текстом, а не ссылкой', () => {
    render(<OperationDocumentsChips documents={[doc()]} />);

    fireEvent.click(screen.getByText('0000-0082603'));

    const row = screen.getByText('УПД 0000-0082603');
    expect(row.closest('a')).toBeNull();
  });

  it('«Отвязать» не открывает оригинал — у разрушительного действия свой клик', () => {
    const onOpenOriginal = vi.fn();
    const onUnlink = vi.fn();
    render(
      <OperationDocumentsChips
        documents={[doc()]}
        onUnlink={onUnlink}
        onOpenOriginal={onOpenOriginal}
      />,
    );

    fireEvent.click(screen.getByText('0000-0082603'));
    fireEvent.click(screen.getByText('Отвязать'));
    fireEvent.click(screen.getAllByText('Отвязать').slice(-1)[0]!);

    expect(onUnlink).toHaveBeenCalledTimes(1);
    expect(onOpenOriginal).not.toHaveBeenCalled();
  });

  it('у документа без номера кликается подпись целиком', () => {
    const onOpenOriginal = vi.fn();
    render(
      <OperationDocumentsChips
        documents={[doc({ id: 'w', kind: 'transport_waybill', docNumber: null })]}
        onOpenOriginal={onOpenOriginal}
      />,
    );

    fireEvent.click(screen.getByText('— без номера —'));
    fireEvent.click(screen.getByText('Накладная — без номера —'));

    expect(onOpenOriginal).toHaveBeenCalledWith(expect.objectContaining({ id: 'w' }));
  });

  it('поповеры разных видов документов не раскрываются разом', () => {
    render(
      <OperationDocumentsChips
        documents={[
          doc({ id: 'a' }),
          doc({ id: 'b', kind: 'transport_waybill', docNumber: 'ТН-7' }),
        ]}
        onOpenOriginal={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('ТН-7'));

    // Один раскрытый поповер, а не два: состояние хранится на группу.
    expect(document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')).toHaveLength(1);
  });
});
