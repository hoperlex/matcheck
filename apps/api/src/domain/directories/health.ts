// Отчёт о состоянии справочников поставщиков и подрядчиков
// (scripts/directories-health-report.ts). Только чтение.
//
// Рабочий лист для человека, а не автоматика: кого добавить в «Контрагенты»,
// какой ИНН вписать записи без ИНН, какие записи битые, где в операционной
// таблице под одним ИНН лежат разные имена. Решение по каждой строке — за
// человеком: часть «покупателей» в документах — поставщики, которых модель
// прочла не в той графе (ТУЛА-СТАЛЬ — 99 раз поставщик), поэтому ничего не
// добавляется и не правится само.

import ExcelJS from 'exceljs';
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { normalizeInn } from '../sourceDocuments/resolve-contractor.js';
import { loadOwnInns } from '../sourceDocuments/supplier-inn-check.js';
import { companyKey } from './names.js';
import { pickOperationalCounterparty } from './operational-pick.js';

export type PartySide = {
  inn: string | null;
  name: string | null;
  role: 'buyer' | 'consignee';
  documentId: string;
  siteId: string | null;
  createdAt: Date;
};

export type CcRecord = { id: string; name: string; inn: string; aliases: string[] };

export type InnSuggestion = {
  id: string;
  name: string;
  inn: string;
  hits: number;
  total: number;
  otherInns: string[];
  /** ИНН уже стоит у другой записи «Контрагентов». */
  takenBy: string | null;
};

export type ContractorCandidate = {
  inn: string;
  name: string;
  asBuyer: number;
  asConsignee: number;
  docs: number;
  sites: number;
  asSupplier: number;
  inBillhub: boolean;
  lastAt: Date;
};

function keysOf(name: string, aliases: readonly string[] = []): Set<string> {
  return new Set([name, ...aliases].map(companyKey).filter((k) => k !== ''));
}

/**
 * ИНН для записи «Контрагентов» без ИНН — по сторонам документов с тем же
 * именем (без формы, кавычек и регистра). Берётся самый частый корректный
 * ИНН; доля и остальные варианты видны в отчёте, решает человек.
 */
export function suggestContractorInns(
  cc: readonly CcRecord[],
  sides: readonly PartySide[],
  ownInns: ReadonlySet<string>,
): InnSuggestion[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const s of sides) {
    const inn = normalizeInn(s.inn);
    const key = s.name ? companyKey(s.name) : '';
    if (!inn || !key || ownInns.has(inn)) continue;
    const counts = byKey.get(key) ?? new Map<string, number>();
    counts.set(inn, (counts.get(inn) ?? 0) + 1);
    byKey.set(key, counts);
  }
  const ccByInn = new Map<string, string>();
  for (const c of cc) {
    const inn = normalizeInn(c.inn);
    if (inn && !ccByInn.has(inn)) ccByInn.set(inn, c.name);
  }

  const out: InnSuggestion[] = [];
  for (const c of cc) {
    if (c.inn.trim() !== '') continue;
    const merged = new Map<string, number>();
    for (const key of keysOf(c.name, c.aliases)) {
      for (const [inn, n] of byKey.get(key) ?? []) merged.set(inn, (merged.get(inn) ?? 0) + n);
    }
    if (merged.size === 0) continue;
    const ranked = [...merged].sort(([ia, a], [ib, b]) => b - a || ia.localeCompare(ib));
    const [inn, hits] = ranked[0]!;
    out.push({
      id: c.id,
      name: c.name,
      inn,
      hits,
      total: ranked.reduce((n, [, v]) => n + v, 0),
      otherInns: ranked.slice(1).map(([i, n]) => `${i} (${n})`),
      takenBy: ccByInn.get(inn) ?? null,
    });
  }
  return out.sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
}

/**
 * Организации, которые часто стоят покупателем или грузополучателем, но не
 * числятся в «Контрагентах». Свои ИНН и битые ИНН не берутся.
 */
export function contractorCandidates(
  sides: readonly PartySide[],
  opts: {
    ccInns: ReadonlySet<string>;
    ownInns: ReadonlySet<string>;
    billhubInns: ReadonlySet<string>;
    asSupplier: ReadonlyMap<string, number>;
    minDocs: number;
  },
): ContractorCandidate[] {
  type Acc = {
    names: Map<string, number>;
    buyerDocs: Set<string>;
    consigneeDocs: Set<string>;
    docs: Set<string>;
    sites: Set<string>;
    lastAt: Date;
  };
  const acc = new Map<string, Acc>();
  for (const s of sides) {
    const inn = normalizeInn(s.inn);
    if (!inn || opts.ownInns.has(inn) || opts.ccInns.has(inn)) continue;
    const a = acc.get(inn) ?? {
      names: new Map<string, number>(),
      buyerDocs: new Set<string>(),
      consigneeDocs: new Set<string>(),
      docs: new Set<string>(),
      sites: new Set<string>(),
      lastAt: s.createdAt,
    };
    if (s.name) a.names.set(s.name, (a.names.get(s.name) ?? 0) + 1);
    (s.role === 'buyer' ? a.buyerDocs : a.consigneeDocs).add(s.documentId);
    a.docs.add(s.documentId);
    if (s.siteId) a.sites.add(s.siteId);
    if (s.createdAt > a.lastAt) a.lastAt = s.createdAt;
    acc.set(inn, a);
  }
  const out: ContractorCandidate[] = [];
  for (const [inn, a] of acc) {
    if (a.docs.size < opts.minDocs) continue;
    const name =
      [...a.names].sort(([na, x], [nb, y]) => y - x || na.localeCompare(nb))[0]?.[0] ?? '';
    out.push({
      inn,
      name,
      asBuyer: a.buyerDocs.size,
      asConsignee: a.consigneeDocs.size,
      docs: a.docs.size,
      sites: a.sites.size,
      asSupplier: opts.asSupplier.get(inn) ?? 0,
      inBillhub: opts.billhubInns.has(inn),
      lastAt: a.lastAt,
    });
  }
  return out.sort((a, b) => b.docs - a.docs || a.inn.localeCompare(b.inn));
}

type OpRow = {
  id: string;
  inn: string;
  kpp: string | null;
  name: string;
  createdAt: Date;
  contractorRefs: number;
  docRefs: number;
};

export type HealthData = {
  days: number;
  ownInns: string[];
  candidates: ContractorCandidate[];
  innSuggestions: InnSuggestion[];
  ccProblems: Array<{ id: string; name: string; inn: string; problem: string }>;
  supplierConflicts: Array<{
    id: string;
    name: string;
    inn: string;
    whose: string;
    docs: number;
  }>;
  operational: Array<{
    inn: string;
    ccName: string | null;
    rows: Array<OpRow & { picked: boolean }>;
  }>;
};

function rowsOf<T>(res: Iterable<unknown>): T[] {
  return [...res] as T[];
}

export async function collectDirectoriesHealth(
  db: Db,
  opts: { days: number; minDocs: number },
): Promise<HealthData> {
  const own = await loadOwnInns(db);

  const sideRows = rowsOf<{
    document_id: string;
    site_id: string | null;
    created_at: Date;
    buyer_inn: string | null;
    buyer_name: string | null;
    consignee_inn: string | null;
    consignee_name: string | null;
  }>(
    await db.execute(sql`
      select id as document_id, site_id, created_at,
             buyer_inn_raw as buyer_inn, buyer_name_raw as buyer_name,
             consignee_inn_raw as consignee_inn, consignee_name_raw as consignee_name
        from source_documents
       where is_technical = false
         and (buyer_inn_raw is not null or buyer_name_raw is not null
              or consignee_inn_raw is not null or consignee_name_raw is not null)
    `),
  );
  const since = Date.now() - opts.days * 24 * 60 * 60 * 1000;
  const allSides: PartySide[] = [];
  for (const r of sideRows) {
    const createdAt = new Date(r.created_at);
    for (const role of ['buyer', 'consignee'] as const) {
      const inn = role === 'buyer' ? r.buyer_inn : r.consignee_inn;
      const name = role === 'buyer' ? r.buyer_name : r.consignee_name;
      if (!inn && !name) continue;
      allSides.push({ inn, name, role, documentId: r.document_id, siteId: r.site_id, createdAt });
    }
  }
  const recentSides = allSides.filter((s) => s.createdAt.getTime() >= since);

  const cc = rowsOf<CcRecord>(
    await db.execute(sql`
      select id, name, coalesce(inn, '') as inn, coalesce(aliases, '{}') as aliases
        from customer_counterparties order by name, id
    `),
  );
  const ccInns = new Set(cc.map((c) => normalizeInn(c.inn)).filter((v): v is string => v !== null));

  const supplierRows = rowsOf<{ id: string; name: string; inn: string; billhub: boolean }>(
    await db.execute(sql`
      select id, name, inn, billhub_id is not null as billhub from suppliers
    `),
  );
  const billhubInns = new Set(
    supplierRows
      .filter((s) => s.billhub)
      .map((s) => normalizeInn(s.inn))
      .filter((v): v is string => v !== null),
  );

  const supplierInnRows = rowsOf<{ inn: string | null; n: number }>(
    await db.execute(sql`
      select coalesce(nullif(d.supplier_inn_raw, ''), s.inn) as inn, count(*)::int as n
        from source_documents d
        left join suppliers s on s.id = d.supplier_directory_id
       where d.is_technical = false
         and d.created_at >= now() - make_interval(days => ${opts.days})
       group by 1
    `),
  );
  const asSupplier = new Map<string, number>();
  for (const r of supplierInnRows) {
    const inn = normalizeInn(r.inn);
    if (inn) asSupplier.set(inn, (asSupplier.get(inn) ?? 0) + Number(r.n));
  }

  const candidates = contractorCandidates(recentSides, {
    ccInns,
    ownInns: own,
    billhubInns,
    asSupplier,
    minDocs: opts.minDocs,
  });
  const innSuggestions = suggestContractorInns(cc, allSides, own);

  const ccProblems: HealthData['ccProblems'] = [];
  const ccInnSeen = new Map<string, string>();
  for (const c of cc) {
    const raw = c.inn.trim();
    const inn = normalizeInn(raw);
    if (raw && !inn) ccProblems.push({ ...c, problem: 'ИНН не проходит проверку' });
    if (inn && own.has(inn)) ccProblems.push({ ...c, problem: 'своя организация' });
    if (inn && ccInnSeen.has(inn)) {
      ccProblems.push({ ...c, problem: `тот же ИНН, что у «${ccInnSeen.get(inn)}»` });
    }
    if (inn && !ccInnSeen.has(inn)) ccInnSeen.set(inn, c.name);
  }

  const docCounts = new Map(
    rowsOf<{ id: string; n: number }>(
      await db.execute(sql`
        select supplier_directory_id as id, count(*)::int as n from source_documents
         where supplier_directory_id is not null group by 1
      `),
    ).map((r) => [r.id, Number(r.n)]),
  );
  const supplierConflicts: HealthData['supplierConflicts'] = [];
  for (const s of supplierRows) {
    if (s.billhub) continue;
    const inn = normalizeInn(s.inn);
    if (!inn) continue;
    const whose = own.has(inn)
      ? 'своя организация'
      : ccInns.has(inn)
        ? `подрядчик «${ccInnSeen.get(inn)}»`
        : null;
    if (whose) supplierConflicts.push({ ...s, whose, docs: docCounts.get(s.id) ?? 0 });
  }
  supplierConflicts.sort((a, b) => b.docs - a.docs || a.name.localeCompare(b.name));

  const opRows = rowsOf<OpRow>(
    await db.execute(sql`
      select c.id, c.inn, c.kpp, c.name, c.created_at as "createdAt",
             (select count(*)::int from deliveries d where d.contractor_id = c.id) as "contractorRefs",
             (select count(*)::int from source_documents s
               where c.id in (s.supplier_id, s.buyer_id, s.consignee_id, s.recipient_id, s.contractor_id))
               as "docRefs"
        from counterparties c
       where c.inn in (select inn from counterparties group by inn having count(*) > 1)
       order by c.inn, c.created_at, c.id
    `),
  );
  const ccByInn = new Map<string, CcRecord>();
  for (const c of cc) {
    const inn = normalizeInn(c.inn);
    if (inn && !ccByInn.has(inn)) ccByInn.set(inn, c);
  }
  const groups = new Map<string, OpRow[]>();
  for (const r of opRows) {
    const row = { ...r, createdAt: new Date(r.createdAt) };
    groups.set(r.inn, [...(groups.get(r.inn) ?? []), row]);
  }
  const operational: HealthData['operational'] = [];
  for (const [inn, rows] of groups) {
    if (new Set(rows.map((r) => companyKey(r.name))).size < 2) continue;
    const dir = ccByInn.get(inn) ?? null;
    const picked = dir
      ? pickOperationalCounterparty(
          rows,
          dir,
          new Map(rows.map((r) => [r.id, Number(r.contractorRefs)])),
        )
      : undefined;
    operational.push({
      inn,
      ccName: dir?.name ?? null,
      rows: rows.map((r) => ({ ...r, picked: r.id === picked?.id })),
    });
  }
  operational.sort((a, b) => Number(b.ccName !== null) - Number(a.ccName !== null));

  return {
    days: opts.days,
    ownInns: [...own],
    candidates,
    innSuggestions,
    ccProblems,
    supplierConflicts,
    operational,
  };
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

function mskDate(d: Date): string {
  return new Date(d.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}

export async function buildHealthReportXlsx(h: HealthData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };
  const sheet = (title: string, columns: Partial<ExcelJS.Column>[]) => {
    const ws = wb.addWorksheet(title, frozen);
    ws.columns = columns;
    ws.getRow(1).font = { bold: true };
    return ws;
  };

  const cand = sheet('Кандидаты в подрядчики', [
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'Название (чаще всего)', key: 'name', width: 50 },
    { header: 'Документов', key: 'docs', width: 11 },
    { header: 'Покупатель', key: 'buyer', width: 11 },
    { header: 'Грузополучатель', key: 'consignee', width: 15 },
    { header: 'Объектов', key: 'sites', width: 10 },
    { header: `Поставщик (${h.days} дн.)`, key: 'supplier', width: 15 },
    { header: 'Есть в BillHub', key: 'billhub', width: 13 },
    { header: 'Последний документ', key: 'last', width: 18 },
    { header: 'Добавить? (решение)', key: 'decision', width: 20 },
  ]);
  for (const c of h.candidates) {
    cand.addRow({
      inn: c.inn,
      name: c.name,
      docs: c.docs,
      buyer: c.asBuyer,
      consignee: c.asConsignee,
      sites: c.sites,
      supplier: c.asSupplier,
      billhub: c.inBillhub ? 'да' : '',
      last: mskDate(c.lastAt),
    });
  }

  const sug = sheet('ИНН для записей без ИНН', [
    { header: 'id записи', key: 'id', width: 38 },
    { header: 'Название в «Контрагентах»', key: 'name', width: 44 },
    { header: 'ИНН по документам', key: 'inn', width: 16 },
    { header: 'Совпадений', key: 'hits', width: 11 },
    { header: 'Всего с этим именем', key: 'total', width: 18 },
    { header: 'Другие ИНН', key: 'other', width: 34 },
    { header: 'ИНН уже у записи', key: 'taken', width: 34 },
  ]);
  for (const s of h.innSuggestions) {
    sug.addRow({
      id: s.id,
      name: s.name,
      inn: s.inn,
      hits: s.hits,
      total: s.total,
      other: s.otherInns.join(', '),
      taken: s.takenBy ?? '',
    });
  }

  const ccp = sheet('Контрагенты — ошибки', [
    { header: 'id записи', key: 'id', width: 38 },
    { header: 'Название', key: 'name', width: 44 },
    { header: 'ИНН', key: 'inn', width: 16 },
    { header: 'Что не так', key: 'problem', width: 44 },
  ]);
  for (const p of h.ccProblems) ccp.addRow(p);

  const sc = sheet('Поставщики — свои и подрядчики', [
    { header: 'id записи', key: 'id', width: 38 },
    { header: 'Название', key: 'name', width: 44 },
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'Чей ИНН', key: 'whose', width: 40 },
    { header: 'Документов', key: 'docs', width: 11 },
  ]);
  for (const s of h.supplierConflicts) sc.addRow(s);

  const op = sheet('Операционные — разные имена', [
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'В «Контрагентах»', key: 'cc', width: 36 },
    { header: 'id строки', key: 'id', width: 38 },
    { header: 'Название строки', key: 'name', width: 40 },
    { header: 'КПП', key: 'kpp', width: 11 },
    { header: 'Приёмок с получателем', key: 'refs', width: 20 },
    { header: 'Ссылок из документов', key: 'docs', width: 19 },
    { header: 'Выберет «Подставить»', key: 'picked', width: 20 },
  ]);
  for (const g of h.operational) {
    for (const r of g.rows) {
      op.addRow({
        inn: g.inn,
        cc: g.ccName ?? '',
        id: r.id,
        name: r.name,
        kpp: r.kpp ?? '',
        refs: Number(r.contractorRefs),
        docs: Number(r.docRefs),
        picked: r.picked ? 'да' : '',
      });
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
