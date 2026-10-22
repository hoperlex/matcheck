// План импорта поставщиков из BillHub. Чистые функции: на вход строки файла и
// текущее состояние `suppliers`, на выход — что поменять. BillHub — источник
// истины только для своих строк; автосозданные распознаванием строки импорт
// не трогает (их касается склейка, plan-merges.ts).
//
// Идентичность строки BillHub — `suppliers.billhub_id` (миграция 0137): одна
// строка файла соответствует не более чем одной строке базы и наоборот. На
// первом запуске у строк из сида 0055 billhub_id пуст, но их id и есть ID
// BillHub — сопоставляем по id и проставляем billhub_id.

import { collapseSpaces, cleanInn, fixLegalFormTypo, innDigits, mergeAliases } from './names.js';
import type { BillhubSupplier } from './parse.js';

export type SupplierRow = {
  id: string;
  billhubId: string | null;
  inn: string;
  name: string;
  aliases: string[];
  lastSecurityStatus: string | null;
  foundingDocumentsComment: string | null;
  createdAt: Date;
};

export type SupplierPatch = Partial<
  Pick<
    SupplierRow,
    'billhubId' | 'inn' | 'name' | 'aliases' | 'lastSecurityStatus' | 'foundingDocumentsComment'
  >
>;

export type SupplierMatchKind = 'billhub_id' | 'id' | 'inn';

export type SupplierFinding = {
  code:
    | 'file_collision'
    | 'multi_inn'
    | 'id_taken'
    | 'status_downgrade'
    | 'comment_kept'
    | 'aliases_dropped'
    | 'inn_differs';
  rowNo: number;
  billhubId: string;
  dbIds: string[];
  detail: string;
};

export type SupplierMatch = {
  rowNo: number;
  billhubId: string;
  id: string;
  match: SupplierMatchKind;
};

export type SupplierImportPlan = {
  matches: SupplierMatch[];
  /** id строки базы → изменённые поля. Пустые патчи не попадают. */
  updates: Map<string, SupplierPatch>;
  inserts: SupplierRow[];
  /** Новые строки, у которых ИНН из файла очищен до цифр. */
  innCleanedOnInsert: Array<{ id: string; from: string; to: string }>;
  findings: SupplierFinding[];
  /** Состояние справочника после применения плана — для склейки и самопроверки. */
  rowsAfter: SupplierRow[];
};

function normComment(s: string | null): string | null {
  if (s === null) return null;
  const t = s.replace(/\r\n?/g, '\n').trim();
  return t === '' ? null : t;
}

/** Цифры ИНН строки базы для сопоставления (10/12 знаков). */
function dbInnDigits(r: SupplierRow): string | null {
  return innDigits(r.inn);
}

export function planSuppliers(file: BillhubSupplier[], db: SupplierRow[]): SupplierImportPlan {
  const findings: SupplierFinding[] = [];
  const byId = new Map(db.map((r) => [r.id, r]));
  const byBillhub = new Map<string, SupplierRow>();
  for (const r of db) if (r.billhubId) byBillhub.set(r.billhubId, r);

  // 1. Идентичность: billhub_id, на первом запуске — id.
  const claims: SupplierMatch[] = [];
  const identityClaimed = new Set<string>();
  const unmatched: BillhubSupplier[] = [];
  for (const f of file) {
    const byHub = byBillhub.get(f.id);
    if (byHub) {
      claims.push({ rowNo: f.rowNo, billhubId: f.id, id: byHub.id, match: 'billhub_id' });
      identityClaimed.add(byHub.id);
      continue;
    }
    const sameId = byId.get(f.id);
    if (sameId) {
      if (sameId.billhubId === null) {
        claims.push({ rowNo: f.rowNo, billhubId: f.id, id: sameId.id, match: 'id' });
        identityClaimed.add(sameId.id);
      } else {
        findings.push({
          code: 'id_taken',
          rowNo: f.rowNo,
          billhubId: f.id,
          dbIds: [sameId.id],
          detail: `строка базы с этим id уже привязана к BillHub ${sameId.billhubId}`,
        });
      }
      continue;
    }
    unmatched.push(f);
  }

  // 2. По цифрам ИНН — только среди строк без billhub_id, не занятых шагом 1.
  const freeByInn = new Map<string, SupplierRow[]>();
  for (const r of db) {
    if (r.billhubId !== null || identityClaimed.has(r.id)) continue;
    const d = dbInnDigits(r);
    if (!d) continue;
    const list = freeByInn.get(d) ?? [];
    list.push(r);
    freeByInn.set(d, list);
  }
  const toInsert: BillhubSupplier[] = [];
  for (const f of unmatched) {
    const d = innDigits(f.innRaw);
    const candidates = d ? (freeByInn.get(d) ?? []) : [];
    if (candidates.length === 1) {
      claims.push({ rowNo: f.rowNo, billhubId: f.id, id: candidates[0]!.id, match: 'inn' });
    } else if (candidates.length > 1) {
      findings.push({
        code: 'multi_inn',
        rowNo: f.rowNo,
        billhubId: f.id,
        dbIds: candidates.map((c) => c.id),
        detail: `ИНН ${d} есть у ${candidates.length} строк без привязки к BillHub — пропуск`,
      });
    } else {
      toInsert.push(f);
    }
  }

  // 3. Две строки файла на одну запись базы — пропускаем обе.
  const claimCount = new Map<string, number>();
  for (const c of claims) claimCount.set(c.id, (claimCount.get(c.id) ?? 0) + 1);
  const matches: SupplierMatch[] = [];
  for (const c of claims) {
    if ((claimCount.get(c.id) ?? 0) > 1) {
      findings.push({
        code: 'file_collision',
        rowNo: c.rowNo,
        billhubId: c.billhubId,
        dbIds: [c.id],
        detail: 'на эту строку базы претендуют несколько строк файла — пропуск',
      });
    } else {
      matches.push(c);
    }
  }
  // Две новые строки с одним ИНН задвоили бы справочник — тоже пропуск.
  const insertInnCount = new Map<string, number>();
  for (const f of toInsert) {
    const d = innDigits(f.innRaw);
    if (d) insertInnCount.set(d, (insertInnCount.get(d) ?? 0) + 1);
  }

  const fileById = new Map(file.map((f) => [f.id, f]));
  const updates = new Map<string, SupplierPatch>();
  for (const m of matches) {
    const f = fileById.get(m.billhubId)!;
    const r = byId.get(m.id)!;
    const patch = patchFor(f, r, m.match, findings);
    if (Object.keys(patch).length > 0) updates.set(r.id, patch);
  }

  const inserts: SupplierRow[] = [];
  const innCleanedOnInsert: SupplierImportPlan['innCleanedOnInsert'] = [];
  for (const f of toInsert) {
    const d = innDigits(f.innRaw);
    if (d && (insertInnCount.get(d) ?? 0) > 1) {
      findings.push({
        code: 'file_collision',
        rowNo: f.rowNo,
        billhubId: f.id,
        dbIds: [],
        detail: `ИНН ${d} у нескольких новых строк файла — пропуск`,
      });
      continue;
    }
    const name = fixLegalFormTypo(f.name);
    const inn = cleanInn(f.innRaw);
    if (inn !== f.innRaw.trim()) innCleanedOnInsert.push({ id: f.id, from: f.innRaw, to: inn });
    const aliases = mergeAliases([], f.aliases, name);
    if (aliases.dropped.length > 0) {
      findings.push({
        code: 'aliases_dropped',
        rowNo: f.rowNo,
        billhubId: f.id,
        dbIds: [],
        detail: `не влезли алиасы: ${aliases.dropped.join('; ')}`,
      });
    }
    inserts.push({
      id: f.id,
      billhubId: f.id,
      inn,
      name,
      aliases: aliases.aliases,
      lastSecurityStatus: f.securityStatus,
      foundingDocumentsComment: f.comment,
      createdAt: f.createdAt,
    });
  }

  return {
    matches,
    updates,
    inserts,
    innCleanedOnInsert,
    findings,
    rowsAfter: applySupplierChanges(db, updates, inserts, []),
  };
}

function patchFor(
  f: BillhubSupplier,
  r: SupplierRow,
  match: SupplierMatchKind,
  findings: SupplierFinding[],
): SupplierPatch {
  const patch: SupplierPatch = {};
  const finding = (code: SupplierFinding['code'], detail: string) =>
    findings.push({ code, rowNo: f.rowNo, billhubId: f.id, dbIds: [r.id], detail });

  if (r.billhubId !== f.id) patch.billhubId = f.id;

  // Различие только в пробелах — не изменение: BillHub хранит хвостовые
  // пробелы, а повторный запуск должен давать пустой план.
  const fileName = fixLegalFormTypo(f.name);
  const nameChanged = collapseSpaces(fileName) !== collapseSpaces(r.name);
  const name = nameChanged ? fileName : r.name;
  if (nameChanged) patch.name = fileName;

  // Обогащённая по ИНН строка — это написание из документов: сохраняем его
  // алиасом, по нему её находят поиск и нечёткий шаг матчера. Переименование
  // строки, найденной по id, — правка самого BillHub, старое имя не нужно.
  const add = [...f.aliases];
  if (match === 'inn' && nameChanged) add.push(r.name);
  const merged = mergeAliases(r.aliases, add, name);
  if (merged.added.length > 0) patch.aliases = merged.aliases;
  if (merged.dropped.length > 0)
    finding('aliases_dropped', `не влезли алиасы: ${merged.dropped.join('; ')}`);

  // Статус и комментарий из файла пишем только непустые: пустая ячейка
  // BillHub не повод стирать то, что уже есть в справочнике.
  if (f.securityStatus && f.securityStatus !== r.lastSecurityStatus) {
    patch.lastSecurityStatus = f.securityStatus;
    if (r.lastSecurityStatus === 'approved' && f.securityStatus === 'rejected') {
      finding('status_downgrade', 'СБ: Согласован → Отклонён');
    }
  }
  if (f.comment && normComment(f.comment) !== normComment(r.foundingDocumentsComment)) {
    patch.foundingDocumentsComment = f.comment;
  } else if (!f.comment && normComment(r.foundingDocumentsComment)) {
    finding('comment_kept', 'в BillHub комментарий пуст, в справочнике оставлен прежний');
  }

  // ИНН найденной строки не трогаем: от него зависят шаг 1 матчера и фильтры
  // по поставщику. Грязный ИНН строки BillHub чистит склейка, если это не
  // создаёт дубля.
  if (match !== 'inn') {
    const fd = innDigits(f.innRaw) ?? f.innRaw.trim();
    const rd = innDigits(r.inn) ?? r.inn.trim();
    if (fd !== rd) finding('inn_differs', `ИНН в файле «${f.innRaw}», в справочнике «${r.inn}»`);
  }
  return patch;
}

/** Применить изменения к копии справочника (без мутации входа). */
export function applySupplierChanges(
  rows: readonly SupplierRow[],
  updates: ReadonlyMap<string, SupplierPatch>,
  inserts: readonly SupplierRow[],
  deleteIds: readonly string[],
): SupplierRow[] {
  const deleted = new Set(deleteIds);
  const out: SupplierRow[] = [];
  for (const r of rows) {
    if (deleted.has(r.id)) continue;
    const patch = updates.get(r.id);
    out.push(patch ? { ...r, ...patch, aliases: [...(patch.aliases ?? r.aliases)] } : { ...r });
  }
  for (const r of inserts) out.push({ ...r, aliases: [...r.aliases] });
  return out;
}
