// Какую операционную строку отдаёт «Подставить»/выбор подрядчика из
// «Контрагентов», когда под одним ИНН их несколько (приёмка 21713:
// «ООО "СТРОЙСЕРВИС"» с ИНН СТРОЙПАРТНЕРа).
import { describe, expect, it } from 'vitest';
import {
  pickOperationalCounterparty,
  type OperationalRow,
} from '../src/domain/directories/operational-pick.js';

function row(id: string, name: string, kpp: string | null, day: number): OperationalRow {
  return {
    id,
    name,
    kpp,
    createdAt: new Date(`2026-08-${String(day).padStart(2, '0')}T10:00:00Z`),
  };
}

const dir = { name: 'ООО "СТРОЙПАРТНЕР"', aliases: [] };

describe('pickOperationalCounterparty', () => {
  it('одна строка — она и возвращается, что бы ни было в справочнике', () => {
    const only = row('a', 'ООО "СТРОЙСЕРВИС"', '772501001', 1);
    expect(pickOperationalCounterparty([only], dir, new Map())).toBe(only);
    expect(pickOperationalCounterparty([], dir, new Map())).toBeUndefined();
  });

  it('21713: строка с именем как в справочнике побеждает мусор и подразделение', () => {
    const junk = row('a', 'ООО "СТРОЙСЕРВИС"', '772501001', 1);
    const branch = row('b', 'ООО "СтройПартнер"', '772201001', 2);
    const main = row('c', 'ООО "СтройПартнер"', null, 3);
    const usage = new Map([['a', 50]]);
    expect(pickOperationalCounterparty([junk, branch, main], dir, usage)).toBe(main);
    expect(pickOperationalCounterparty([junk, branch], dir, usage)).toBe(branch);
  });

  it('имя совпало по алиасу справочника', () => {
    const a = row('a', 'ООО "Ромашка-М"', null, 1);
    const b = row('b', 'ООО "СП"', null, 2);
    expect(
      pickOperationalCounterparty(
        [a, b],
        { name: 'ООО "СТРОЙПАРТНЕР"', aliases: ['СП'] },
        new Map(),
      ),
    ).toBe(b);
  });

  it('имя не совпало ни у кого — без КПП, затем по числу приёмок, затем самая старая', () => {
    const old = row('a', 'X', null, 1);
    const used = row('b', 'Y', null, 5);
    const withKpp = row('c', 'Z', '770101001', 1);
    expect(pickOperationalCounterparty([withKpp, old, used], dir, new Map([['b', 3]]))).toBe(used);
    expect(pickOperationalCounterparty([withKpp, used, old], dir, new Map())).toBe(old);
  });

  it('порядок входа не влияет на результат', () => {
    const rows = [row('b', 'Y', null, 1), row('a', 'X', null, 1)];
    expect(pickOperationalCounterparty(rows, dir, new Map())?.id).toBe('a');
    expect(pickOperationalCounterparty([...rows].reverse(), dir, new Map())?.id).toBe('a');
  });
});
