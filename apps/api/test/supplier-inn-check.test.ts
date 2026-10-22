import { describe, expect, it } from 'vitest';
import type { UpdValidation } from '@matcheck/contracts';
import {
  resolveSupplierInn,
  supplierInnForDocument,
  supplierInnValidation,
  withSupplierInnWarning,
  type DirectoryInn,
  type EdoRegistryEntry,
  type SupplierInnInput,
} from '../src/domain/sourceDocuments/supplier-inn-check.js';

// Корректные ИНН (контрольная сумма сходится) — пары с боя.
const ELTEH = '7842224734';
const PROZASK = '7718745757';
const LENINERT = '7816583913';
const ALT_SPB = '5406354183';
const ALT_MSK = '7726354186';
const OWN = '7701363118';
const VALID_MISREAD = '7708535165';
const VALID_TRUE = '7708353165';

function input(p: Partial<SupplierInnInput>): SupplierInnInput {
  return {
    raw: null,
    name: null,
    docNumber: null,
    totalSum: null,
    directory: [],
    edo: [],
    ownInns: new Set([OWN]),
    ...p,
  };
}

const dir = (inn: string, ...names: string[]): DirectoryInn => ({ inn, names });

function edo(p: Partial<EdoRegistryEntry>): EdoRegistryEntry {
  return {
    number: 'УТ-4211',
    supplierInn: null,
    sellerInns: [],
    supplierName: null,
    totalSum: 1200.5,
    ...p,
  };
}

describe('resolveSupplierInn — ветки', () => {
  it('пустой ИНН и ИНН без цифр — absent, решает прежний поиск по имени', () => {
    expect(resolveSupplierInn(input({ raw: null, name: 'ООО "А"' }))).toEqual({
      decision: 'absent',
      raw: null,
      inn: null,
    });
    expect(resolveSupplierInn(input({ raw: 'нет' })).decision).toBe('absent');
  });

  it('корректный ИНН — valid, справочник не нужен', () => {
    expect(resolveSupplierInn(input({ raw: ELTEH }))).toEqual({
      decision: 'valid',
      raw: ELTEH,
      inn: ELTEH,
    });
  });

  it('корректный после очистки — normalized', () => {
    expect(resolveSupplierInn(input({ raw: `ИНН ${ELTEH}` }))).toMatchObject({
      decision: 'normalized',
      inn: ELTEH,
    });
    expect(resolveSupplierInn(input({ raw: '7722466153,' }))).toMatchObject({
      decision: 'normalized',
      inn: '7722466153',
    });
  });

  it('свой ИНН (СУ-10 прочитана в графе продавца) — unverified', () => {
    expect(resolveSupplierInn(input({ raw: OWN, name: 'ООО «СУ-10»' }))).toEqual({
      decision: 'unverified',
      raw: OWN,
      inn: null,
      reason: 'own_inn',
    });
  });

  it('битый, в справочнике тот же поставщик с ИНН в одной цифре — corrected по справочнику', () => {
    const r = resolveSupplierInn(
      input({
        raw: '784224734',
        name: 'АО "ТД "Электротехмонтаж"',
        directory: [dir(ELTEH, 'АО "ТД "ЭЛЕКТРОТЕХМОНТАЖ"')],
      }),
    );
    expect(r).toEqual({
      decision: 'corrected',
      raw: '784224734',
      inn: ELTEH,
      source: 'directory',
      reason: 'length',
    });
  });

  it('совпадение по алиасу записи тоже считается', () => {
    const r = resolveSupplierInn(
      input({
        raw: '7842224735',
        name: 'ТД Электротехмонтаж',
        directory: [dir(ELTEH, 'АО «ТД»', 'ТД Электротехмонтаж')],
      }),
    );
    expect(r).toMatchObject({
      decision: 'corrected',
      inn: ELTEH,
      source: 'directory',
      reason: 'checksum',
    });
  });

  it('битый, единственный одноимённый ИНН в двух цифрах — corrected по имени', () => {
    const r = resolveSupplierInn(
      input({
        raw: '7718475777',
        name: 'ООО "ПРОЗАСК"',
        directory: [dir(PROZASK, 'ООО «Прозаск»')],
      }),
    );
    expect(r).toMatchObject({ decision: 'corrected', inn: PROZASK, source: 'directory_name' });
    // «ЛЕНИНЕРТ» с боя: две перестановки — тоже по имени.
    expect(
      resolveSupplierInn(
        input({
          raw: '7816658393',
          name: 'ООО «ЛЕНИНЕРТ»',
          directory: [dir(LENINERT, 'ООО  "ЛЕНИНЕРТ"')],
        }),
      ),
    ).toMatchObject({ decision: 'corrected', inn: LENINERT, source: 'directory_name' });
  });

  it('битый, единственный одноимённый ИНН дальше двух цифр — unverified с привязкой по имени', () => {
    const r = resolveSupplierInn(
      input({
        raw: '7816000000',
        name: 'ООО «ЛЕНИНЕРТ»',
        directory: [dir(LENINERT, 'ООО  "ЛЕНИНЕРТ"')],
      }),
    );
    expect(r).toEqual({
      decision: 'unverified',
      raw: '7816000000',
      inn: null,
      reason: 'checksum',
      linkInn: LENINERT,
    });
  });

  it('битый, одноимённых организаций несколько — unverified без привязки, кандидаты в следе', () => {
    const r = resolveSupplierInn(
      input({
        raw: '7726354184',
        name: 'ООО «Альтернатива»',
        directory: [dir(ALT_SPB, 'ООО "АЛЬТЕРНАТИВА"'), dir(ALT_MSK, 'ООО «Альтернатива»')],
      }),
    );
    // Один из кандидатов в одной цифре — значит, однозначен.
    expect(r).toMatchObject({ decision: 'corrected', inn: ALT_MSK, source: 'directory' });

    const far = resolveSupplierInn(
      input({
        raw: '1111111111',
        name: 'ООО «Альтернатива»',
        directory: [dir(ALT_SPB, 'ООО "АЛЬТЕРНАТИВА"'), dir(ALT_MSK, 'ООО «Альтернатива»')],
      }),
    );
    expect(far).toEqual({
      decision: 'unverified',
      raw: '1111111111',
      inn: null,
      reason: 'checksum',
      candidates: [ALT_SPB, ALT_MSK].sort(),
    });
  });

  it('разные формы собственности — не одна организация', () => {
    const r = resolveSupplierInn(
      input({
        raw: '784224734',
        name: 'ООО "ТД Электротехмонтаж"',
        directory: [dir(ELTEH, 'АО "ТД "ЭЛЕКТРОТЕХМОНТАЖ"')],
      }),
    );
    expect(r).toMatchObject({ decision: 'unverified', reason: 'length' });
    expect(r.linkInn).toBeUndefined();
  });

  it('КПП вместо ИНН и нет одноимённых — unverified без привязки', () => {
    expect(resolveSupplierInn(input({ raw: '770201001', name: 'ООО МИКРОКЛИМАТ' }))).toEqual({
      decision: 'unverified',
      raw: '770201001',
      inn: null,
      reason: 'length',
    });
  });

  it('свой ИНН в справочнике не кандидат', () => {
    const r = resolveSupplierInn(
      input({ raw: '7701363111', name: 'ООО «СУ-10»', directory: [dir(OWN, 'ООО «СУ-10»')] }),
    );
    expect(r).toMatchObject({ decision: 'unverified' });
    expect(r.linkInn).toBeUndefined();
  });
});

describe('resolveSupplierInn — реестр ЭДО', () => {
  const doc = { docNumber: 'УТ-4211', totalSum: 1200.5 };

  it('корректный ИНН, прошедший контрольную сумму по ошибке, исправляется по ЭДО', () => {
    const r = resolveSupplierInn(
      input({
        raw: VALID_MISREAD,
        ...doc,
        edo: [edo({ supplierInn: VALID_TRUE, sellerInns: [VALID_TRUE] })],
      }),
    );
    expect(r).toEqual({
      decision: 'corrected',
      raw: VALID_MISREAD,
      inn: VALID_TRUE,
      source: 'edo',
    });
  });

  it('битый ИНН исправляется по ЭДО раньше справочника', () => {
    const r = resolveSupplierInn(
      input({
        raw: '784224734',
        name: 'ТД Электротехмонтаж',
        ...doc,
        edo: [edo({ supplierInn: ELTEH })],
        directory: [dir(ELTEH, 'ТД Электротехмонтаж')],
      }),
    );
    expect(r).toMatchObject({ decision: 'corrected', inn: ELTEH, source: 'edo' });
  });

  it('битый ИНН далеко от ЭДО — подмена только при совпадении имени', () => {
    const base = { raw: '1111111111', name: 'ООО «Прозаск»', ...doc };
    expect(
      resolveSupplierInn(input({ ...base, edo: [edo({ supplierInn: PROZASK })] })).decision,
    ).toBe('unverified');
    expect(
      resolveSupplierInn(
        input({ ...base, edo: [edo({ supplierInn: PROZASK, supplierName: 'ООО "ПРОЗАСК"' })] }),
      ),
    ).toMatchObject({ decision: 'corrected', inn: PROZASK, source: 'edo' });
  });

  it('корректный ИНН далеко от ЭДО не подменяется — это другой документ с тем же номером', () => {
    const r = resolveSupplierInn(
      input({ raw: ELTEH, ...doc, edo: [edo({ supplierInn: PROZASK, supplierName: 'X' })] }),
    );
    expect(r.decision).toBe('valid');
  });

  it('ЭДО не используется: короткий номер, другая сумма, нет суммы, свой ИНН, два продавца', () => {
    const misread = { raw: VALID_MISREAD };
    const one = edo({ supplierInn: VALID_TRUE });
    expect(
      resolveSupplierInn(
        input({ ...misread, docNumber: '105', totalSum: 1200.5, edo: [{ ...one, number: '105' }] }),
      ).decision,
    ).toBe('valid');
    expect(
      resolveSupplierInn(input({ ...misread, ...doc, edo: [{ ...one, totalSum: 1300 }] })).decision,
    ).toBe('valid');
    expect(
      resolveSupplierInn(
        input({ ...misread, docNumber: doc.docNumber, totalSum: null, edo: [one] }),
      ).decision,
    ).toBe('valid');
    expect(
      resolveSupplierInn(input({ ...misread, ...doc, edo: [edo({ supplierInn: OWN })] })).decision,
    ).toBe('valid');
    expect(
      resolveSupplierInn(input({ ...misread, ...doc, edo: [one, edo({ supplierInn: ELTEH })] }))
        .decision,
    ).toBe('valid');
  });

  it('номер сравнивается без разделителей и ведущих символов-двойников', () => {
    const r = resolveSupplierInn(
      input({
        raw: VALID_MISREAD,
        docNumber: 'УТ 4211',
        totalSum: 1200.5,
        edo: [edo({ number: 'УТ-4211', supplierInn: VALID_TRUE })],
      }),
    );
    expect(r.decision).toBe('corrected');
  });
});

describe('ИНН документа и предупреждение', () => {
  it('в supplier_inn_raw — итоговый ИНН у исправленного и очищенного, сырой у остальных', () => {
    expect(
      supplierInnForDocument({ decision: 'corrected', raw: '784224734', inn: ELTEH }, '784224734'),
    ).toBe(ELTEH);
    expect(
      supplierInnForDocument(
        { decision: 'normalized', raw: `ИНН ${ELTEH}`, inn: ELTEH },
        `ИНН ${ELTEH}`,
      ),
    ).toBe(ELTEH);
    expect(
      supplierInnForDocument(
        { decision: 'unverified', raw: '770201001', inn: null, reason: 'length' },
        '770201001',
      ),
    ).toBe('770201001');
  });

  const base: UpdValidation = {
    hasMismatch: false,
    checkedAt: '2026-10-22T00:00:00.000Z',
    checks: [],
    warnings: [{ name: 'dropped_pages_not_parsed', scope: 'document', details: { pages: [3] } }],
  };
  const unverified = {
    decision: 'unverified' as const,
    raw: '770201001',
    inn: null,
    reason: 'length' as const,
  };

  it('непроверенный ИНН ставит одно предупреждение, повтор не дублирует', () => {
    const once = withSupplierInnWarning(base, unverified);
    const twice = withSupplierInnWarning(once, unverified);
    expect(twice.warnings).toEqual([
      base.warnings![0],
      { name: 'supplier_inn_unverified', scope: 'document' },
    ]);
  });

  it('верный ИНН снимает прежнее предупреждение, без предупреждения — тот же объект', () => {
    const marked = withSupplierInnWarning(base, unverified);
    expect(
      withSupplierInnWarning(marked, { decision: 'valid', raw: ELTEH, inn: ELTEH }).warnings,
    ).toEqual(base.warnings);
    expect(withSupplierInnWarning(base, null)).toBe(base);
  });

  it('у накладной без сверки validation появляется только ради предупреждения', () => {
    expect(supplierInnValidation(null, null)).toBeNull();
    expect(
      supplierInnValidation(null, { decision: 'corrected', raw: '784224734', inn: ELTEH }),
    ).toBeNull();
    expect(supplierInnValidation(null, unverified)).toMatchObject({
      hasMismatch: false,
      checks: [],
      warnings: [{ name: 'supplier_inn_unverified', scope: 'document' }],
    });
  });
});
