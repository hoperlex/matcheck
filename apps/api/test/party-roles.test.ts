// Покупатель совпал с поставщиком: когда это одна организация и что с ней
// делать. Случаи — с боя (жалобы Мониторинга 23–24.10.2026).
import { describe, expect, it } from 'vitest';
import type { UpdValidation } from '@matcheck/contracts';
import {
  decideSameParty,
  innByName,
  isContractorParty,
  sameParty,
  withPartyRolesWarning,
  type PartyRoleStats,
} from '../src/domain/sourceDocuments/party-roles.js';

const IMPERIA = '9701146276';
const STROYSERVIS = '9728074050';
const MOZHAYSK = '5028021698';

function stats(p: Partial<PartyRoleStats>): PartyRoleStats {
  return {
    inn: IMPERIA,
    innSource: 'document',
    innsAgree: true,
    isOwn: false,
    isContractor: false,
    asSupplier: 0,
    asBuyerOrConsignee: 0,
    ...p,
  };
}

describe('sameParty', () => {
  it('21544: «ИМПЕРИЯ» и ООО "ИМПЕРИЯ" без ИНН — одна организация', () => {
    expect(sameParty({ name: 'ИМПЕРИЯ' }, { name: 'ООО "ИМПЕРИЯ"' })).toBe(true);
  });

  it('одинаковые валидные ИНН и имя — одна', () => {
    expect(
      sameParty(
        { name: 'СТРОЙСЕРВИС', inn: STROYSERVIS },
        { name: 'ООО «Стройсервис»', inn: STROYSERVIS },
      ),
    ).toBe(true);
  });

  it('разные валидные ИНН — разные, даже при одном имени', () => {
    expect(
      sameParty({ name: 'ООО «ИМПЕРИЯ»', inn: IMPERIA }, { name: 'ООО «ИМПЕРИЯ»', inn: MOZHAYSK }),
    ).toBe(false);
  });

  it('разные имена — разные, даже при одинаковом ИНН (это ИНН соседней стороны)', () => {
    expect(
      sameParty(
        { name: 'ТД ТУЛА-СТАЛЬ', inn: '7736255508' },
        { name: 'ООО «СУ-10»', inn: '7736255508' },
      ),
    ).toBe(false);
  });

  it('ООО и АО с одним именем — разные юрлица', () => {
    expect(sameParty({ name: 'ООО «Альфа»' }, { name: 'АО «Альфа»' })).toBe(false);
  });

  it('нет одной из сторон или имя — обрывок подписи', () => {
    expect(sameParty({ name: 'ИМПЕРИЯ' }, null)).toBe(false);
    expect(sameParty(null, { name: 'ИМПЕРИЯ' })).toBe(false);
    expect(sameParty({ name: 'он же' }, { name: 'он же' })).toBe(false);
  });
});

describe('decideSameParty', () => {
  it('ИМПЕРИЯ: поставщик 15 раз, покупатель и грузополучатель 3 — сброс покупателя', () => {
    expect(decideSameParty(stats({ asSupplier: 15, asBuyerOrConsignee: 3 }))).toEqual({
      kind: 'drop_buyer',
    });
  });

  it('ровно на порогах — сброс', () => {
    expect(decideSameParty(stats({ asSupplier: 5, asBuyerOrConsignee: 2 }))).toEqual({
      kind: 'drop_buyer',
    });
  });

  it('мало истории — пометка', () => {
    expect(decideSameParty(stats({ asSupplier: 4, asBuyerOrConsignee: 0 }))).toEqual({
      kind: 'flag',
      reason: 'history',
    });
  });

  it('СТРОЙПАРТНЕР 213 : 138 — двойная роль, пометка', () => {
    expect(decideSameParty(stats({ asSupplier: 213, asBuyerOrConsignee: 138 }))).toEqual({
      kind: 'flag',
      reason: 'history',
    });
  });

  it('подрядчик — пометка, даже если история за поставщика', () => {
    expect(
      decideSameParty(stats({ isContractor: true, asSupplier: 89, asBuyerOrConsignee: 1 })),
    ).toEqual({ kind: 'flag', reason: 'contractor' });
  });

  it('своя организация — пометка', () => {
    expect(decideSameParty(stats({ isOwn: true, asSupplier: 100 }))).toEqual({
      kind: 'flag',
      reason: 'own',
    });
  });

  it('ИНН не определён — пометка', () => {
    expect(decideSameParty(stats({ inn: null, innSource: null, asSupplier: 100 }))).toEqual({
      kind: 'flag',
      reason: 'no_inn',
    });
  });

  it('ИНН только у одной стороны — пометка: могут быть две одноимённые фирмы', () => {
    expect(decideSameParty(stats({ innsAgree: false, asSupplier: 100 }))).toEqual({
      kind: 'flag',
      reason: 'inn_disagree',
    });
  });
});

describe('innByName / isContractorParty', () => {
  const directory = [
    { name: 'ИМПЕРИЯ', aliases: [], inn: '' },
    { name: 'ООО «ИМПЕРИЯ»', aliases: [], inn: IMPERIA },
    { name: 'ООО "ГК ИМПЕРИЯ ИНСТРУМЕНТА"', aliases: [], inn: '7728388374' },
  ];

  it('единственный валидный ИНН одноимённой записи', () => {
    expect(innByName('ИМПЕРИЯ', directory)).toBe(IMPERIA);
  });

  it('два разных ИНН у одного имени — не знаем', () => {
    expect(
      innByName('ИМПЕРИЯ', [...directory, { name: 'ИМПЕРИЯ', aliases: [], inn: MOZHAYSK }]),
    ).toBeNull();
    // Имя без формы совместимо и с ООО, и с АО — тоже двусмысленно.
    expect(
      innByName('ИМПЕРИЯ', [...directory, { name: 'АО ИМПЕРИЯ', aliases: [], inn: MOZHAYSK }]),
    ).toBeNull();
  });

  it('форма в имени отсекает чужое юрлицо', () => {
    expect(
      innByName('ООО ИМПЕРИЯ', [...directory, { name: 'АО ИМПЕРИЯ', aliases: [], inn: MOZHAYSK }]),
    ).toBe(IMPERIA);
  });

  it('подрядчик по ИНН или по имени и алиасу', () => {
    const contractors = [
      { name: 'ООО "Стройсервис"', aliases: ['СТРОЙ СЕРВИС'], inn: STROYSERVIS },
    ];
    expect(isContractorParty('СТРОЙСЕРВИС', null, contractors)).toBe(true);
    expect(isContractorParty('Нечто', STROYSERVIS, contractors)).toBe(true);
    expect(isContractorParty('ИМПЕРИЯ', IMPERIA, contractors)).toBe(false);
  });
});

describe('withPartyRolesWarning', () => {
  const base: UpdValidation = { hasMismatch: false, checkedAt: '2026-10-26T00:00:00Z', checks: [] };

  it('нечего снимать и ставить — тот же объект (off — no-op)', () => {
    expect(withPartyRolesWarning(base, false)).toBe(base);
  });

  it('ставит пометку и не задваивает её', () => {
    const once = withPartyRolesWarning(base, true);
    expect(once.warnings).toEqual([{ name: 'buyer_same_as_supplier', scope: 'document' }]);
    expect(withPartyRolesWarning(once, true).warnings).toHaveLength(1);
  });

  it('снимает прежнюю, остальные предупреждения не трогает', () => {
    const v: UpdValidation = {
      ...base,
      warnings: [
        { name: 'buyer_same_as_supplier', scope: 'document' },
        { name: 'supplier_inn_unverified', scope: 'document' },
      ],
    };
    expect(withPartyRolesWarning(v, false).warnings).toEqual([
      { name: 'supplier_inn_unverified', scope: 'document' },
    ]);
  });
});
