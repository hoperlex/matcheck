// Отчёт импорта справочников (xlsx). Строится после транзакции; доп. данные
// (кандидаты ИНН для новых подрядчиков) читаются отдельно, только чтением.

import ExcelJS from 'exceljs';
import { counterparties } from '../../db/schema.js';
import { fmtDateTimeRu } from '../../lib/xlsx-format.js';
import type { Executor, ImportResult } from './apply.js';
import { companyKey, validInn } from './names.js';
import type { ParseIssue } from './parse.js';
import { DOUBTFUL_LABELS, type MergeSourceClass } from './plan-merges.js';
import { CONTRACTOR_LEVEL_LABELS } from './plan-contractors.js';
import { FINGERPRINT_SHOWN } from './plan.js';

const FIELD_LABELS: Record<string, string> = {
  billhubId: 'ID BillHub',
  inn: 'ИНН',
  name: 'Название',
  aliases: 'Алиасы',
  lastSecurityStatus: 'Статус СБ',
  foundingDocumentsComment: 'Комментарий',
};

const MATCH_LABELS: Record<string, string> = {
  billhub_id: 'по ID BillHub',
  id: 'по id (сид 0055)',
  inn: 'по ИНН (обогащение)',
};

const STATUS_LABELS: Record<string, string> = { approved: 'Согласован', rejected: 'Отклонён' };

const MERGE_CLASS_LABELS: Record<MergeSourceClass, string> = {
  same_inn: 'те же цифры ИНН',
  one_edit: 'ИНН с одной ошибкой',
  near_inn_name: 'ИНН с одной ошибкой, имя с опечаткой',
  manual: 'ручная пара',
};

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export type ReportExtras = {
  /** Ключ новой строки подрядчика → кандидаты ИНН по точному companyKey. */
  contractorInnCandidates: Map<string, string[]>;
};

export type ReportMeta = {
  mode: 'dry-run' | 'apply';
  files: Array<{ label: string; path: string; sha256: string }>;
  issues: ParseIssue[];
};

/** Кандидаты ИНН для новых подрядчиков: поставщики и операционные контрагенты с тем же ключом имени. */
export async function collectReportExtras(ex: Executor, r: ImportResult): Promise<ReportExtras> {
  const contractorInnCandidates = new Map<string, string[]>();
  const inserts = (r.plan.contractors?.inserts ?? []).filter((i) => !i.inn);
  if (inserts.length === 0) return { contractorInnCandidates };
  const op = await ex
    .select({ inn: counterparties.inn, name: counterparties.name })
    .from(counterparties);
  const byKey = new Map<string, Set<string>>();
  const add = (name: string, inn: string, source: string) => {
    const v = validInn(inn);
    if (!v) return;
    const key = companyKey(name);
    const set = byKey.get(key) ?? new Set<string>();
    set.add(`${v} (${source}: ${name.trim()})`);
    byKey.set(key, set);
  };
  for (const s of r.state.suppliers) add(s.name, s.inn, 'поставщики');
  for (const c of op) add(c.name, c.inn ?? '', 'операционные');
  for (const i of inserts) {
    const found = byKey.get(companyKey(i.name));
    if (found) contractorInnCandidates.set(i.key, [...found]);
  }
  return { contractorInnCandidates };
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join('; ');
  if (typeof v === 'string' && STATUS_LABELS[v]) return STATUS_LABELS[v]!;
  return String(v);
}

export async function buildImportReportXlsx(
  r: ImportResult,
  extras: ReportExtras,
  meta: ReportMeta,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };
  const bold = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true };
  };
  const supById = new Map(r.state.suppliers.map((s) => [s.id, s]));
  const ccById = new Map(r.state.contractors.map((c) => [c.id, c]));
  const sp = r.plan.suppliers;
  const mp = r.plan.merges;
  const cp = r.plan.contractors;

  // ─── Сводка ───
  const summary = wb.addWorksheet('Сводка');
  summary.columns = [
    { header: 'Показатель', key: 'k', width: 52 },
    { header: 'Значение', key: 'v', width: 70 },
  ];
  const mergedDocs = (mp?.merges ?? []).reduce(
    (n, m) => n + m.sources.reduce((k, s) => k + (r.docs.bySource.get(s.id)?.length ?? 0), 0),
    0,
  );
  const lines: Array<[string, unknown]> = [
    ['Режим', meta.mode === 'apply' ? 'ЗАПИСЬ' : 'dry-run (без записи)'],
    ['Отпечаток плана', r.plan.fingerprint.slice(0, FINGERPRINT_SHOWN)],
    ['Отпечаток полностью', r.plan.fingerprint],
    ...meta.files.map((f): [string, unknown] => [
      `Файл: ${f.label}`,
      `${f.path} (sha256 ${f.sha256.slice(0, 16)}…)`,
    ]),
    ['Колонка billhub_id (миграция 0137)', r.billhubColumn ? 'есть' : 'нет — считается пустой'],
    ['Всего операций', r.plan.opCount],
    ['Поставщиков в базе до', r.state.suppliers.length],
    [
      'Поставщики: найдено по ID BillHub / id / ИНН',
      sp
        ? `${sp.matches.filter((m) => m.match === 'billhub_id').length} / ${sp.matches.filter((m) => m.match === 'id').length} / ${sp.matches.filter((m) => m.match === 'inn').length}`
        : '—',
    ],
    ['Поставщики: изменяется строк', r.plan.supplierUpdates.size],
    ['Поставщики: новых', r.plan.supplierInserts.length],
    [
      'Склейка: групп / удаляется дублей / документов перепривязать',
      `${mp?.merges.length ?? 0} / ${r.plan.supplierDeletes.length} / ${mergedDocs}`,
    ],
    ['Склейка: сомнительных записей (не тронуты)', mp?.doubtful.length ?? 0],
    ['Ручные пары: не выполнено', mp?.pairIssues.length ?? 0],
    ['Грязный ИНН очищается у строк BillHub', mp?.innCleanups.length ?? 0],
    [
      'Поставщиков в базе после',
      r.state.suppliers.length + r.plan.supplierInserts.length - r.plan.supplierDeletes.length,
    ],
    ['Документы: сигнал планшету (в окне 90 дней)', r.docs.touchIds.length],
    ['Документы старше окна (имя на планшете — при след. изменении)', r.docs.outsideWindow],
    [
      'Подрядчики: найдено / неоднозначно / по инициалам',
      cp ? `${cp.matches.length} / ${cp.ambiguous.length} / ${cp.initialsCandidates.length}` : '—',
    ],
    [
      'Подрядчики: новых / с добавленным алиасом',
      cp ? `${cp.inserts.length} / ${cp.aliasUpdates.size}` : '—',
    ],
    [
      'Подрядчиков в базе до → после',
      `${r.state.contractors.length} → ${r.state.contractors.length + (cp?.inserts.length ?? 0)}`,
    ],
    ['Ошибки разбора (не фатальные)', meta.issues.filter((i) => !i.fatal).length],
  ];
  if (r.timings) {
    lines.push(
      ['Ожидание блокировок, мс', r.timings.lockWaitMs],
      ['Удержание блокировок, мс', r.timings.lockHeldMs],
    );
  }
  for (const [k, v] of lines) summary.addRow({ k, v: show(v) });
  bold(summary);

  // ─── Поставщики: изменения ───
  const changes = wb.addWorksheet('Поставщики — изменения', frozen);
  changes.columns = [
    { header: 'id', key: 'id', width: 38 },
    { header: 'Как найдена', key: 'match', width: 22 },
    { header: 'Название сейчас', key: 'name', width: 40 },
    { header: 'Поле', key: 'field', width: 14 },
    { header: 'Было', key: 'before', width: 50 },
    { header: 'Станет', key: 'after', width: 50 },
  ];
  const matchById = new Map((sp?.matches ?? []).map((m) => [m.id, m.match]));
  for (const [id, patch] of r.plan.supplierUpdates) {
    const row = supById.get(id);
    for (const [field, after] of Object.entries(patch)) {
      changes.addRow({
        id,
        match: MATCH_LABELS[matchById.get(id) ?? ''] ?? 'цель склейки',
        name: row?.name,
        field: FIELD_LABELS[field] ?? field,
        before: show(row?.[field as keyof typeof row]),
        after: show(after),
      });
    }
  }
  bold(changes);

  // ─── Поставщики: новые ───
  const inserted = wb.addWorksheet('Поставщики — новые', frozen);
  inserted.columns = [
    { header: 'ID BillHub', key: 'id', width: 38 },
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'ИНН в файле', key: 'innRaw', width: 18 },
    { header: 'Название', key: 'name', width: 44 },
    { header: 'Статус СБ', key: 'st', width: 12 },
    { header: 'Алиасы', key: 'aliases', width: 50 },
    { header: 'Создан в BillHub', key: 'created', width: 18 },
  ];
  const cleaned = new Map((sp?.innCleanedOnInsert ?? []).map((c) => [c.id, c.from]));
  for (const s of r.plan.supplierInserts) {
    inserted.addRow({
      id: s.id,
      inn: s.inn,
      innRaw: cleaned.get(s.id) ?? '',
      name: s.name,
      st: show(s.lastSecurityStatus),
      aliases: show(s.aliases),
      // fmtDateTimeRu печатает UTC; в BillHub время московское.
      created: `${fmtDateTimeRu(new Date(s.createdAt.getTime() + MSK_OFFSET_MS))} МСК`,
    });
  }
  bold(inserted);

  // ─── Склейка ───
  const merged = wb.addWorksheet('Поставщики — склейка', frozen);
  merged.columns = [
    { header: 'Ключ имени', key: 'key', width: 30 },
    { header: 'Остаётся: id', key: 'tid', width: 38 },
    { header: 'Остаётся: название', key: 'tname', width: 40 },
    { header: 'Остаётся: ИНН', key: 'tinn', width: 14 },
    { header: 'Удаляется: id', key: 'sid', width: 38 },
    { header: 'Удаляется: название', key: 'sname', width: 40 },
    { header: 'Удаляется: ИНН', key: 'sinn', width: 14 },
    { header: 'Основание', key: 'cls', width: 22 },
    { header: 'Документов', key: 'docs', width: 11 },
  ];
  // Без файла BillHub (--merges-only) склейка идёт по строкам базы как есть.
  const rowsAfterImport = new Map((sp?.rowsAfter ?? r.state.suppliers).map((s) => [s.id, s]));
  for (const m of mp?.merges ?? []) {
    const t = rowsAfterImport.get(m.targetId);
    for (const s of m.sources) {
      merged.addRow({
        key: m.key,
        tid: m.targetId,
        tname: t?.name,
        tinn: t?.inn,
        sid: s.id,
        sname: s.name,
        sinn: show(s.inn),
        cls: MERGE_CLASS_LABELS[s.class],
        docs: r.docs.bySource.get(s.id)?.length ?? 0,
      });
    }
  }
  bold(merged);

  // ─── Сомнительные дубли ───
  const doubtful = wb.addWorksheet('Поставщики — сомнительные', frozen);
  doubtful.columns = [
    { header: 'Ключ имени', key: 'key', width: 30 },
    { header: 'Причина', key: 'reason', width: 44 },
    { header: 'id', key: 'id', width: 38 },
    { header: 'Название', key: 'name', width: 44 },
    { header: 'ИНН', key: 'inn', width: 16 },
    { header: 'Из BillHub', key: 'hub', width: 11 },
    { header: 'Документов', key: 'docs', width: 11 },
    { header: 'Возможная цель', key: 'target', width: 44 },
  ];
  for (const d of mp?.doubtful ?? []) {
    const target = d.targetId ? rowsAfterImport.get(d.targetId) : null;
    for (const id of d.ids) {
      const s = rowsAfterImport.get(id);
      doubtful.addRow({
        key: d.key,
        reason: DOUBTFUL_LABELS[d.reason],
        id,
        name: s?.name,
        inn: show(s?.inn),
        hub: s?.billhubId ? 'да' : '',
        docs: r.state.docCounts.get(id) ?? 0,
        target: target ? `${target.name} (${target.inn})` : '',
      });
    }
  }
  bold(doubtful);

  // ─── Ручные пары, которые не выполняются ───
  const pairIssues = wb.addWorksheet('Поставщики — ручные пары', frozen);
  pairIssues.columns = [
    { header: 'Источник: id', key: 'sid', width: 38 },
    { header: 'Источник: название', key: 'sname', width: 40 },
    { header: 'Цель: id', key: 'tid', width: 38 },
    { header: 'Цель: название', key: 'tname', width: 40 },
    { header: 'Почему не выполнена', key: 'problem', width: 48 },
  ];
  for (const p of mp?.pairIssues ?? []) {
    pairIssues.addRow({
      sid: p.sourceId,
      sname: (rowsAfterImport.get(p.sourceId) ?? supById.get(p.sourceId))?.name,
      tid: p.targetId,
      tname: (rowsAfterImport.get(p.targetId) ?? supById.get(p.targetId))?.name,
      problem: p.problem,
    });
  }
  bold(pairIssues);

  // ─── Находки импорта ───
  const findings = wb.addWorksheet('Поставщики — находки', frozen);
  findings.columns = [
    { header: 'Строка файла', key: 'row', width: 12 },
    { header: 'ID BillHub', key: 'hub', width: 38 },
    { header: 'Код', key: 'code', width: 18 },
    { header: 'Строки базы', key: 'db', width: 40 },
    { header: 'Подробности', key: 'detail', width: 70 },
  ];
  for (const f of sp?.findings ?? []) {
    findings.addRow({
      row: f.rowNo,
      hub: f.billhubId,
      code: f.code,
      db: f.dbIds.join(', '),
      detail: f.detail,
    });
  }
  bold(findings);

  // ─── Подрядчики ───
  const ccName = (id: string) => {
    const c = ccById.get(id);
    return c ? `${c.name} (ИНН ${c.inn || '—'})` : id;
  };
  const ccMatched = wb.addWorksheet('Подрядчики — найдены', frozen);
  ccMatched.columns = [
    { header: 'В 1С', key: 'raw', width: 44 },
    { header: 'Как найден', key: 'via', width: 30 },
    { header: 'В справочнике', key: 'cc', width: 50 },
    { header: 'Добавлен алиас', key: 'alias', width: 14 },
  ];
  for (const m of cp?.matches ?? []) {
    const added =
      cp?.aliasUpdates.get(m.id)?.includes(m.raw) && !ccById.get(m.id)?.aliases.includes(m.raw);
    ccMatched.addRow({
      raw: m.raw,
      via: CONTRACTOR_LEVEL_LABELS[m.via],
      cc: ccName(m.id),
      alias: added ? 'да' : '',
    });
  }
  bold(ccMatched);

  const ccInitials = wb.addWorksheet('Подрядчики — по инициалам', frozen);
  ccInitials.columns = [
    { header: 'В 1С', key: 'raw', width: 44 },
    { header: 'Кандидаты в справочнике (решить вручную)', key: 'cand', width: 80 },
  ];
  for (const c of cp?.initialsCandidates ?? []) {
    ccInitials.addRow({ raw: c.raw, cand: c.candidateIds.map(ccName).join('; ') });
  }
  bold(ccInitials);

  const ccAmbiguous = wb.addWorksheet('Подрядчики — неоднозначные', frozen);
  ccAmbiguous.columns = [
    { header: 'В 1С', key: 'raw', width: 44 },
    { header: 'Уровень', key: 'level', width: 30 },
    { header: 'Кандидаты', key: 'cand', width: 90 },
  ];
  for (const a of cp?.ambiguous ?? []) {
    ccAmbiguous.addRow({
      raw: a.raw,
      level: CONTRACTOR_LEVEL_LABELS[a.level],
      cand: a.candidateIds.map(ccName).join('; '),
    });
  }
  bold(ccAmbiguous);

  const ccNew = wb.addWorksheet('Подрядчики — новые', frozen);
  ccNew.columns = [
    { header: 'Название', key: 'name', width: 40 },
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'Алиасы', key: 'aliases', width: 44 },
    { header: 'Кандидаты ИНН (проверить и вписать вручную)', key: 'cand', width: 90 },
  ];
  for (const i of cp?.inserts ?? []) {
    ccNew.addRow({
      name: i.name,
      inn: show(i.inn),
      aliases: show(i.aliases),
      cand: (extras.contractorInnCandidates.get(i.key) ?? []).join('; '),
    });
  }
  bold(ccNew);

  const issues = wb.addWorksheet('Ошибки разбора', frozen);
  issues.columns = [
    { header: 'Строка', key: 'row', width: 8 },
    { header: 'Фатальная', key: 'fatal', width: 10 },
    { header: 'Код', key: 'code', width: 18 },
    { header: 'Сообщение', key: 'msg', width: 60 },
    { header: 'Значение', key: 'value', width: 50 },
  ];
  for (const i of meta.issues) {
    issues.addRow({
      row: i.rowNo,
      fatal: i.fatal ? 'да' : '',
      code: i.code,
      msg: i.message,
      value: i.value ?? '',
    });
  }
  bold(issues);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
