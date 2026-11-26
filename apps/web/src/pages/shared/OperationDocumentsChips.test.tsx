// @vitest-environment jsdom
/**
 * Шапка операции с несколькими документами.
 *
 * Дефект, ради которого всё делалось: у приёмки 12586 привязаны четыре УПД, а
 * в шапке был номер одной и «Сумма: 776 240 ₽» — итог этой одной бумаги вместо
 * 2 523 656 ₽ по всем.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EdoSummary, OperationSourceDocument } from '@matcheck/contracts';
import { OperationDocumentsChips } from './OperationDocumentsChips';
import { chipText } from '../../test/chipText';

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
    expect(screen.getByText(chipText(/Сумма по документам: 2 523 656,00/))).toBeTruthy();
  });

  it('один документ — подпись «Сумма», как раньше', () => {
    render(<OperationDocumentsChips documents={[doc()]} />);

    expect(screen.getByText(chipText(/^Сумма: 747 171,00/))).toBeTruthy();
    expect(screen.getByText(chipText('Дата документа: 26.08.2026'))).toBeTruthy();
    expect(screen.getByText(chipText('Дата поставки: 28.08.2026'))).toBeTruthy();
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

    expect(
      screen.getByText(chipText('Дата документа: 26.08.2026 — 27.08.2026 · у 2 из 3')),
    ).toBeTruthy();
    // Отсутствующая сумма не считается нулём — об этом сказано прямо.
    expect(screen.getByText(/сумма указана у 2 из 3/)).toBeTruthy();
  });

  it('в списке документов по клику дата тоже дд.мм.гггг', () => {
    render(<OperationDocumentsChips documents={[doc()]} />);
    fireEvent.click(screen.getByText('0000-0082603'));
    const popover = document.querySelector<HTMLElement>('.ant-popover')!;
    expect(within(popover).getByText('26.08.2026')).toBeTruthy();
    expect(screen.queryByText('2026-08-26')).toBeNull();
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

    // Строк у документа нет — удалять нечего, галочки нет.
    expect(onUnlink).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), {
      deleteItems: false,
    });
  });

  /** Открывает окно «Отвязать документ?» у единственного документа. */
  function openUnlinkConfirm() {
    fireEvent.click(screen.getByText('0000-0082603'));
    fireEvent.click(screen.getByText('Отвязать'));
  }
  const confirmUnlink = () => fireEvent.click(screen.getAllByText('Отвязать').slice(-1)[0]!);
  const deleteCheckbox = () =>
    screen.getByRole('checkbox', {
      name: /Удалить все строки его блока \(3\)/,
    }) as HTMLInputElement;

  it('со строками в блоке галочка удаления включена, и отвязка уходит с удалением', () => {
    const onUnlink = vi.fn();
    render(
      <OperationDocumentsChips
        documents={[doc()]}
        onUnlink={onUnlink}
        itemCountByDocumentId={new Map([['d1', 3]])}
      />,
    );

    openUnlinkConfirm();
    // Подпись честно говорит, что уйдут и строки, добавленные в блок вручную.
    expect(screen.getByText(/в том числе добавленные вручную/)).toBeTruthy();
    expect(deleteCheckbox().checked).toBe(true);
    confirmUnlink();

    expect(onUnlink).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), {
      deleteItems: true,
    });
  });

  it('снятая галочка оставляет строки', () => {
    const onUnlink = vi.fn();
    render(
      <OperationDocumentsChips
        documents={[doc()]}
        onUnlink={onUnlink}
        itemCountByDocumentId={new Map([['d1', 3]])}
      />,
    );

    openUnlinkConfirm();
    fireEvent.click(deleteCheckbox());
    confirmUnlink();

    expect(onUnlink).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }), {
      deleteItems: false,
    });
  });

  it('при новом открытии галочка снова включена', () => {
    render(
      <OperationDocumentsChips
        documents={[doc()]}
        onUnlink={vi.fn()}
        itemCountByDocumentId={new Map([['d1', 3]])}
      />,
    );

    openUnlinkConfirm();
    fireEvent.click(deleteCheckbox());
    expect(deleteCheckbox().checked).toBe(false);
    fireEvent.click(screen.getByText('Отмена'));
    fireEvent.click(screen.getAllByText('Отвязать')[0]!);

    expect(deleteCheckbox().checked).toBe(true);
  });

  it('без строк в блоке галочки нет', () => {
    render(
      <OperationDocumentsChips
        documents={[doc()]}
        onUnlink={vi.fn()}
        itemCountByDocumentId={new Map([['d1', 0]])}
      />,
    );

    openUnlinkConfirm();

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Документ вернётся в список свободных.')).toBeTruthy();
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

/**
 * Шапка с УПД из ЭДО/СБИС: номер, дата и сумма — по ЭДО (edoSummary с
 * сервера). Пример — приёмка 25495: скан «22735030 / SX», в СБИС № 14622014.
 */
describe('OperationDocumentsChips — УПД из ЭДО', () => {
  const scan = doc({
    id: '00000000-0000-4000-8000-00000000000a',
    docNumber: '22735030 / SX',
    docDate: '2026-11-16',
    totalSum: '15963.82',
  });
  const summary = (over: Partial<EdoSummary> = {}): EdoSummary => ({
    documents: [
      {
        matchId: '00000000-0000-4000-8000-0000000000e1',
        source: 'export',
        documentId: '00000000-0000-4000-8000-0000000000d1',
        operator: 'sbis',
        docNumber: '14622014',
        docDate: '2026-11-16',
        totalSum: 15963.82,
        vatSum: 2878.72,
        sectionDocumentId: null,
        pairedSourceDocumentId: scan.id,
        pairedBy: 'sum_date',
        deliveryCount: 1,
        replacesFact: true,
      },
    ],
    unpairedLinkedDocumentIds: [],
    ambiguous: false,
    sharedMax: 1,
    header: {
      total: 15963.82,
      known: 1,
      count: 1,
      source: 'edo',
      comparison: { edo: 15963.82, scan: 15963.82, mismatch: false },
    },
    list: {
      exVat: 13085.1,
      vat: 2878.72,
      source: 'edo',
      edoExVat: 13085.1,
      edoVat: 2878.72,
      factExVat: null,
      factVat: null,
      edoMissing: 0,
    },
    ...over,
  });

  it('номер и сумма — из ЭДО, бумага с парой из чипов уходит', () => {
    render(<OperationDocumentsChips documents={[scan]} edoSummary={summary()} />);

    expect(screen.getByText('УПД из ЭДО:')).toBeTruthy();
    expect(screen.getByText('14622014')).toBeTruthy();
    expect(screen.queryByText('22735030 / SX')).toBeNull();
    expect(screen.getByText(chipText(/^Сумма по ЭДО: 15 963,82/))).toBeTruthy();
    expect(screen.getByText(chipText('Дата документа: 16.11.2026'))).toBeTruthy();
    // Совпало со сканом — пометки нет.
    expect(screen.queryByText(/по скану/)).toBeNull();
  });

  it('бумага остаётся в поповере с «Отвязать» по клику на чип ЭДО', () => {
    const onUnlink = vi.fn();
    render(
      <OperationDocumentsChips documents={[scan]} edoSummary={summary()} onUnlink={onUnlink} />,
    );
    fireEvent.click(screen.getByText('14622014'));
    expect(screen.getByText(/22735030 \/ SX/)).toBeTruthy();
    expect(screen.getByText('Отвязать')).toBeTruthy();
  });

  it('итог скана расходится с ЭДО — оранжевая пометка «по скану»', () => {
    render(
      <OperationDocumentsChips
        documents={[scan]}
        edoSummary={summary({
          header: {
            total: 2323906.09,
            known: 1,
            count: 1,
            source: 'edo',
            comparison: { edo: 2323906.09, scan: 156336, mismatch: true },
          },
        })}
      />,
    );
    expect(screen.getByText(chipText(/^Сумма по ЭДО: 2 323 906,09/))).toBeTruthy();
    expect(screen.getByText(/по скану 156 336,00/)).toBeTruthy();
  });

  it('только ЭДО, без скана: чипы есть, а не пусто', () => {
    render(
      <OperationDocumentsChips
        documents={[]}
        edoSummary={summary({ sharedMax: 3, header: { ...summary().header, comparison: null } })}
      />,
    );
    expect(screen.getByText('14622014')).toBeTruthy();
    expect(
      screen.getByText(chipText(/Сумма по ЭДО: 15 963,82 .* · УПД на 3 приёмки/)),
    ).toBeTruthy();
  });

  it('скан без пары остаётся в чипах, подпись — «по документам»', () => {
    const other = doc({ id: 'b', docNumber: 'ТН-7', totalSum: '100.00' });
    render(
      <OperationDocumentsChips
        documents={[scan, other]}
        edoSummary={summary({
          unpairedLinkedDocumentIds: ['b'],
          header: { total: 16063.82, known: 2, count: 2, source: 'mixed', comparison: null },
        })}
      />,
    );
    expect(screen.getByText('ТН-7')).toBeTruthy();
    expect(screen.getByText(chipText(/^Сумма по документам: 16 063,82/))).toBeTruthy();
  });
});
