// Склейка дублей поставщиков сверх правил 22.10: битый ИНН в одной правке от
// единственной корректной записи (near_inn_name) и ручные пары из отчёта.
// Обе — только по явному флагу; без него план прежний.
import { describe, expect, it } from 'vitest';
import { normalizeInn } from '../src/domain/sourceDocuments/resolve-contractor.js';
import {
  namesClose,
  parseManualPairs,
  planExtraMerges,
} from '../src/domain/directories/plan-near-inn.js';
import {
  applySupplierChanges,
  type SupplierRow,
} from '../src/domain/directories/plan-suppliers.js';
import { buildDirectoriesPlan, type DirectoriesState } from '../src/domain/directories/plan.js';

/** Корректный десятизначный ИНН: девять цифр + контрольная. */
function inn10(prefix9: string): string {
  const d = [...prefix9].map(Number);
  const check = ([2, 4, 10, 3, 5, 9, 4, 6, 8].reduce((a, w, i) => a + w * d[i]!, 0) % 11) % 10;
  return prefix9 + check;
}

/** Та же строка с заменой цифры в позиции i; проверяем, что ИНН стал битым. */
function broken(inn: string, i: number, digit: string): string {
  const out = inn.slice(0, i) + digit + inn.slice(i + 1);
  expect(normalizeInn(out)).toBeNull();
  return out;
}

let seq = 0;
function row(p: Partial<SupplierRow> & { name: string }): SupplierRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    billhubId: null,
    inn: '',
    aliases: [],
    lastSecurityStatus: null,
    foundingDocumentsComment: null,
    createdAt: new Date('2026-08-20T10:00:00Z'),
    ...p,
  };
}

function state(suppliers: SupplierRow[]): DirectoriesState {
  return { suppliers, contractors: [], docCounts: new Map() };
}

// Реальная пара с боя (приёмка 21713): 5028024698 — та же организация, одна цифра.
const ISTKULT = '5028021698';
const PETROVICH = inn10('781010101');
const OTHER = inn10('772020202');

describe('namesClose', () => {
  it('тот же ключ и опечатка в длинном имени — одна организация', () => {
    expect(namesClose('ООО "СТД ПЕТРОВИЧ"', 'СТД Петрович')).toBe(true);
    expect(namesClose('ООО "СТД ПЕТРОВИЧ"', 'ООО СТД ПЕТРОВИЧЬ')).toBe(true);
  });

  it('усечённое имя и другие слова — не одна', () => {
    expect(namesClose('ООО «МОЖАЙСК»', 'АО "ИСТКУЛЬТ МОЖАЙСК"')).toBe(false);
    expect(namesClose('ООО "АЛЬФА"', 'ООО "БЕТА"')).toBe(false);
  });

  it('короткое имя — только точное совпадение ключа', () => {
    expect(namesClose('ООО "СКМ"', 'ООО "СКА"')).toBe(false);
    expect(namesClose('ООО "СКМ"', 'СКМ')).toBe(true);
  });
});

describe('planExtraMerges — near_inn_name', () => {
  it('битый ИНН в одной цифре от единственной записи и имя с опечаткой — склейка, имя в алиасы', () => {
    const target = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH, billhubId: 'b-1' });
    const src = row({ name: 'ООО СТД ПЕТРОВИЧЬ', inn: broken(PETROVICH, 4, '9') });
    const p = planExtraMerges([target, src], { nearInn: true, pairs: [] });
    expect(p.merges).toEqual([
      {
        key: 'СТД ПЕТРОВИЧ',
        targetId: target.id,
        sources: [{ id: src.id, inn: src.inn, name: src.name, class: 'near_inn_name' }],
        aliasesAdded: ['ООО СТД ПЕТРОВИЧЬ'],
      },
    ]);
    expect(p.deleteIds).toEqual([src.id]);
    expect(p.updates.get(target.id)).toEqual({ aliases: ['ООО СТД ПЕТРОВИЧЬ'] });
    expect(p.doubtful).toEqual([]);
  });

  it('потерянная и переставленная цифра — тоже одна правка', () => {
    const target = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH });
    const lost = row({ name: 'СТД ПЕТРОВИЧ', inn: PETROVICH.slice(0, 9) });
    const swapped = row({
      name: 'ООО СТД ПЕТРОВИЧ',
      inn: PETROVICH.slice(0, 2) + PETROVICH[3] + PETROVICH[2] + PETROVICH.slice(4),
    });
    // Перестановка одинаковых цифр не меняет ИНН — тогда тест бессмыслен.
    expect(swapped.inn).not.toBe(PETROVICH);
    expect(normalizeInn(swapped.inn)).toBeNull();
    const p = planExtraMerges([target, lost, swapped], { nearInn: true, pairs: [] });
    expect(p.merges[0]!.sources.map((s) => s.id).sort()).toEqual([lost.id, swapped.id].sort());
  });

  it('имя близко только к уже принятому источнику — принимается сразу, повтор пуст', () => {
    const target = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH });
    const near = row({ name: 'ООО СТД ПЕТРОВИЧЬ', inn: broken(PETROVICH, 4, '9') });
    // От имени цели — три правки, от имени `near` — две.
    const chained = row({ name: 'СТД ПЕТРОВИЧЬЬЬ', inn: broken(PETROVICH, 5, '9') });
    const far = row({ name: 'ООО "ГРАНИТ"', inn: broken(PETROVICH, 6, '9') });
    const input = { mergesOnly: true, nearInn: true };
    const s = state([target, near, chained, far]);
    const plan = buildDirectoriesPlan(input, s);
    expect(plan.supplierDeletes.sort()).toEqual([near.id, chained.id].sort());
    expect(plan.merges!.doubtful).toEqual([
      { key: 'ГРАНИТ', reason: 'near_inn_name_far', ids: [far.id], targetId: target.id },
    ]);
    const after = applySupplierChanges(s.suppliers, plan.supplierUpdates, [], plan.supplierDeletes);
    expect(buildDirectoriesPlan(input, state(after)).opCount).toBe(0);
  });

  it('цель не из BillHub, а у имени есть другой корректный ИНН — отчёт; из BillHub — склейка', () => {
    // «СТД Петрович» на бою: у имени 10 корректных ИНН, часть — ошибки чтения,
    // у которых контрольная сумма сошлась случайно. Какой из них настоящий,
    // решает человек; запись BillHub — проверенная, ей верим.
    const target = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH });
    const namesake = row({ name: 'СТД Петрович', inn: OTHER });
    const src = row({ name: 'ООО СТД ПЕТРОВИЧЬ', inn: broken(PETROVICH, 4, '9') });
    const p = planExtraMerges([target, namesake, src], { nearInn: true, pairs: [] });
    expect(p.merges).toEqual([]);
    expect(p.doubtful).toEqual([
      {
        key: 'СТД ПЕТРОВИЧЬ',
        reason: 'near_inn_several_valid',
        ids: [src.id],
        targetId: target.id,
      },
    ]);

    const hubTarget = { ...target, billhubId: 'b-9' };
    const q = planExtraMerges([hubTarget, namesake, src], { nearInn: true, pairs: [] });
    expect(q.deleteIds).toEqual([src.id]);
  });

  it('цель с ИНН подрядчика или СУ-10 — отчёт («ТУЛА-СТАЛЬ» с ИНН СУ-10)', () => {
    const su10 = '7736255508';
    const junk = row({ name: 'ТД "ТУЛА-СТАЛЬ"', inn: su10 });
    const src = row({ name: 'ТД "ТУЛА-СТАЛЬ"', inn: '7735255508' });
    expect(normalizeInn(src.inn)).toBeNull();
    const p = planExtraMerges([junk, src], {
      nearInn: true,
      pairs: [],
      contractorInns: new Set([su10]),
    });
    expect(p.merges).toEqual([]);
    expect(p.doubtful[0]).toMatchObject({
      reason: 'near_inn_target_contractor',
      targetId: junk.id,
    });
  });

  it('ИНН в одной цифре, но имя другое — только отчёт («ООО «МОЖАЙСК»»)', () => {
    const target = row({ name: 'АО "ИСТКУЛЬТ МОЖАЙСК"', inn: ISTKULT });
    const src = row({ name: 'ООО «МОЖАЙСК»', inn: '5028024698' });
    expect(normalizeInn(src.inn)).toBeNull();
    const p = planExtraMerges([target, src], { nearInn: true, pairs: [] });
    expect(p.merges).toEqual([]);
    expect(p.doubtful).toEqual([
      { key: 'МОЖАЙСК', reason: 'form_conflict', ids: [src.id], targetId: target.id },
    ]);
  });

  it('та же форма, далёкое имя — отчёт near_inn_name_far', () => {
    const target = row({ name: 'ООО "ИСТКУЛЬТ МОЖАЙСК"', inn: ISTKULT });
    const src = row({ name: 'ООО «МОЖАЙСК»', inn: '5028024698' });
    const p = planExtraMerges([target, src], { nearInn: true, pairs: [] });
    expect(p.merges).toEqual([]);
    expect(p.doubtful[0]).toMatchObject({ reason: 'near_inn_name_far', targetId: target.id });
  });

  it('две корректные записи в одной правке — неоднозначно, отчёт без цели', () => {
    // Потерянная цифра: вставка в разные места даёт два разных корректных ИНН.
    const lost = '500000123';
    const valid: string[] = [];
    for (let pos = 0; pos <= lost.length; pos++) {
      for (let d = 0; d <= 9; d++) {
        const v = lost.slice(0, pos) + d + lost.slice(pos);
        if (normalizeInn(v) && !valid.includes(v)) valid.push(v);
      }
    }
    expect(valid.length).toBeGreaterThanOrEqual(2);
    const b = row({ name: 'ООО "АЛЬФА-СТРОЙ"', inn: valid[0]! });
    const c = row({ name: 'ООО "АЛЬФА-СТРОЙ"', inn: valid[1]! });
    const src = row({ name: 'ООО АЛЬФА-СТРОЙ', inn: lost });
    const p = planExtraMerges([b, c, src], { nearInn: true, pairs: [] });
    expect(p.merges).toEqual([]);
    expect(p.doubtful).toEqual([
      { key: 'АЛЬФА-СТРОЙ', reason: 'near_inn_ambiguous', ids: [src.id], targetId: null },
    ]);
  });

  it('BillHub-строка, строка со статусом СБ, корректный ИНН и две правки — не источники', () => {
    const target = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH });
    const hub = row({ name: 'СТД ПЕТРОВИЧ', inn: broken(PETROVICH, 4, '9'), billhubId: 'b-2' });
    const sb = row({
      name: 'СТД ПЕТРОВИЧ',
      inn: broken(PETROVICH, 5, '9'),
      lastSecurityStatus: 'approved',
    });
    const other = row({ name: 'СТД ПЕТРОВИЧ', inn: OTHER });
    const twoEdits = row({ name: 'СТД ПЕТРОВИЧ', inn: `99${PETROVICH.slice(2)}` });
    expect(normalizeInn(twoEdits.inn)).toBeNull();
    const p = planExtraMerges([target, hub, sb, other, twoEdits], { nearInn: true, pairs: [] });
    expect(p.merges).toEqual([]);
    expect(p.doubtful).toEqual([]);
  });

  it('без флага ничего не делает', () => {
    const target = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH });
    const src = row({ name: 'ООО СТД ПЕТРОВИЧЬ', inn: broken(PETROVICH, 4, '9') });
    const p = planExtraMerges([target, src], { nearInn: false, pairs: [] });
    expect(p).toEqual({
      merges: [],
      doubtful: [],
      pairIssues: [],
      updates: new Map(),
      deleteIds: [],
    });
  });
});

describe('planExtraMerges — ручные пары', () => {
  it('пара склеивается без алиасов и без сравнения имён и форм', () => {
    const target = row({ name: 'АО "ИСТКУЛЬТ МОЖАЙСК"', inn: ISTKULT });
    const src = row({ name: 'ООО «МОЖАЙСК»', inn: '5028024698' });
    const p = planExtraMerges([target, src], {
      nearInn: false,
      pairs: [{ sourceId: src.id, targetId: target.id }],
    });
    expect(p.merges).toEqual([
      {
        key: 'ИСТКУЛЬТ МОЖАЙСК',
        targetId: target.id,
        sources: [{ id: src.id, inn: src.inn, name: src.name, class: 'manual' }],
        aliasesAdded: [],
      },
    ]);
    expect(p.updates.size).toBe(0);
    expect(p.deleteIds).toEqual([src.id]);
    expect(p.pairIssues).toEqual([]);
  });

  it('ошибки пар — в отчёт, ничего не склеивается', () => {
    const t = row({ name: 'ООО "ЦЕЛЬ"', inn: PETROVICH });
    const t2 = row({ name: 'ООО "ЦЕЛЬ-2"', inn: OTHER });
    const u = row({ name: 'ООО "САМ НА СЕБЯ"' });
    const hub = row({ name: 'ООО "ХАБ"', billhubId: 'b-3' });
    const sb = row({ name: 'ООО "СБ"', foundingDocumentsComment: 'проверен' });
    const a = row({ name: 'ООО "А"' });
    const b = row({ name: 'ООО "Б"' });
    const c = row({ name: 'ООО "В"' });
    const missing = '00000000-0000-4000-8000-999999999999';
    const missingTarget = '00000000-0000-4000-8000-999999999998';
    const p = planExtraMerges([t, t2, u, hub, sb, a, b, c], {
      nearInn: false,
      pairs: [
        { sourceId: u.id, targetId: u.id },
        { sourceId: missing, targetId: t.id },
        { sourceId: hub.id, targetId: t.id },
        { sourceId: sb.id, targetId: t.id },
        // Цепочка a → b → t2: склейка в строку, которую тут же удаляют, запрещена.
        { sourceId: a.id, targetId: b.id },
        { sourceId: b.id, targetId: t2.id },
        { sourceId: c.id, targetId: missingTarget },
        { sourceId: c.id, targetId: t.id },
      ],
    });
    expect(p.merges).toEqual([]);
    expect(p.deleteIds).toEqual([]);
    expect(p.pairIssues.map((i) => i.problem)).toEqual([
      'источник и цель совпадают',
      'источника нет — уже склеен или удалён',
      'источник из BillHub — не удаляется',
      'у источника есть статус СБ или комментарий',
      'цель сама указана источником другой пары',
      'источник указан целью другой пары',
      'цели нет в справочнике',
      'источник указан дважды',
    ]);
  });
});

describe('buildDirectoriesPlan — склейка без файлов', () => {
  it('без флагов поведение прежнее: без файлов склейки нет', () => {
    const target = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH });
    const src = row({ name: 'ООО СТД ПЕТРОВИЧЬ', inn: broken(PETROVICH, 4, '9') });
    const plan = buildDirectoriesPlan({}, state([target, src]));
    expect(plan.merges).toBeNull();
    expect(plan.opCount).toBe(0);
  });

  it('mergesOnly: правила 22.10 по текущей таблице, near_inn и пары — только по флагам', () => {
    const tSame = row({ name: 'ООО "ИНОКС"', inn: inn10('590615454') });
    const sSame = row({
      name: 'ООО "Инокс"',
      inn: broken(tSame.inn, 9, tSame.inn[9] === '0' ? '1' : '0'),
    });
    const tNear = row({ name: 'ООО "СТД ПЕТРОВИЧ"', inn: PETROVICH });
    const sNear = row({ name: 'ООО СТД ПЕТРОВИЧЬ', inn: broken(PETROVICH, 4, '9') });
    const tPair = row({ name: 'АО "ИСТКУЛЬТ МОЖАЙСК"', inn: ISTKULT });
    const sPair = row({ name: 'ООО «МОЖАЙСК»', inn: '5028024698' });
    const s = state([tSame, sSame, tNear, sNear, tPair, sPair]);

    const only2210 = buildDirectoriesPlan({ mergesOnly: true }, s);
    expect(only2210.supplierDeletes).toEqual([sSame.id]);

    const input = {
      mergesOnly: true,
      nearInn: true,
      pairs: [{ sourceId: sPair.id, targetId: tPair.id }],
    };
    const plan = buildDirectoriesPlan(input, s);
    expect(plan.supplierDeletes.sort()).toEqual([sSame.id, sNear.id, sPair.id].sort());
    expect(plan.merges!.merges.flatMap((m) => m.sources.map((x) => x.class)).sort()).toEqual(
      ['manual', 'near_inn_name', 'one_edit'].sort(),
    );
    expect(plan.supplierUpdates.get(tPair.id)).toBeUndefined();
    expect(buildDirectoriesPlan(input, s).fingerprint).toBe(plan.fingerprint);
    expect(plan.fingerprint).not.toBe(only2210.fingerprint);

    // Повторный запуск после записи: пусто, пара — «уже склеен», не операция.
    const after = applySupplierChanges(s.suppliers, plan.supplierUpdates, [], plan.supplierDeletes);
    const again = buildDirectoriesPlan(input, state(after));
    expect(again.opCount).toBe(0);
    expect(again.merges!.pairIssues.map((i) => i.problem)).toEqual([
      'источника нет — уже склеен или удалён',
    ]);
  });
});

describe('parseManualPairs', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('заголовок, комментарии, разные разделители и регистр', () => {
    const text = `\uFEFFисточник;цель\n# МОЖАЙСК\n${A};${B.toUpperCase()}\n\n"${B}",${A}\r\n${A}\t${B}`;
    expect(parseManualPairs(text)).toEqual({
      pairs: [
        { sourceId: A, targetId: B },
        { sourceId: B, targetId: A },
        { sourceId: A, targetId: B },
      ],
      errors: [],
    });
  });

  it('битая строка — ошибка с номером, второй «заголовок» тоже', () => {
    const { pairs, errors } = parseManualPairs(`source;target\nsource;target\n${A}\n${A};не-id`);
    expect(pairs).toEqual([]);
    expect(errors).toEqual([
      'строка 2: нужны два id через «;» — «source;target»',
      `строка 3: нужны два id через «;» — «${A}»`,
      `строка 4: нужны два id через «;» — «${A};не-id»`,
    ]);
  });
});
