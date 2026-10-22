import { describe, expect, it } from 'vitest';
import type { BillhubSupplier, OneCContractor } from '../src/domain/directories/parse.js';
import { extractBracketInn } from '../src/domain/directories/names.js';
import {
  applyContractorChanges,
  planContractors,
  type CcRow,
} from '../src/domain/directories/plan-contractors.js';
import { planSupplierMerges } from '../src/domain/directories/plan-merges.js';
import {
  applySupplierChanges,
  planSuppliers,
  type SupplierRow,
} from '../src/domain/directories/plan-suppliers.js';
import { buildDirectoriesPlan, type DirectoriesState } from '../src/domain/directories/plan.js';

// Корректные ИНН (контрольная сумма сходится) из боевых примеров.
const INN = {
  inoks: '5906154545',
  lentehstrom: '7825667888',
  elteh: '7842224734',
  yutara: '9704043737',
  paritet: '7733896430',
  monolitAo: '5044046682',
  monolitOoo: '9734005182',
  alyans: '7716967786',
};

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function dbRow(p: Partial<SupplierRow> & { name: string }): SupplierRow {
  return {
    id: uuid(),
    billhubId: null,
    inn: '',
    aliases: [],
    lastSecurityStatus: null,
    foundingDocumentsComment: null,
    createdAt: new Date('2026-08-20T10:00:00Z'),
    ...p,
  };
}

function hubRow(p: Partial<BillhubSupplier> & { name: string; innRaw: string }): BillhubSupplier {
  return {
    rowNo: ++seq,
    id: uuid(),
    aliases: [],
    securityStatus: null,
    comment: null,
    createdAt: new Date('2026-03-17T15:27:00Z'),
    ...p,
  };
}

function state(suppliers: SupplierRow[], contractors: CcRow[] = []): DirectoriesState {
  return { suppliers, contractors, docCounts: new Map() };
}

describe('planSuppliers', () => {
  it('сид 0055: находит по id, ставит billhub_id, различие только в пробелах — не правка', () => {
    const seed = dbRow({ name: 'ООО "СЭМПРО"  ', inn: '7701234567' });
    const f = hubRow({ id: seed.id, name: ' ООО "СЭМПРО" ', innRaw: '7701234567' });
    const plan = planSuppliers([f], [seed]);
    expect(plan.matches).toEqual([
      { rowNo: f.rowNo, billhubId: seed.id, id: seed.id, match: 'id' },
    ]);
    expect(plan.updates.get(seed.id)).toEqual({ billhubId: seed.id });
  });

  it('статус и комментарий: пишем непустое, пустое в файле ничего не стирает', () => {
    const a = dbRow({
      name: 'ООО "А"',
      lastSecurityStatus: 'approved',
      foundingDocumentsComment: 'полный комплект',
    });
    const b = dbRow({ name: 'ООО "Б"' });
    const plan = planSuppliers(
      [
        hubRow({ id: a.id, name: 'ООО "А"', innRaw: '' }),
        hubRow({
          id: b.id,
          name: 'ООО "Б"',
          innRaw: '',
          securityStatus: 'approved',
          comment: 'почта: x@y.ru',
        }),
      ],
      [a, b],
    );
    expect(plan.updates.get(a.id)).toEqual({ billhubId: a.id });
    expect(plan.updates.get(b.id)).toEqual({
      billhubId: b.id,
      lastSecurityStatus: 'approved',
      foundingDocumentsComment: 'почта: x@y.ru',
    });
    expect(plan.findings.map((f) => f.code)).toEqual(['comment_kept']);
  });

  it('переименование строки, найденной по id: опечатка формы исправляется, старое имя не в алиасы', () => {
    const seed = dbRow({ name: 'ОО "Пластко"' });
    const plan = planSuppliers([hubRow({ id: seed.id, name: 'ОО "Пластко"', innRaw: '' })], [seed]);
    expect(plan.updates.get(seed.id)).toEqual({ billhubId: seed.id, name: 'ООО "Пластко"' });
  });

  it('обогащение по ИНН: id строки и ИНН остаются, имя из BillHub, старое — в алиасы', () => {
    const auto = dbRow({
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТРУППА КОМПАНИЙ "ИНОКС"',
      inn: INN.inoks,
    });
    const f = hubRow({
      name: '"Группа Компаний "ИНОКС"',
      innRaw: INN.inoks,
      securityStatus: 'approved',
    });
    const plan = planSuppliers([f], [auto]);
    expect(plan.inserts).toEqual([]);
    expect(plan.matches[0]).toMatchObject({ id: auto.id, match: 'inn' });
    expect(plan.updates.get(auto.id)).toEqual({
      billhubId: f.id,
      name: '"Группа Компаний "ИНОКС"',
      aliases: [auto.name],
      lastSecurityStatus: 'approved',
    });
  });

  it('повторный запуск находит обогащённую строку по billhub_id и ничего не меняет', () => {
    const auto = dbRow({ name: 'ИП Тюриков А.В.', inn: '500402507852' });
    const file = [hubRow({ name: 'ИП Тюриков Александр Вячеславович', innRaw: '500402507852,' })];
    const first = planSuppliers(file, [auto]);
    const second = planSuppliers(file, first.rowsAfter);
    expect(second.matches[0]).toMatchObject({ id: auto.id, match: 'billhub_id' });
    expect(second.updates.size).toBe(0);
    expect(second.inserts).toEqual([]);
  });

  it('несколько строк базы с тем же ИНН — пропуск без вставки', () => {
    const a = dbRow({ name: 'ООО "Ю"', inn: INN.yutara });
    const b = dbRow({ name: 'ООО "Ю-2"', inn: INN.yutara });
    const plan = planSuppliers([hubRow({ name: 'ООО "ЮТАРА"', innRaw: INN.yutara })], [a, b]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates.size).toBe(0);
    expect(plan.findings[0]).toMatchObject({ code: 'multi_inn', dbIds: [a.id, b.id] });
  });

  it('две строки файла на одну запись базы — обе пропускаются', () => {
    const auto = dbRow({ name: 'ООО "Ю"', inn: INN.yutara });
    const plan = planSuppliers(
      [
        hubRow({ name: 'ООО "ЮТАРА"', innRaw: INN.yutara }),
        hubRow({ name: 'ЮТАРА', innRaw: `ИНН ${INN.yutara}` }),
      ],
      [auto],
    );
    expect(plan.updates.size).toBe(0);
    expect(plan.findings.map((f) => f.code)).toEqual(['file_collision', 'file_collision']);
  });

  it('строка, занятая по id, не участвует в сопоставлении по ИНН', () => {
    const seed = dbRow({ name: 'ООО "А"', inn: INN.alyans });
    const other = hubRow({ name: 'ООО "Альянс-2"', innRaw: INN.alyans });
    const plan = planSuppliers(
      [hubRow({ id: seed.id, name: 'ООО "А"', innRaw: INN.alyans }), other],
      [seed],
    );
    expect(plan.matches).toHaveLength(1);
    expect(plan.inserts.map((r) => r.id)).toEqual([other.id]);
  });

  it('вставка: id и created_at из BillHub, ИНН очищен до цифр, опечатка формы исправлена', () => {
    const f = hubRow({
      name: '000 Компания "Карат"',
      innRaw: `ИНН ${INN.yutara}`,
      securityStatus: 'approved',
    });
    const plan = planSuppliers([f], []);
    expect(plan.inserts).toEqual([
      {
        id: f.id,
        billhubId: f.id,
        inn: INN.yutara,
        name: 'ООО Компания "Карат"',
        aliases: [],
        lastSecurityStatus: 'approved',
        foundingDocumentsComment: null,
        createdAt: f.createdAt,
      },
    ]);
    expect(plan.innCleanedOnInsert).toEqual([
      { id: f.id, from: `ИНН ${INN.yutara}`, to: INN.yutara },
    ]);
  });
});

describe('planSupplierMerges', () => {
  const hub = (p: Partial<SupplierRow> & { name: string }) => {
    const r = dbRow(p);
    return { ...r, billhubId: r.id };
  };

  it('битый ИНН с одной ошибкой и тот же ИНН — склеиваются, имена уходят в алиасы цели', () => {
    const target = hub({ name: 'АО "ТД "ЭЛЕКТРОТЕХМОНТАЖ"', inn: INN.elteh });
    const oneEdit = dbRow({ name: 'ТД Электротехмонтаж', inn: '784224734' });
    const swapped = dbRow({ name: 'АО "ТД "Электротехмонтаж"', inn: '7842227434' });
    const plan = planSupplierMerges([target, oneEdit, swapped], new Map());
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0]!.targetId).toBe(target.id);
    expect(plan.merges[0]!.sources.map((s) => [s.id, s.class])).toEqual([
      [oneEdit.id, 'one_edit'],
      [swapped.id, 'one_edit'],
    ]);
    expect(plan.deleteIds).toEqual([oneEdit.id, swapped.id]);
    // «АО "ТД "Электротехмонтаж"» отличается от имени цели только регистром — не алиас.
    expect(plan.updates.get(target.id)).toEqual({ aliases: ['ТД Электротехмонтаж'] });
  });

  it('две ошибки, пустой и далёкий ИНН — только отчёт', () => {
    const target = hub({ name: 'АО "ТД "ЭЛЕКТРОТЕХМОНТАЖ"', inn: INN.elteh });
    const two = dbRow({ name: 'ТД Электротехмонтаж', inn: '7842247134' });
    const empty = dbRow({ name: 'Электротехмонтаж ТД АО', inn: '' });
    const far = dbRow({ name: 'АО ТД ЭЛЕКТРОТЕХМОНТАЖ', inn: '1111111111' });
    const plan = planSupplierMerges([target, two, empty, far], new Map());
    expect(plan.merges).toEqual([]);
    expect(plan.doubtful.map((d) => d.reason)).toEqual(['two_edits', 'far_inn']);
    // «Электротехмонтаж ТД» — другой ключ (порядок слов), в группу не попал.
    expect(plan.deleteIds).toEqual([]);
  });

  it('пустой ИНН в той же группе — отчёт, не склейка', () => {
    const target = hub({ name: 'ООО "ЛЕНИНЕРТ"', inn: '7816583913' });
    const empty = dbRow({ name: 'Ленинерт', inn: '' });
    const plan = planSupplierMerges([target, empty], new Map());
    expect(plan.merges).toEqual([]);
    expect(plan.doubtful).toMatchObject([{ reason: 'empty_inn', ids: [empty.id] }]);
  });

  it('группа с двумя различными корректными ИНН целиком на ручную проверку', () => {
    const ao = hub({ name: 'АО "МОНОЛИТСТРОЙ"', inn: INN.monolitAo });
    const ooo = dbRow({ name: 'ООО "МОНОЛИТСТРОЙ"', inn: INN.monolitOoo });
    const broken = dbRow({ name: 'Монолитстрой', inn: '504404668' });
    const plan = planSupplierMerges([ao, ooo, broken], new Map());
    expect(plan.merges).toEqual([]);
    expect(plan.doubtful).toMatchObject([
      { reason: 'several_valid_inn', ids: [ao.id, ooo.id, broken.id] },
    ]);
  });

  it('строка BillHub никогда не источник, разные формы — не склейка', () => {
    const target = hub({ name: 'ООО "ПАРИТЕТ"', inn: INN.paritet });
    const otherHub = hub({ name: 'ООО «Паритет»', inn: '773896430' });
    const ao = dbRow({ name: 'АО "Паритет"', inn: '7733896431' });
    const plan = planSupplierMerges([target, otherHub, ao], new Map());
    expect(plan.merges).toEqual([]);
    expect(plan.doubtful.map((d) => d.reason)).toEqual(['billhub_row', 'form_conflict']);
  });

  it('у источника есть статус СБ или не влезают алиасы — ручная проверка', () => {
    const target = hub({
      name: 'ООО "ВЕЗА"',
      inn: '7720040225',
      aliases: Array.from({ length: 20 }, (_, i) => `веза ${i}`),
    });
    const src = dbRow({
      name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ВЕЗА"',
      inn: '7720640225',
    });
    const withStatus = dbRow({ name: 'ВЕЗА', inn: '7720040226', lastSecurityStatus: 'approved' });
    const plan = planSupplierMerges([target, src, withStatus], new Map());
    expect(plan.merges).toEqual([]);
    expect(plan.doubtful.map((d) => d.reason).sort()).toEqual(['aliases_overflow', 'has_data']);
  });

  it('ЮТАРА: автодубль с теми же цифрами склеивается, затем грязный ИНН строки BillHub очищается', () => {
    const seed = hub({ name: 'ООО "ЮТАРА"', inn: `ИНН ${INN.yutara}` });
    const auto = dbRow({ name: 'ООО "ЮТАРА"', inn: INN.yutara });
    const plan = planSupplierMerges([seed, auto], new Map([[auto.id, 6]]));
    expect(plan.merges[0]).toMatchObject({
      targetId: seed.id,
      sources: [{ id: auto.id, class: 'same_inn' }],
    });
    expect(plan.innCleanups).toEqual([{ id: seed.id, from: `ИНН ${INN.yutara}`, to: INN.yutara }]);
    expect(plan.updates.get(seed.id)).toEqual({ inn: INN.yutara });
  });

  it('грязный ИНН не чистится, если такие цифры остаются у другой строки', () => {
    const seed = hub({ name: 'ОО "ВЕНЕВСКИЙ"', inn: '7722466153,' });
    const other = dbRow({ name: 'Совсем другое имя', inn: '7722466153' });
    const plan = planSupplierMerges([seed, other], new Map());
    expect(plan.innCleanups).toEqual([]);
    expect(plan.doubtful).toMatchObject([{ reason: 'dirty_inn_conflict', ids: [seed.id] }]);
  });
});

describe('planContractors', () => {
  const cc = (name: string, inn = '', aliases: string[] = []): CcRow => ({
    id: uuid(),
    name,
    inn,
    aliases,
  });
  const oneC = (raw: string): OneCContractor => {
    const b = extractBracketInn(raw);
    return { raw, base: b.base, inn: b.inn, rowNos: [1], projects: [] };
  };

  it('уровни сопоставления и алиас с написанием 1С только при другом ключе', () => {
    const alyans = cc('ООО «АЛЬЯНС»', INN.alyans);
    const fortex = cc('ООО «ФОРТЭКС»', '7736332544');
    const gorizont = cc('ООО «СК Горизонт»', '7723430488');
    const plan = planContractors(
      [oneC('АЛЬЯНС ООО (7716967786)'), oneC('ФОРТЭКС ООО'), oneC('ГОРИЗОНТ СК ООО')],
      [alyans, fortex, gorizont],
    );
    expect(plan.matches.map((m) => [m.raw, m.via])).toEqual([
      ['АЛЬЯНС ООО (7716967786)', 'inn'],
      ['ФОРТЭКС ООО', 'company_key'],
      ['ГОРИЗОНТ СК ООО', 'token_key'],
    ]);
    expect([...plan.aliasUpdates]).toEqual([[gorizont.id, ['ГОРИЗОНТ СК ООО']]]);
    expect(plan.inserts).toEqual([]);
  });

  it('по инициалам — только кандидат: ни вставки, ни правки', () => {
    const porunov = cc('ИП Порунов А.В.', '524310784550');
    const plan = planContractors([oneC('Порунов Артём Владимирович')], [porunov]);
    expect(plan.initialsCandidates).toEqual([
      { raw: 'Порунов Артём Владимирович', candidateIds: [porunov.id] },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.aliasUpdates.size).toBe(0);
    expect(plan.matches).toEqual([]);
  });

  it('тёзки в справочнике — неоднозначно, строка не создаётся', () => {
    const plan = planContractors(
      [oneC('МСУ-15 ООО')],
      [cc('ООО "МСУ-15"', '9727099983'), cc('ООО "МСУ-15"', '7728168971')],
    );
    expect(plan.ambiguous).toMatchObject([{ raw: 'МСУ-15 ООО', level: 'exact' }]);
    expect(plan.inserts).toEqual([]);
  });

  it('ИНН из файла не найден — новая строка, даже если есть тёзка без этого ИНН', () => {
    const plan = planContractors(
      [oneC('ПАРИТЕТ ООО (7736627650)')],
      [cc('ООО "ПАРИТЕТ"', INN.paritet)],
    );
    expect(plan.inserts).toMatchObject([
      { name: 'ООО "ПАРИТЕТ"', inn: '7736627650', aliases: ['ПАРИТЕТ ООО (7736627650)'] },
    ]);
  });

  it('новые строки в стиле справочника; повторный запуск ничего не меняет', () => {
    const file = [
      oneC('ЭСКО ООО'),
      oneC('ГРАДДОМСТРОЙ ООО ИК'),
      oneC('Лязина Ангелина Ростиславовна'),
    ];
    const first = planContractors(file, []);
    expect(first.inserts.map((i) => [i.name, i.aliases])).toEqual([
      ['ООО "ЭСКО"', ['ЭСКО ООО']],
      ['ГРАДДОМСТРОЙ ООО ИК', []],
      ['Лязина Ангелина Ростиславовна', []],
    ]);
    const second = planContractors(file, applyContractorChanges([], first));
    expect(second.inserts).toEqual([]);
    expect(second.aliasUpdates.size).toBe(0);
    expect(second.matches).toHaveLength(3);
  });
});

describe('buildDirectoriesPlan', () => {
  it('новая строка BillHub становится целью склейки: алиасы ложатся во вставку', () => {
    const auto = dbRow({ name: 'ООО "ПАРИТЕТ"', inn: '773896430' });
    const f = hubRow({ name: 'ООО "ПАРИТЕТ"', innRaw: INN.paritet });
    const plan = buildDirectoriesPlan({ suppliers: [f] }, state([auto]));
    expect(plan.supplierInserts).toHaveLength(1);
    expect(plan.supplierDeletes).toEqual([auto.id]);
    expect(plan.supplierUpdates.size).toBe(0);
    // Имя источника совпало с именем цели — алиас не нужен.
    expect(plan.supplierInserts[0]!.aliases).toEqual([]);
  });

  it('идемпотентность: план поверх применённого плана пуст, отпечаток стабилен', () => {
    const seed = dbRow({ name: 'ОО "Пластко"', inn: '7701234567' });
    const auto = dbRow({ name: 'ООО "ИНОКС"', inn: INN.inoks });
    const broken = dbRow({ name: 'ООО "Инокс"', inn: '5906154546' });
    const file = [
      hubRow({
        id: seed.id,
        name: 'ОО "Пластко"',
        innRaw: '7701234567',
        securityStatus: 'approved',
      }),
      hubRow({ name: '"Группа Компаний "ИНОКС"', innRaw: INN.inoks }),
      hubRow({ name: 'АО "ЛЕНТЕХСТРОМ"', innRaw: INN.lentehstrom }),
    ];
    const input = { suppliers: file, contractors: [] };
    const s = state([seed, auto, broken]);
    const plan = buildDirectoriesPlan(input, s);
    expect(plan.opCount).toBeGreaterThan(0);
    expect(buildDirectoriesPlan(input, s).fingerprint).toBe(plan.fingerprint);

    const after = applySupplierChanges(
      s.suppliers,
      plan.supplierUpdates,
      plan.supplierInserts,
      plan.supplierDeletes,
    );
    const again = buildDirectoriesPlan(input, state(after));
    expect(again.opCount).toBe(0);
  });
});
