import { describe, expect, it } from 'vitest';
import type { ParsedContract } from '../src/domain/supplier-contracts/parse.js';
import {
  buildContractsPlan,
  desiredFields,
  type ContractsState,
  type ContractStateRow,
} from '../src/domain/supplier-contracts/plan.js';

const SITES = new Map([
  ['ЗИЛ33', '00000000-0000-4000-8000-0000000000a1'],
  ['ЗИЛ18', '00000000-0000-4000-8000-0000000000a2'],
  ['СБ2', '00000000-0000-4000-8000-0000000000a3'],
]);

const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function parsed(n: number, patch: Partial<ParsedContract> = {}): ParsedContract {
  return {
    rowNo: n + 1,
    onecId: guid(n),
    counterpartyOnecId: null,
    counterpartyName: 'РУТЕК ООО',
    counterpartyInn: '7716951747',
    name: `Волоколамское ш., вл.93-97 этап 2, ДГ №СУ-СБ2/25-${n} от 26.08.25`,
    number: `СУ-СБ2/25-${n}`,
    contractDate: '2025-08-26',
    kind: 'supplier',
    objectText: null,
    ...patch,
  };
}

function stateRow(p: ParsedContract, patch: Partial<ContractStateRow> = {}): ContractStateRow {
  return {
    id: `id-${p.onecId}`,
    onecId: p.onecId,
    ...desiredFields(p, SITES).fields,
    missingSince: null,
    ...patch,
  };
}

const state = (rows: ContractStateRow[], links: Array<[string, string[]]> = []): ContractsState => ({
  contracts: rows,
  sitesByCode: SITES,
  linkedDeliveries: new Map(links),
});

describe('план импорта договоров', () => {
  it('новый договор, изменённый, без изменений', () => {
    const a = parsed(1);
    const b = parsed(2);
    const c = parsed(3);
    const plan = buildContractsPlan(
      [a, { ...b, name: `${b.name} (изм.)` }, c],
      state([stateRow(b), stateRow(c)]),
    );
    expect(plan.inserts.map((i) => i.onecId)).toEqual([a.onecId]);
    expect(plan.inserts[0]!.fields).toMatchObject({ siteStatus: 'exact', siteIds: [SITES.get('СБ2')] });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toMatchObject({ onecId: b.onecId, changed: ['name'], returnedFrom: null });
    expect(plan.unchanged).toBe(1);
    expect(plan.opCount).toBe(2);
  });

  it('пропал из файла — missing; уже пропавший и всё ещё отсутствующий — без операции', () => {
    const a = parsed(1);
    const b = parsed(2);
    const gone = stateRow(parsed(3));
    const goneEarlier = stateRow(parsed(4), { missingSince: '2026-11-01T10:00:00.000Z' });
    const plan = buildContractsPlan([a, b], state([stateRow(a), stateRow(b), gone, goneEarlier]));
    expect(plan.missing.map((m) => m.onecId)).toEqual([gone.onecId]);
    expect(plan.updates).toEqual([]);
    expect(plan.opCount).toBe(1);
  });

  it('вернулся в файл — returned с прежней датой пропажи', () => {
    const a = parsed(1);
    const plan = buildContractsPlan([a], state([stateRow(a, { missingSince: '2026-11-01T10:00:00.000Z' })]));
    expect(plan.returned).toBe(1);
    expect(plan.updates).toEqual([
      expect.objectContaining({ onecId: a.onecId, changed: [], returnedFrom: '2026-11-01T10:00:00.000Z' }),
    ]);
  });

  it('отпечаток не зависит от порядка строк файла и базы', () => {
    const rows = [parsed(1), parsed(2), parsed(3)];
    const db = [stateRow(parsed(2), { name: 'старое' }), stateRow(parsed(5))];
    const p1 = buildContractsPlan(rows, state(db));
    const p2 = buildContractsPlan([...rows].reverse(), state([...db].reverse()));
    expect(p1.fingerprint).toBe(p2.fingerprint);
    const p3 = buildContractsPlan(rows.slice(0, 2), state(db));
    expect(p3.fingerprint).not.toBe(p1.fingerprint);
  });

  it('шлюз массовой пропажи: больше 20 % живых договоров', () => {
    const live = Array.from({ length: 10 }, (_, i) => stateRow(parsed(i + 1)));
    const keep8 = live.slice(0, 8).map((r, i) => parsed(i + 1));
    expect(buildContractsPlan(keep8, state(live)).massMissing).toBe(false); // 2 из 10 = 20 %
    const keep7 = keep8.slice(0, 7);
    expect(buildContractsPlan(keep7, state(live)).massMissing).toBe(true); // 3 из 10
  });

  it('статус объекта — по полному набору правил; коды вне портала отбрасываются после', () => {
    // В портале из группы ЗИЛ18+ЗИЛ33 есть оба, из группы СОБ61+СОБ62 — ни одного.
    const zil = desiredFields(parsed(1, { name: 'Автозаводская ул., вл.23/2 ЖК ЗИЛАРТ, ДГ №1', number: null }), SITES);
    expect(zil.fields).toMatchObject({ siteStatus: 'group', siteIds: [SITES.get('ЗИЛ33'), SITES.get('ЗИЛ18')].sort() });
    const sob = desiredFields(parsed(2, { name: 'Раменки р-н, СОБЫТИЕ 6, Счет №1', number: null }), SITES);
    expect(sob.fields).toMatchObject({ siteStatus: 'none', siteIds: [] });
    expect(sob.unknownCodes).toEqual(['СОБ61', 'СОБ62']);
    // Группа, у которой в портале только один объект, остаётся группой.
    const onlyZil33 = new Map([['ЗИЛ33', SITES.get('ЗИЛ33')!]]);
    const part = desiredFields(parsed(3, { name: 'Автозаводская ул., вл.23/2 ЖК ЗИЛАРТ, ДГ №1', number: null }), onlyZil33);
    expect(part.fields).toMatchObject({ siteStatus: 'group', siteIds: [SITES.get('ЗИЛ33')] });
  });

  it('затронутые привязки: смена вида, объекта, пропажа', () => {
    const a = parsed(1);
    const b = parsed(2);
    const c = stateRow(parsed(3));
    const plan = buildContractsPlan(
      [
        { ...a, kind: 'buyer' },
        { ...b, name: 'Автозаводская ул., вл.23/2 ЖК ЗИЛАРТ (ЛОТ 33), ДГ №1', number: null },
      ],
      state([stateRow(a), stateRow(b), c], [
        [`id-${a.onecId}`, ['24508']],
        [`id-${b.onecId}`, ['24509']],
        [c.id, ['24510']],
      ]),
    );
    expect(plan.affectedLinks.map((x) => [x.reason, x.deliveries])).toEqual([
      ['kind', ['24508']],
      ['site', ['24509']],
      ['missing', ['24510']],
    ]);
  });
});
