/**
 * Группы поставщиков для выбора человеком (фильтр «Поставщик», окно в карточке).
 *
 * Данные — по боевому справочнику 02.11: у ТУЛА-СТАЛЬ 40 записей, настоящая из
 * них — BillHub «ООО "ТД "ТУЛА-СТАЛЬ"», дубли записаны «ТОРГОВЫЙ ДОМ» и с
 * ошибочными ИНН, одна — с ИНН СУ-10. Тёзки ПАРИТЕТ — разные организации,
 * BillHub даёт им разные ИНН.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSupplierFilterGroups,
  filterInn,
  groupKey,
  isCorrectFilterInn,
  matchCounterpartiesToGroups,
  type SupplierGroupRow,
} from '../src/domain/directories/supplier-filter-groups.js';
import { isValidInnChecksum } from '../src/domain/sourceDocuments/resolve-contractor.js';

const SU10 = '7736255508';
const TULA_BH = '7725495000';
const TULA_DUP = '7725459500'; // ошибка чтения, но контрольная сумма сходится
const PARITET_A = '7733896430';
const PARITET_B = '9722024783';

let seq = 0;
function row(name: string, inn: string, extra: Partial<SupplierGroupRow> = {}): SupplierGroupRow {
  seq += 1;
  return {
    id: extra.id ?? `id-${String(seq).padStart(4, '0')}`,
    name,
    inn,
    aliases: [],
    billhubId: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    ...extra,
  };
}
const bh = (name: string, inn: string, extra: Partial<SupplierGroupRow> = {}): SupplierGroupRow =>
  row(name, inn, { billhubId: `bh-${seq + 1}`, ...extra });

describe('ИНН фильтра', () => {
  it('filterInn: только цифры любой длины, пусто и нули — нет ИНН', () => {
    expect(filterInn(' ИНН 7725-495 000 ')).toBe(TULA_BH);
    // 11 цифр не выбрасываются: две одинаковые опечатки обязаны совпасть.
    expect(filterInn('50272996594')).toBe('50272996594');
    expect(filterInn('0000000000')).toBeNull();
    expect(filterInn('000000000000')).toBeNull();
    expect(filterInn('')).toBeNull();
    expect(filterInn(null)).toBeNull();
  });

  it('isCorrectFilterInn: длина 10/12 и контрольная сумма; нули отсекает filterInn', () => {
    expect(isCorrectFilterInn(TULA_BH)).toBe(true);
    expect(isCorrectFilterInn(TULA_DUP)).toBe(true);
    expect(isCorrectFilterInn('7725495001')).toBe(false);
    expect(isCorrectFilterInn('612309747130')).toBe(true);
    expect(isCorrectFilterInn('50272996594')).toBe(false);
    expect(isCorrectFilterInn(null)).toBe(false);
    // Почему нули нельзя отдавать в проверку суммы напрямую: она у них сходится.
    expect(isValidInnChecksum('0000000000')).toBe(true);
    expect(isCorrectFilterInn(filterInn('0000000000'))).toBe(false);
  });
});

describe('ключ имени', () => {
  it('форма собственности, кавычки и «ТОРГОВЫЙ ДОМ» → «ТД» не различают', () => {
    expect(groupKey('ООО "ТД "ТУЛА-СТАЛЬ"')).toBe('ТД ТУЛА-СТАЛЬ');
    expect(groupKey('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТОРГОВЫЙ ДОМ "ТУЛА-СТАЛЬ"')).toBe(
      'ТД ТУЛА-СТАЛЬ',
    );
    expect(groupKey('ООО СТРОИТЕЛЬНЫЙ ТОРГОВЫЙ ДОМ ПЕТРОВИЧ')).toBe(
      groupKey('ООО "СТД "ПЕТРОВИЧ"'),
    );
    expect(groupKey('ООО «ГРУППА КОМПАНИЙ ФИКСАР»')).toBe(groupKey('ООО "ГК ФИКСАР"'));
  });

  it('Й и И — разные буквы: «МАЙ» и «МАИ» не склеиваются', () => {
    expect(groupKey('ООО "МАЙ"')).not.toBe(groupKey('ООО "МАИ"'));
  });

  it('имя без смысловой части даёт пустой ключ', () => {
    expect(groupKey('ООО')).toBe('');
    expect(groupKey('ТК')).toBe('');
    expect(groupKey('ООО «ТОРГОВАЯ КОМПАНИЯ»')).toBe('');
    expect(groupKey('  ')).toBe('');
  });
});

describe('buildSupplierFilterGroups', () => {
  it('ТУЛА-СТАЛЬ: BillHub и дубли «ТОРГОВЫЙ ДОМ» — одна строка, основная — BillHub', () => {
    const real = bh('ООО "ТД "ТУЛА-СТАЛЬ"', TULA_BH);
    const rows = [
      row('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТОРГОВЫЙ ДОМ "ТУЛА-СТАЛЬ"', SU10, {
        docCount: 51,
      }),
      row('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТОРГОВЫЙ ДОМ "ТУЛА-СТАЛЬ"', TULA_DUP),
      row('Общество с ограниченной ответственностью "Торговый Дом "Тула-Сталь"', '774950001'),
      row('ООО «ТОРГОВЫЙ ДОМ «ТУЛА-СТАЛЬ»', '7782545000'),
      real,
    ];
    const groups = buildSupplierFilterGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.value).toBe(real.id);
    expect(groups[0]!.label).toBe('ООО "ТД "ТУЛА-СТАЛЬ"');
    expect([...groups[0]!.memberIds].sort()).toEqual(rows.map((r) => r.id).sort());
    // Неисправимо чужой ИНН (СУ-10) у дубля не помечен как ИНН BillHub.
    expect(groups[0]!.inns).toContainEqual({ digits: SU10, billhubCorrect: false });
    expect(groups[0]!.inns).toContainEqual({ digits: TULA_BH, billhubCorrect: true });
  });

  it('СТД / СТРОИТЕЛЬНЫЙ ТОРГОВЫЙ ДОМ ПЕТРОВИЧ — одна строка; МАЙ и МАИ — две', () => {
    const groups = buildSupplierFilterGroups([
      bh('ООО "СТД "ПЕТРОВИЧ"', '7802348846'),
      row('ООО СТРОИТЕЛЬНЫЙ ТОРГОВЫЙ ДОМ ПЕТРОВИЧ', '7802348846'),
      row('ООО СТД Петрович', '7714679380'),
      row('ООО "МАЙ"', ''),
      row('ООО "МАИ"', ''),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['ООО "МАИ"', 'ООО "МАЙ"', 'ООО "СТД "ПЕТРОВИЧ"']);
    expect(groups.find((g) => g.label.includes('ПЕТРОВИЧ'))!.memberIds).toHaveLength(3);
  });

  it('имена без смысловой части — каждая запись отдельно, подписи различимы', () => {
    const a = row('ООО', '');
    const b = row('ООО', '');
    const groups = buildSupplierFilterGroups([
      row('ТК', ''),
      row('ООО «ТОРГОВАЯ КОМПАНИЯ»', ''),
      row('ООО', '7733481259'),
      row('  ', ''),
      a,
      b,
    ]);
    expect(groups).toHaveLength(6);
    const labels = groups.map((g) => g.label);
    expect(new Set(labels).size).toBe(6);
    expect(labels).toContain('ТК (без ИНН)');
    expect(labels).toContain('ООО (ИНН 7733481259)');
    expect(labels).toContain('Без названия (без ИНН)');
    expect(labels).toContain(`ООО (без ИНН) · ${a.id.slice(0, 8)}`);
    expect(labels).toContain(`ООО (без ИНН) · ${b.id.slice(0, 8)}`);
  });

  describe('основная запись', () => {
    const name = 'ООО "ИСТКУЛЬТ МОЖАЙСК"';

    it('ИНН СУ-10 или подрядчика проигрывает постороннему корректному', () => {
      const own = row(name, SU10, { docCount: 51 });
      const contractor = row(name, '7733481259', { docCount: 40 });
      const right = row(name, TULA_DUP, { docCount: 10 });
      const broken = row(name, '5028021898', { docCount: 100 });
      const rows = [own, contractor, right, broken];
      const ctx = { ownInns: new Set([SU10]), contractorInns: new Set(['7733481259']) };
      expect(buildSupplierFilterGroups(rows, ctx)[0]!.value).toBe(right.id);
      // Без контекста решает число документов среди корректных ИНН.
      expect(buildSupplierFilterGroups(rows)[0]!.value).toBe(own.id);
    });

    it('при равенстве — больше документов, затем старше', () => {
      const few = row(name, TULA_DUP, { docCount: 2 });
      const many = row(name, '7802348846', { docCount: 9 });
      expect(buildSupplierFilterGroups([few, many])[0]!.value).toBe(many.id);
      const older = row(name, TULA_DUP);
      const newer = row(name, '7802348846');
      expect(buildSupplierFilterGroups([newer, older])[0]!.value).toBe(older.id);
    });

    it('запись BillHub с некорректным ИНН выше автозаписи с корректным', () => {
      const billhub = bh(name, '502802169');
      const auto = row(name, TULA_DUP, { docCount: 70 });
      expect(buildSupplierFilterGroups([auto, billhub])[0]!.value).toBe(billhub.id);
    });
  });

  it('один ИНН BillHub и автозапись с другим корректным ИНН — одна строка (принятое ограничение)', () => {
    const groups = buildSupplierFilterGroups([
      bh('ООО "КОМЕТА"', PARITET_A),
      row('ООО «Комета»', PARITET_B),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.memberIds).toHaveLength(2);
  });

  it('тёзки ПАРИТЕТ: строка на каждый ИНН BillHub и один остаток', () => {
    const a = bh('ООО "ПАРИТЕТ"', PARITET_A);
    const b = bh('ООО "ПАРИТЕТ"', PARITET_B);
    const autoA = row('ООО «Паритет»', PARITET_A);
    const rest = [
      row('ПАРИТЕТ', '77264256160'),
      row('ООО ПАРИТЕТ', '77264256160'),
      row('ООО "ПАРИТЕТ"', ''),
      bh('ООО "ПАРИТЕТ"', '772642561'),
    ];
    const groups = buildSupplierFilterGroups([a, b, autoA, ...rest]);
    expect(groups.map((g) => g.label)).toEqual([
      `ООО "ПАРИТЕТ" (ИНН ${PARITET_A})`,
      `ООО "ПАРИТЕТ" (ИНН ${PARITET_B})`,
      'ООО "ПАРИТЕТ" (ИНН не подтверждён)',
    ]);
    expect([...groups[0]!.memberIds].sort()).toEqual([a.id, autoA.id].sort());
    expect(groups[1]!.memberIds).toEqual([b.id]);
    expect([...groups[2]!.memberIds].sort()).toEqual(rest.map((r) => r.id).sort());
    // Основная запись остатка — BillHub, хотя её ИНН и некорректен.
    expect(groups[2]!.value).toBe(rest[3]!.id);
    expect(groups[2]!.inns).toContainEqual({ digits: '772642561', billhubCorrect: false });
  });

  it('BillHub с опечаткой в ИНН рядом с BillHub с верным — тёзок нет', () => {
    const groups = buildSupplierFilterGroups([
      bh('ООО «ЭЛЕКТРОМОНТАЖ»', '5027296594'),
      bh('ООО "ЭЛЕКТРОМОНТАЖ"', '50272996594'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.inns).toContainEqual({ digits: '50272996594', billhubCorrect: false });
  });

  it('ключи имён группы включают алиасы участников', () => {
    const groups = buildSupplierFilterGroups([
      row('ООО "РЕКЛЭЙР"', '7700000001', { aliases: ['ООО «РЕКЛЭИР»'] }),
    ]);
    expect(groups[0]!.nameKeys.sort()).toEqual(['РЕКЛЭИР', 'РЕКЛЭЙР']);
  });

  it('подписи всех строк различаются', () => {
    const rows = [
      bh('ООО "ПАРИТЕТ"', PARITET_A),
      bh('ООО "ПАРИТЕТ"', PARITET_B),
      row('ООО "ПАРИТЕТ"', ''),
      bh('ООО "ТД "ТУЛА-СТАЛЬ"', TULA_BH),
      row('ООО «ТОРГОВЫЙ ДОМ «ТУЛА-СТАЛЬ»', SU10),
      row('ООО', ''),
      row('ООО', ''),
      row('ТК', ''),
      row('ООО "ТК"', ''),
    ];
    const labels = buildSupplierFilterGroups(rows).map((g) => g.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('matchCounterpartiesToGroups', () => {
  it('ИНН BillHub: своё имя — «ИНН и имя», чужое — исключение; ИНН дубля — только со своим именем', () => {
    const groups = buildSupplierFilterGroups([
      bh('ООО "БАВ БЕТОН"', TULA_BH),
      row('ООО «Бав Бетон»', SU10),
    ]);
    const matched = matchCounterpartiesToGroups(groups, [
      { id: 'same', inn: TULA_BH, name: 'ООО "БАВ БЕТОН"', aliases: [] },
      { id: 'zm', inn: TULA_BH, name: 'ООО "ЗМ ГРУПП"', aliases: [] },
      { id: 'su10', inn: SU10, name: 'ООО "СУ-10"', aliases: [] },
      { id: 'dup', inn: SU10, name: 'БАВ БЕТОН', aliases: null },
    ]);
    expect(Object.fromEntries(matched)).toEqual({
      same: 'inn_and_name',
      zm: 'billhub_inn',
      dup: 'inn_and_name',
    });
  });
});
