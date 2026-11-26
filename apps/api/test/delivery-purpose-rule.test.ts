/**
 * Правило «признак следует за получателем» — полный перебор.
 * Справочник «Объекты и вид» (0161): события подстановки, ручной выбор
 * не трогается, подставленный следует за парой — тоже перебором.
 *
 * Одна функция в контракте, её зовут и сервер (под блокировкой строки), и
 * карточка (подсказка до «Сохранить»). Перебор держит инвариант: после записи
 * получателя признак всегда допустим для него.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedDeliveryPurposes,
  DeliveryPurposeSchema,
  deliveryPurposeNeedsDirectory,
  deliveryRecipientKind,
  directoryPurposeHint,
  nextDeliveryPurpose,
  reconcileDeliveryPurpose,
  type DeliveryPurpose,
  type DeliveryPurposeWrite,
  type DeliveryRecipientKind,
} from '@matcheck/contracts';
import { detachDirectoryPurpose } from '../src/domain/operations/delivery-purpose.js';

const KINDS: DeliveryRecipientKind[] = [null, 'contractor', 'mol'];
const PURPOSES: (DeliveryPurpose | null)[] = [null, ...DeliveryPurposeSchema.options];

describe('allowedDeliveryPurposes', () => {
  it('у подрядчика нет «Свои силы», при МОЛ и без получателя — все пять', () => {
    expect(allowedDeliveryPurposes('contractor')).toEqual([
      'realization',
      'tolling_act',
      'contractor_materials',
      'realization_tolling',
    ]);
    expect(allowedDeliveryPurposes('mol')).toHaveLength(5);
    expect(allowedDeliveryPurposes(null)).toHaveLength(5);
  });
});

describe('deliveryRecipientKind', () => {
  it('МОЛ важнее подрядчика (как у планшета), пусто — никто', () => {
    expect(deliveryRecipientKind({ contractorId: 'c', recipientMolId: 'm' })).toBe('mol');
    expect(deliveryRecipientKind({ contractorId: 'c', recipientMolId: null })).toBe('contractor');
    expect(deliveryRecipientKind({ contractorId: null, recipientMolId: null })).toBeNull();
  });
});

describe('reconcileDeliveryPurpose — перебор', () => {
  for (const prev of KINDS) {
    for (const next of KINDS) {
      for (const purpose of PURPOSES) {
        it(`${prev ?? 'никто'} → ${next ?? 'никто'}, признак ${purpose ?? '—'}`, () => {
          const out = reconcileDeliveryPurpose(prev, next, purpose);
          // Инвариант: результат допустим для нового получателя.
          if (out !== null) expect(allowedDeliveryPurposes(next)).toContain(out);
          if (next === 'mol' && prev !== 'mol') {
            expect(out).toBe('own_forces');
          } else if (next === 'contractor' && purpose === 'own_forces') {
            expect(out).toBeNull();
          } else {
            // Во всех прочих случаях ручной выбор не трогается.
            expect(out).toBe(purpose);
          }
        });
      }
    }
  }
});

// ─── справочник «Объекты и вид» (0161) ───────────────────────────────────

describe('directoryPurposeHint', () => {
  it('однозначный вид — ставится и подсвечивается; «оба» — только подсветка; нет пары — ничего', () => {
    expect(directoryPurposeHint('realization')).toEqual({
      auto: 'realization',
      highlight: ['realization'],
    });
    expect(directoryPurposeHint('tolling_act')).toEqual({
      auto: 'tolling_act',
      highlight: ['tolling_act'],
    });
    expect(directoryPurposeHint('contractor_materials')).toEqual({
      auto: 'contractor_materials',
      highlight: ['contractor_materials'],
    });
    expect(directoryPurposeHint('realization_tolling')).toEqual({
      auto: null,
      highlight: ['realization', 'tolling_act'],
    });
    expect(directoryPurposeHint(null)).toEqual({ auto: null, highlight: [] });
  });
});

describe('nextDeliveryPurpose — случаи', () => {
  const base: DeliveryPurposeWrite = {
    prevKind: 'contractor',
    nextKind: 'contractor',
    purpose: null,
    fromDirectory: false,
    insert: false,
    pairChanged: false,
    firstConfirm: false,
    directoryAllowed: true,
    nextAuto: 'tolling_act',
  };
  const run = (over: Partial<DeliveryPurposeWrite>) => nextDeliveryPurpose({ ...base, ...over });

  it('создание приёмки подрядчика: пустой признак — по справочнику', () => {
    expect(run({ prevKind: null, insert: true })).toEqual({
      purpose: 'tolling_act',
      fromDirectory: true,
    });
  });

  it('событий нет (комментарий, повторная синхронизация планшета) — пустой остаётся пустым', () => {
    expect(run({})).toEqual({ purpose: null, fromDirectory: false });
  });

  it('первое подтверждение и фактическая смена пары заполняют пустой', () => {
    expect(run({ firstConfirm: true })).toEqual({ purpose: 'tolling_act', fromDirectory: true });
    expect(run({ pairChanged: true })).toEqual({ purpose: 'tolling_act', fromDirectory: true });
  });

  it('ручной признак, даже равный справочнику, переживает смену пары', () => {
    expect(run({ purpose: 'realization', pairChanged: true, nextAuto: 'tolling_act' })).toEqual({
      purpose: 'realization',
      fromDirectory: false,
    });
    expect(
      run({ purpose: 'tolling_act', pairChanged: true, nextAuto: 'contractor_materials' }),
    ).toEqual({ purpose: 'tolling_act', fromDirectory: false });
  });

  it('подставленный следует за парой; нет однозначного вида — сбрасывается', () => {
    const auto = { purpose: 'realization' as const, fromDirectory: true, pairChanged: true };
    expect(run({ ...auto, nextAuto: 'tolling_act' })).toEqual({
      purpose: 'tolling_act',
      fromDirectory: true,
    });
    expect(run({ ...auto, nextAuto: null })).toEqual({ purpose: null, fromDirectory: false });
    // Получатель стал МОЛ — правило МОЛ, признак уже ручной по правилу.
    expect(run({ ...auto, nextKind: 'mol' })).toEqual({
      purpose: 'own_forces',
      fromDirectory: false,
    });
    // Получателя не стало — подстановке не на что опираться.
    expect(run({ ...auto, nextKind: null })).toEqual({ purpose: null, fromDirectory: false });
  });

  it('подставленный без событий остаётся подставленным', () => {
    expect(run({ purpose: 'realization', fromDirectory: true })).toEqual({
      purpose: 'realization',
      fromDirectory: true,
    });
  });

  it('режим «Разные получатели»: без подстановки, прежняя подстановка при смене пары сбрасывается', () => {
    expect(run({ insert: true, directoryAllowed: false })).toEqual({
      purpose: null,
      fromDirectory: false,
    });
    expect(
      run({
        purpose: 'realization',
        fromDirectory: true,
        pairChanged: true,
        directoryAllowed: false,
      }),
    ).toEqual({ purpose: null, fromDirectory: false });
  });

  it('явный выбор человека пишется как есть и снимает флаг', () => {
    expect(
      run({ purpose: 'realization', fromDirectory: true, chosen: 'contractor_materials' }),
    ).toEqual({ purpose: 'contractor_materials', fromDirectory: false });
  });

  it('МОЛ → подрядчик: «Свои силы» снимается, пустое место занимает справочник', () => {
    expect(run({ prevKind: 'mol', purpose: 'own_forces', pairChanged: true })).toEqual({
      purpose: 'tolling_act',
      fromDirectory: true,
    });
  });
});

describe('nextDeliveryPurpose — перебор', () => {
  const AUTOS: (DeliveryPurpose | null)[] = [
    null,
    'realization',
    'tolling_act',
    'contractor_materials',
  ];
  const B = [false, true];
  for (const prevKind of KINDS)
    for (const nextKind of KINDS)
      for (const purpose of PURPOSES)
        for (const fromDirectory of B)
          for (const insert of B)
            for (const pairChanged of B)
              for (const firstConfirm of B)
                for (const directoryAllowed of B) {
                  const a = {
                    prevKind,
                    nextKind,
                    purpose,
                    fromDirectory,
                    insert,
                    pairChanged,
                    firstConfirm,
                    directoryAllowed,
                  };
                  const outs = AUTOS.map((nextAuto) => nextDeliveryPurpose({ ...a, nextAuto }));
                  const name = JSON.stringify(a);
                  it(name, () => {
                    for (const out of outs) {
                      // Инвариант 1: результат допустим для нового получателя.
                      if (out.purpose !== null) {
                        expect(allowedDeliveryPurposes(nextKind)).toContain(out.purpose);
                      }
                      // Инвариант 2: флаг без признака не ставится.
                      if (out.fromDirectory) expect(out.purpose).not.toBeNull();
                    }
                    // Инвариант 3: справочник не нужен — результат от него не зависит
                    // (сервер тогда и не делает запрос).
                    if (!deliveryPurposeNeedsDirectory(a)) {
                      for (const out of outs) expect(out).toEqual(outs[0]);
                    }
                    // Инвариант 4: ручной непустой признак при подрядчике не меняется.
                    const manualKept =
                      !fromDirectory && purpose !== null && purpose !== 'own_forces';
                    if (manualKept && nextKind === 'contractor') {
                      for (const out of outs) {
                        expect(out).toEqual({ purpose, fromDirectory: false });
                      }
                    }
                    // Инвариант 5: без событий пустой признак не заполняется.
                    if (!insert && !pairChanged && !firstConfirm) {
                      for (const out of outs) {
                        expect(out.purpose).toBe(
                          reconcileDeliveryPurpose(prevKind, nextKind, purpose),
                        );
                      }
                    }
                  });
                }
});

describe('detachDirectoryPurpose — документ со своим получателем', () => {
  const general = { contractorId: 'A', recipientMolId: null, purpose: 'realization' as const };
  const doc = {
    ownRecipient: true,
    contractorId: 'B',
    recipientMolId: null,
    ownPurpose: false,
    purpose: null,
  };
  it('общий признак от справочника + другой получатель документа → собственный пустой', () => {
    expect(detachDirectoryPurpose(general, true, doc)).toEqual({
      ...doc,
      ownPurpose: true,
      purpose: null,
    });
  });
  it('ручной общий признак, свой признак документа, тот же получатель, наследование — без изменений', () => {
    expect(detachDirectoryPurpose(general, false, doc)).toBe(doc);
    const own = { ...doc, ownPurpose: true, purpose: 'tolling_act' as const };
    expect(detachDirectoryPurpose(general, true, own)).toBe(own);
    const same = { ...doc, contractorId: 'A' };
    expect(detachDirectoryPurpose(general, true, same)).toBe(same);
    const inherit = { ...doc, ownRecipient: false, contractorId: null };
    expect(detachDirectoryPurpose(general, true, inherit)).toBe(inherit);
  });
});
