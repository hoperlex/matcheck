/**
 * Раскладка архива договоров: имена, которые откроются в Windows, и пути,
 * которые не упрутся в её предел длины.
 */
import { describe, expect, it } from 'vitest';
import {
  ANNULLED_DIR,
  NAME_LIMITS,
  computeLayout,
  fitFileName,
  moscowDay,
  safeSegment,
  signatureFileName,
  splitExt,
} from '../src/domain/edo/contracts/layout.js';
import type { InventorySnapshot, SnapshotRow } from '../src/domain/edo/contracts/snapshot.js';

function row(n: number, extra: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    row: n,
    messageId: `m${n}`,
    entityId: `e${n}`,
    direction: 'inbound',
    typeNamedId: 'Nonformalized',
    fileName: 'Договор поставки.pdf',
    number: null,
    date: null,
    at: '2024-03-01T09:00:00.000Z',
    counteragentBoxId: 'box-a',
    packetId: null,
    docflowText: null,
    recipientResponse: null,
    revocation: null,
    category: 'contract',
    nameCategory: 'contract',
    selection: 'auto',
    reason: '',
    contractRef: null,
    packageVia: null,
    needRecipientSignature: null,
    inventorySignatures: null,
    ...extra,
  };
}

function snapshot(rows: SnapshotRow[], counterparties: InventorySnapshot['counterparties']): InventorySnapshot {
  return { counterparties, rows } as unknown as InventorySnapshot;
}

describe('безопасные имена', () => {
  it('запрещённые символы, точки и пробелы по краям', () => {
    expect(safeSegment('ООО "Ромашка": ДС 1/2 ?', 60)).toBe('ООО _Ромашка__ ДС 1_2 _');
    expect(safeSegment('  Договор.  ', 60)).toBe('Договор');
    expect(safeSegment('...', 60)).toBe('_');
    expect(safeSegment('ДС\u0001№1\u001f', 60)).toBe('ДС_№1_');
  });

  it('зарезервированные имена Windows', () => {
    expect(safeSegment('CON', 10)).toBe('_CON');
    expect(safeSegment('nul.txt', 10)).toBe('_nul.txt');
  });

  it('длина считается в символах, кириллица не рвётся', () => {
    const s = safeSegment('Ж'.repeat(100), 20);
    expect(Array.from(s)).toHaveLength(20);
  });

  it('имя файла режется по основе, хвост сохраняется', () => {
    const name = fitFileName('Д'.repeat(200), '.pdf');
    expect(name.endsWith('.pdf')).toBe(true);
    expect(Array.from(name).length).toBeLessThanOrEqual(NAME_LIMITS.file);
    expect(signatureFileName('Договор', 'recipient', 1)).toBe('Договор — подпись получателя.sig');
    expect(signatureFileName('Договор', 'sender', 2)).toBe('Договор — подпись отправителя 2.sig');
    expect(signatureFileName('Договор', 'approvement', 1)).toBe('Договор — согласующая подпись.sig');
  });

  it('расширение', () => {
    expect(splitExt('Дополнительное соглашение № 1.docx.pdf')).toEqual({ stem: 'Дополнительное соглашение № 1.docx', ext: '.pdf' });
    expect(splitExt('без расширения')).toEqual({ stem: 'без расширения', ext: null });
  });

  it('дата по Москве', () => {
    expect(moscowDay('2024-03-01T22:30:00.000Z')).toBe('2024-03-02');
    expect(moscowDay(null)).toBe('без даты');
  });
});

describe('раскладка', () => {
  const cps = [
    { boxId: 'box-a', inn: '7700000001', kpp: null, name: 'ООО "Альфа"', source: 'organization' as const },
    { boxId: 'box-b', inn: null, kpp: null, name: null, source: 'unknown' as const },
  ];

  it('папка контрагента с ИНН, папка документа с датой и категорией', () => {
    const layout = computeLayout(snapshot([row(1)], cps), [row(1)]);
    expect(layout.get(1)!.dir).toBe('files/ООО _Альфа_ (7700000001)/2024-03-01 договор Договор поставки');
    expect(layout.get(1)!.ext).toBe('.pdf');
  });

  it('одинаковые имена разводятся суффиксом без учёта регистра', () => {
    const rows = [row(1), row(2, { fileName: 'ДОГОВОР ПОСТАВКИ.pdf' })];
    const layout = computeLayout(snapshot(rows, cps), rows);
    expect(layout.get(1)!.dir.endsWith('Договор поставки')).toBe(true);
    expect(layout.get(2)!.dir.endsWith('(2)')).toBe(true);
  });

  it('аннулированные и отклонённые — в отдельной папке', () => {
    const rows = [
      row(1, { revocation: 'RevocationAccepted' }),
      row(2, { recipientResponse: 'RecipientSignatureRequestRejected' }),
      row(3),
    ];
    const layout = computeLayout(snapshot(rows, cps), rows);
    expect(layout.get(1)!.dir).toContain(`/${ANNULLED_DIR}/`);
    expect(layout.get(2)!.dir).toContain(`/${ANNULLED_DIR}/`);
    expect(layout.get(3)!.dir).not.toContain(ANNULLED_DIR);
  });

  it('контрагент без реквизитов — по ящику; путь не длиннее ~200 знаков', () => {
    const long = row(1, { counteragentBoxId: 'box-b', fileName: `${'Очень длинное имя договора '.repeat(10)}.pdf`, revocation: 'RevocationAccepted' });
    const layout = computeLayout(snapshot([long], cps), [long]);
    const place = layout.get(1)!;
    expect(place.dir).toContain('Без названия box-b');
    const full = `${place.dir}/${signatureFileName(place.stem, 'recipient', 2)}`;
    expect(Array.from(full).length).toBeLessThanOrEqual(205);
  });

  it('раскладка детерминирована: тот же снимок — те же папки', () => {
    const rows = [row(3), row(1), row(2, { fileName: 'договор поставки.pdf' })];
    const a = computeLayout(snapshot(rows, cps), rows);
    const b = computeLayout(snapshot([...rows].reverse(), cps), [...rows].reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});
