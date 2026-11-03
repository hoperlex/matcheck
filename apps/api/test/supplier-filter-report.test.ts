/**
 * Отчёт по группам поставщиков: потери и добавления считаются против
 * прежнего фильтра «одна запись + контрагенты по её ИНН». Случаи — с боя
 * 02.11: РЕКЛЭЙР/РЕКЛЭИР (потеря), ИНН СУ-10 у дубля ТУЛА-СТАЛЬ (потеря
 * чужой приёмки — так и задумано), «ЗМ ГРУПП» с ИНН записи BillHub (исключение).
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseManualPairs } from '../src/domain/directories/plan-near-inn.js';
import { buildSupplierFilterGroups } from '../src/domain/directories/supplier-filter-groups.js';
import {
  buildPairCandidates,
  buildSupplierFilterReportXlsx,
  computeSupplierFilterReport,
  pairCandidatesCsv,
  type ReportInput,
  type ReportSupplierRow,
} from '../src/domain/directories/supplier-filter-report.js';

const SU10 = '7736255508';
const TULA_BH = '7725495000';
const TULA_DUP = '7725459500';
const REKLAIR = '7701234567';

const at = (n: number): Date => new Date(Date.UTC(2026, 0, n));

function input(): ReportInput {
  return {
    suppliers: [
      {
        id: 'bh',
        name: 'ООО "ТД "ТУЛА-СТАЛЬ"',
        inn: TULA_BH,
        aliases: [],
        billhubId: 'b1',
        createdAt: at(1),
      },
      {
        id: 'dup-su10',
        name: 'ООО «ТОРГОВЫЙ ДОМ «ТУЛА-СТАЛЬ»',
        inn: SU10,
        aliases: [],
        billhubId: null,
        createdAt: at(2),
      },
      {
        id: 'dup',
        name: 'ООО "ТОРГОВЫЙ ДОМ "ТУЛА-СТАЛЬ"',
        inn: TULA_DUP,
        aliases: [],
        billhubId: null,
        createdAt: at(3),
      },
      {
        id: 'reklair',
        name: 'ООО "РЕКЛЭЙР"',
        inn: REKLAIR,
        aliases: [],
        billhubId: null,
        createdAt: at(4),
      },
    ],
    ctx: { ownInns: new Set([SU10]) },
    counterparties: [
      { id: 'cp-su10', inn: SU10, name: 'ООО "СУ-10"', aliases: [] },
      { id: 'cp-reklair', inn: REKLAIR, name: 'ООО "РЕКЛЭИР"', aliases: [] },
      { id: 'cp-zm', inn: TULA_BH, name: 'ООО "ЗМ ГРУПП"', aliases: [] },
      { id: 'cp-dup', inn: TULA_DUP, name: 'ООО «Торговый дом Тула-Сталь»', aliases: [] },
    ],
    documents: [{ id: 'doc-a', number: 'УТ-1', dirId: 'dup-su10', opId: null }],
    deliveries: [
      { id: 'd1', displayId: 1, opId: 'cp-su10' },
      { id: 'd2', displayId: 2, opId: 'cp-reklair' },
      { id: 'd3', displayId: 3, opId: 'cp-zm' },
      { id: 'd4', displayId: 4, opId: null },
      { id: 'd5', displayId: 5, opId: 'cp-dup' },
    ],
    deliverySources: [{ ownerId: 'd4', documentId: 'doc-a' }],
    shipments: [],
    shipmentSources: [],
  };
}

describe('computeSupplierFilterReport', () => {
  const r = computeSupplierFilterReport(input());

  it('потери: приёмка СУ-10 через дубль и РЕКЛЭИР с другим именем', () => {
    expect(r.lost.map((x) => `${x.supplierName} → ${x.kind} ${x.ref}`).sort()).toEqual([
      'ООО "РЕКЛЭЙР" → приёмка 2',
      'ООО «ТОРГОВЫЙ ДОМ «ТУЛА-СТАЛЬ» → приёмка 1',
    ]);
    expect(r.lost.find((x) => x.ref === '1')?.counterparty).toBe(`ООО "СУ-10" (ИНН ${SU10})`);
  });

  it('добавления к основной записи — с причиной', () => {
    const byRef = new Map(r.added.map((x) => [`${x.kind} ${x.ref}`, x.reason]));
    expect([...byRef.keys()].sort()).toEqual(['документ УТ-1', 'приёмка 4', 'приёмка 5']);
    expect(byRef.get('приёмка 4')).toMatch(/^документ на записи «ООО «ТОРГОВЫЙ ДОМ «ТУЛА-СТАЛЬ»»/);
    expect(byRef.get('приёмка 5')).toMatch(/ИНН и имя\/алиас$/);
  });

  it('исключение BillHub: контрагент с ИНН записи BillHub и другим именем', () => {
    expect(r.billhubException).toEqual([
      {
        group: 'ООО "ТД "ТУЛА-СТАЛЬ"',
        kind: 'приёмка',
        ref: '3',
        reason: `контрагент ООО "ЗМ ГРУПП" (ИНН ${TULA_BH}) — ИНН записи BillHub, имя другое`,
      },
    ]);
  });

  it('группы, ограничение и сокращения', () => {
    expect(r.duplicateLabels).toEqual([]);
    const rep = r.members.find((m) => m.representative);
    expect(rep).toMatchObject({ id: 'bh', representativeWhy: 'BillHub, ИНН верный' });
    expect(r.members.find((m) => m.id === 'dup-su10')).toMatchObject({
      foreignInn: true,
      correctInn: true,
    });
    expect(r.limitation).toHaveLength(1);
    expect(r.abbreviations).toEqual([
      {
        group: 'ООО "ТД "ТУЛА-СТАЛЬ"',
        keys: 'ТД ТУЛА-СТАЛЬ | ТОРГОВЫЙ ДОМ ТУЛА-СТАЛЬ',
        members: 3,
      },
    ]);
  });
});

describe('buildPairCandidates — хвосты под ручные пары (решение 03.11)', () => {
  /** ИНН юрлица с верной контрольной суммой из девяти цифр. */
  const innFrom = (nine: string): string => {
    const w = [2, 4, 10, 3, 5, 9, 4, 6, 8];
    const sum = w.reduce((acc, x, i) => acc + x * Number(nine[i]), 0);
    return `${nine}${(sum % 11) % 10}`;
  };
  let n = 0;
  const row = (
    name: string,
    inn: string,
    extra: Partial<ReportSupplierRow> = {},
  ): ReportSupplierRow => ({
    id: randomUUID(),
    name,
    inn,
    aliases: [],
    billhubId: null,
    createdAt: at(++n),
    ...extra,
  });
  const bh = (name: string, inn: string): ReportSupplierRow =>
    row(name, inn, { billhubId: randomUUID() });

  const tulaBh = bh('ООО "ТД "ТУЛА-СТАЛЬ"', TULA_BH);
  const tula = [
    row('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТУЛА-СТАЛЬ"', '7724595000', { docCount: 6 }),
    row('ООО "ТУЛА-СТАЛЬ"', '7725495001'),
    row('ООО «Тула-Сталь»', '7725495900'),
  ];
  const tulaSb = row('ООО «ТУЛА-СТАЛЬ»', TULA_BH, { lastSecurityStatus: 'approved' });
  const sp1 = bh('ООО "СТРОЙПАРТНЕР"', '7722680372');
  const sp2 = bh('ООО "СТРОЙПАРТНЕР"', '7722680380');
  const spDup = row('ООО "СтройПартнер"', '7726880372');
  const spBoth = row('СТРОЙПАРТНЕР', '7722680382');
  const spNoInn = row('ООО «СТРОЙПАРТНЕР»', '');
  const rows: ReportSupplierRow[] = [
    tulaBh,
    row('ООО «ТОРГОВЫЙ ДОМ «ТУЛА-СТАЛЬ»', SU10),
    ...tula,
    tulaSb,
    sp1,
    sp2,
    spDup,
    spBoth,
    spNoInn,
    bh('ООО "ГК СИЛИНОМ"', innFrom('770000001')),
    bh('ООО "СИЛИНОМ"', innFrom('770000002')),
    row('ООО "ГК БАЗИС"', '5000000001'),
    bh('ООО "БАЗИС"', innFrom('771111111')),
  ];
  const { candidates, rejected } = buildPairCandidates(buildSupplierFilterGroups(rows), rows);

  it('«ТУЛА-СТАЛЬ» без ТД → запись BillHub «ТД ТУЛА-СТАЛЬ»; дубль СТРОЙПАРТНЕР → свой ИНН BillHub', () => {
    expect(
      candidates
        .map((c) => `${c.rule} | ${c.sourceName} → ${c.targetName} ${c.targetInn} (${c.distance})`)
        .sort(),
    ).toEqual(
      [
        `а: ТД X ↔ X | ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ТУЛА-СТАЛЬ" → ООО "ТД "ТУЛА-СТАЛЬ" ${TULA_BH} (1)`,
        `а: ТД X ↔ X | ООО "ТУЛА-СТАЛЬ" → ООО "ТД "ТУЛА-СТАЛЬ" ${TULA_BH} (1)`,
        `а: ТД X ↔ X | ООО «Тула-Сталь» → ООО "ТД "ТУЛА-СТАЛЬ" ${TULA_BH} (1)`,
        'б: остаток тёзок | ООО "СтройПартнер" → ООО "СТРОЙПАРТНЕР" 7722680372 (2)',
      ].sort(),
    );
  });

  it('отклонённые — с причиной', () => {
    const reasons = rejected.map((r) => `${r.source} :: ${r.reason}`);
    expect(reasons).toContain(
      `ООО «ТУЛА-СТАЛЬ» (ИНН ${TULA_BH}) :: у источника статус СБ или комментарий`,
    );
    expect(reasons).toContain(
      'СТРОЙПАРТНЕР (ИНН 7722680382) :: ИНН близок к нескольким записям BillHub',
    );
    expect(reasons).toContain('ООО «СТРОЙПАРТНЕР» (ИНН —) :: нет связи по ИНН');
    expect(reasons).toContain('ООО "ГК СИЛИНОМ" :: обе стороны в BillHub — вероятно, разные фирмы');
    expect(reasons).toContain('ООО "ГК БАЗИС" (ИНН 5000000001) :: нет связи по ИНН');
    expect(candidates.some((c) => /СИЛИНОМ|БАЗИС/.test(c.sourceName))).toBe(false);
  });

  it('CSV: закомментирован целиком; раскомментированное разбирает склейка', () => {
    const csv = pairCandidatesCsv(candidates);
    expect(parseManualPairs(csv)).toEqual({ pairs: [], errors: [] });
    const uncommented = csv
      .split('\n')
      .map((l) => (/^# [0-9a-f-]{36};/.test(l) ? l.slice(2) : l))
      .join('\n');
    const parsed = parseManualPairs(uncommented);
    expect(parsed.errors).toEqual([]);
    expect(parsed.pairs).toEqual(
      candidates.map((c) => ({ sourceId: c.sourceId, targetId: c.targetId })),
    );
  });
});

describe('buildSupplierFilterReportXlsx', () => {
  it('собирает книгу со всеми листами (Excel не пускает «:» и «/» в имя листа)', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildSupplierFilterReportXlsx(
        computeSupplierFilterReport(input()),
      )) as unknown as ArrayBuffer,
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Сводка',
      'Группы',
      'Потери',
      'Добавления',
      'Исключение BillHub',
      'Ограничение',
      'Сокращения',
      'Кандидаты в пары',
      'Пары — отклонено',
    ]);
  });
});
