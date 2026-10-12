import { describe, expect, it } from 'vitest';
import { diffPatchBody, finalizePartyPayloads, partyPayload } from './sourceDocumentPatchBody';

/** Тело «как открыли» — так его собирает buildPatchBody карточки. */
const pristine = {
  docNumber: 'ТР-12296',
  docDate: '2026-08-25',
  expectedDate: '2026-08-26',
  recipientMolId: null,
  siteId: '44444444-4444-4444-4444-444444444444',
  totalSum: '60263.00',
  buyer: { name: 'ООО "СУ-10"', inn: '7736255508' },
  consignee: null,
  items: [
    { nameRaw: 'Труба', qty: '1.000', unit: 'шт', price: '240', sum: '292.80', vatRate: '22' },
    { nameRaw: 'Муфта', qty: '2', unit: 'шт', price: '66.294', sum: null, vatRate: null },
  ],
};

const clone = () => structuredClone(pristine) as Record<string, unknown> & typeof pristine;

describe('diffPatchBody', () => {
  it('нетронутая форма — пустое тело', () => {
    expect(diffPatchBody(clone(), pristine)).toEqual({});
  });

  it.each([
    ['docNumber', 'ТР-12297'],
    ['docDate', '2026-08-24'],
    ['expectedDate', null],
    ['recipientMolId', '66666666-6666-6666-6666-666666666666'],
    ['siteId', '77777777-7777-7777-7777-777777777777'],
    ['totalSum', '60264'],
    ['consignee', { name: 'ООО «ЭСТ»', inn: '7714679380' }],
    ['buyer', null],
  ])('правка %s — в теле ровно этот ключ', (key, value) => {
    const current = clone();
    (current as Record<string, unknown>)[key] = value;
    expect(diffPatchBody(current, pristine)).toEqual({ [key]: value });
  });

  it('blur без правки: число в другом виде — не изменение', () => {
    // InputNumber отдаёт String(60263) вместо '60263.00' и 1 вместо '1.000'.
    const current = clone();
    current.totalSum = '60263';
    current.items[0]!.qty = '1';
    expect(diffPatchBody(current, pristine)).toEqual({});
  });

  it('пустая строка и null у поля — одно «пусто»', () => {
    const current = clone();
    (current as Record<string, unknown>).recipientMolId = '';
    expect(diffPatchBody(current, pristine)).toEqual({});
  });

  it('правка одной позиции отдаёт весь список, остальные строки — как были', () => {
    const current = clone();
    current.items[0]!.nameRaw = 'Труба 32';
    const diff = diffPatchBody(current, pristine);
    expect(Object.keys(diff)).toEqual(['items']);
    // Сервер заменяет строки целиком: вторая строка обязана уйти с исходной
    // ценой бланка, иначе её цена или ставка пропали бы.
    expect(diff.items).toEqual([
      { ...pristine.items[0], nameRaw: 'Труба 32' },
      pristine.items[1],
    ]);
  });

  it('удалённая или добавленная строка — изменение списка', () => {
    const current = clone();
    current.items.pop();
    expect(Object.keys(diffPatchBody(current, pristine))).toEqual(['items']);
  });

  it('сторона: пробелы по краям имени и форма записи ИНН — не изменение', () => {
    const current = clone();
    current.buyer = { name: '  ООО "СУ-10" ', inn: '77 36-255508' };
    expect(diffPatchBody(current, pristine)).toEqual({});
  });

  it('сторона: другой ИНН при том же имени — изменение', () => {
    const current = clone();
    current.buyer = { name: 'ООО "СУ-10"', inn: '7736255087' };
    expect(Object.keys(diffPatchBody(current, pristine))).toEqual(['buyer']);
  });
});

describe('partyPayload', () => {
  it('убирает служебный source и пустой ИНН', () => {
    expect(partyPayload({ name: ' СУ-10 ', inn: '  ', source: 'manual' })).toEqual({
      name: 'СУ-10',
      inn: null,
    });
    expect(partyPayload(null)).toBeNull();
  });
});

describe('finalizePartyPayloads', () => {
  it('ИНН изменённой стороны уходит цифрами', () => {
    const body: Record<string, unknown> = { consignee: { name: 'СУ-10', inn: '77 36-255508' } };
    expect(finalizePartyPayloads(body)).toBeNull();
    expect(body).toEqual({ consignee: { name: 'СУ-10', inn: '7736255508' } });
  });

  it('битый ИНН — сторона названа, тело не отправляется', () => {
    const body: Record<string, unknown> = {
      buyer: { name: 'СУ-10', inn: '7736255508' },
      consignee: { name: 'Стройуправление', inn: '7736255087' },
    };
    expect(finalizePartyPayloads(body)).toBe('consignee');
  });

  it('нетронутая сторона не проверяется: в теле её нет', () => {
    const body: Record<string, unknown> = { docNumber: '1' };
    expect(finalizePartyPayloads(body)).toBeNull();
    expect(body).toEqual({ docNumber: '1' });
  });

  it('очистка и сторона без ИНН проходят как есть', () => {
    const body: Record<string, unknown> = { buyer: null, consignee: { name: 'ЭСТ', inn: null } };
    expect(finalizePartyPayloads(body)).toBeNull();
    expect(body).toEqual({ buyer: null, consignee: { name: 'ЭСТ', inn: null } });
  });
});
