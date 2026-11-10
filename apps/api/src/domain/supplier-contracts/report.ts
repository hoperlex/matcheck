// Отчёт импорта договоров 1С (xlsx): что запишется, куда правила разложили
// договоры по объектам, где правила противоречат друг другу, что пропало из
// выгрузки и какие выбранные в приёмках договоры затронет импорт.

import ExcelJS from 'exceljs';
import type { ContractParseIssue, ParsedContract } from './parse.js';
import type { ContractsPlan, ContractsState } from './plan.js';
import { desiredFields, FINGERPRINT_SHOWN } from './plan.js';
import type { RevertResult } from './apply.js';

const STATUS_LABELS: Record<string, string> = {
  exact: 'точно',
  group: 'группа',
  conflict: 'спорный',
  none: 'не определён',
};

const KIND_LABELS: Record<string, string> = {
  supplier: 'С поставщиком',
  buyer: 'С покупателем',
  other: 'Прочее',
};

export type ContractsReportMeta = {
  mode: 'dry-run' | 'apply';
  file: { path: string; sha256: string };
  issues: ContractParseIssue[];
};

function sheet(wb: ExcelJS.Workbook, name: string, columns: Array<{ header: string; key: string; width: number }>) {
  const ws = wb.addWorksheet(name);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return ws;
}

/** Префикс наименования до номера/счёта — «адрес объекта» для листа «не определён». */
function namePrefix(name: string): string {
  const cut = name.split(/,\s*(ДГ|Сч[её]т|Оплата|Договор|Д\/С)|\s+(ДГ|Сч[её]т)\s*№/i)[0] ?? name;
  return cut.replace(/\d+/g, '#').trim().slice(0, 80);
}

export async function buildContractsReportXlsx(
  parsed: readonly ParsedContract[],
  state: ContractsState,
  plan: ContractsPlan,
  meta: ContractsReportMeta,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const codeById = new Map([...state.sitesByCode].map(([code, id]) => [id, code]));

  // Объект по каждой строке файла — тот же расчёт, что в плане.
  const detected = parsed.map((c) => ({ c, d: desiredFields(c, state.sitesByCode) }));
  const supplierRows = detected.filter((x) => x.c.kind === 'supplier');
  const byStatus = new Map<string, number>();
  for (const x of supplierRows) {
    byStatus.set(x.d.fields.siteStatus, (byStatus.get(x.d.fields.siteStatus) ?? 0) + 1);
  }

  const summary = sheet(wb, 'Сводка', [
    { header: 'Показатель', key: 'k', width: 52 },
    { header: 'Значение', key: 'v', width: 70 },
  ]);
  const add = (k: string, v: string | number) => summary.addRow({ k, v });
  add('Режим', meta.mode === 'apply' ? 'запись' : 'dry-run (без записи)');
  add('Файл', meta.file.path);
  add('sha256 файла', meta.file.sha256);
  add('Отпечаток плана (для --confirm)', plan.fingerprint.slice(0, FINGERPRINT_SHOWN));
  add('Строк в файле', parsed.length);
  add('Замечаний разбора', meta.issues.length);
  add('Новые договоры', plan.inserts.length);
  add('Изменённые договоры', plan.updates.filter((u) => u.changed.length > 0).length);
  add('Вернулись в выгрузку', plan.returned);
  add('Пропали из выгрузки (будет отметка)', plan.missing.length);
  add('Без изменений', plan.unchanged);
  add('Живых договоров до импорта', plan.liveBefore);
  add('Массовая пропажа (> 20 %)', plan.massMissing ? 'ДА — нужен --allow-mass-missing' : 'нет');
  add('Затронутые привязки к приёмкам', plan.affectedLinks.length);
  add('Договоров «С поставщиком»', supplierRows.length);
  for (const s of ['exact', 'group', 'conflict', 'none']) {
    const n = byStatus.get(s) ?? 0;
    const pct = supplierRows.length > 0 ? ((n / supplierRows.length) * 100).toFixed(1) : '0';
    add(`  объект: ${STATUS_LABELS[s]}`, `${n} (${pct} %)`);
  }
  if (plan.unknownSiteCodes.size > 0) {
    add(
      'Коды правил, которых нет среди объектов портала',
      [...plan.unknownSiteCodes].map(([c, n]) => `${c}: ${n}`).join(', '),
    );
  }

  // ── Объекты: по коду — число, статус, примеры ──
  const sites = sheet(wb, 'Объекты', [
    { header: 'Объект(ы)', key: 'codes', width: 28 },
    { header: 'Статус', key: 'status', width: 14 },
    { header: 'Договоров', key: 'n', width: 11 },
    { header: 'Примеры наименований', key: 'ex', width: 140 },
  ]);
  const groups = new Map<string, { status: string; n: number; ex: string[] }>();
  for (const x of supplierRows) {
    if (x.d.fields.siteStatus === 'none' || x.d.fields.siteStatus === 'conflict') continue;
    const key = `${x.d.fields.siteStatus}|${x.d.siteCodes.join(', ')}`;
    const g = groups.get(key) ?? { status: x.d.fields.siteStatus, n: 0, ex: [] };
    g.n++;
    if (g.ex.length < 5) g.ex.push(x.c.name);
    groups.set(key, g);
  }
  for (const [key, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
    sites.addRow({ codes: key.split('|')[1], status: STATUS_LABELS[g.status], n: g.n, ex: g.ex.join(' ‖ ') });
  }

  // ── Спорные объекты ──
  const conflicts = sheet(wb, 'Спорные объекты', [
    { header: 'Строка', key: 'row', width: 8 },
    { header: 'Претенденты', key: 'codes', width: 24 },
    { header: 'Правила', key: 'rules', width: 30 },
    { header: 'Контрагент', key: 'cp', width: 36 },
    { header: 'Договор', key: 'name', width: 80 },
    { header: 'Номер', key: 'number', width: 24 },
    { header: 'ОбъектВыполнения', key: 'obj', width: 80 },
  ]);
  for (const x of supplierRows.filter((r) => r.d.fields.siteStatus === 'conflict')) {
    conflicts.addRow({
      row: x.c.rowNo,
      codes: x.d.siteCodes.join(' / '),
      rules: x.d.fields.siteRule ?? '',
      cp: x.c.counterpartyName,
      name: x.c.name,
      number: x.c.number ?? '',
      obj: x.c.objectText ?? '',
    });
  }

  // ── Объект не определён: префиксы ──
  const none = sheet(wb, 'Объект не определён', [
    { header: 'Начало наименования (цифры → #)', key: 'p', width: 90 },
    { header: 'Договоров', key: 'n', width: 11 },
  ]);
  const prefixes = new Map<string, number>();
  for (const x of supplierRows.filter((r) => r.d.fields.siteStatus === 'none')) {
    const p = namePrefix(x.c.name);
    prefixes.set(p, (prefixes.get(p) ?? 0) + 1);
  }
  for (const [p, n] of [...prefixes].sort((a, b) => b[1] - a[1])) none.addRow({ p, n });

  // ── Изменения ──
  const changes = sheet(wb, 'Изменения', [
    { header: 'Строка', key: 'row', width: 8 },
    { header: 'GUID 1С', key: 'onec', width: 38 },
    { header: 'Поле', key: 'field', width: 20 },
    { header: 'Было', key: 'before', width: 70 },
    { header: 'Стало', key: 'after', width: 70 },
  ]);
  const show = (field: string, v: unknown) => {
    if (v === null || v === undefined) return '—';
    if (field === 'siteIds') return (v as string[]).map((id) => codeById.get(id) ?? id).join(', ') || '—';
    if (field === 'kind') return KIND_LABELS[String(v)] ?? String(v);
    if (field === 'siteStatus') return STATUS_LABELS[String(v)] ?? String(v);
    return String(v);
  };
  for (const u of plan.updates) {
    for (const f of u.changed) {
      changes.addRow({ row: u.rowNo, onec: u.onecId, field: f, before: show(f, u.before[f]), after: show(f, u.after[f]) });
    }
    if (u.returnedFrom !== null) {
      changes.addRow({ row: u.rowNo, onec: u.onecId, field: 'вернулся', before: `пропал с ${u.returnedFrom}`, after: 'в выгрузке' });
    }
  }

  // ── Новые ──
  const inserts = sheet(wb, 'Новые', [
    { header: 'Строка', key: 'row', width: 8 },
    { header: 'Контрагент', key: 'cp', width: 36 },
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'Договор', key: 'name', width: 80 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Вид', key: 'kind', width: 16 },
    { header: 'Объект', key: 'site', width: 22 },
    { header: 'Статус объекта', key: 'status', width: 14 },
  ]);
  for (const i of plan.inserts) {
    inserts.addRow({
      row: i.rowNo,
      cp: i.fields.counterpartyName,
      inn: i.fields.counterpartyInn,
      name: i.fields.name,
      date: i.fields.contractDate ?? '',
      kind: KIND_LABELS[i.fields.kind],
      site: i.siteCodes.join(', '),
      status: STATUS_LABELS[i.fields.siteStatus],
    });
  }

  // ── Пропали из выгрузки ──
  const missing = sheet(wb, 'Пропали из выгрузки', [
    { header: 'GUID 1С', key: 'onec', width: 38 },
    { header: 'Контрагент', key: 'cp', width: 40 },
    { header: 'Договор', key: 'name', width: 90 },
  ]);
  for (const m of plan.missing) missing.addRow({ onec: m.onecId, cp: m.counterpartyName, name: m.name });

  // ── Вернулись ──
  const returned = sheet(wb, 'Вернулись', [
    { header: 'Строка', key: 'row', width: 8 },
    { header: 'GUID 1С', key: 'onec', width: 38 },
    { header: 'Пропадал с', key: 'since', width: 26 },
  ]);
  for (const u of plan.updates.filter((x) => x.returnedFrom !== null)) {
    returned.addRow({ row: u.rowNo, onec: u.onecId, since: u.returnedFrom });
  }

  // ── Затронутые привязки ──
  const links = sheet(wb, 'Затронутые привязки', [
    { header: 'Договор', key: 'name', width: 80 },
    { header: 'Что меняется', key: 'reason', width: 14 },
    { header: 'Подробно', key: 'detail', width: 50 },
    { header: 'Приёмки', key: 'deliveries', width: 50 },
  ]);
  const REASONS: Record<string, string> = { kind: 'вид', site: 'объект', missing: 'пропал' };
  for (const a of plan.affectedLinks) {
    links.addRow({ name: a.name, reason: REASONS[a.reason], detail: a.detail, deliveries: a.deliveries.join(', ') });
  }

  // ── Замечания разбора ──
  const issues = sheet(wb, 'Замечания разбора', [
    { header: 'Строка', key: 'row', width: 8 },
    { header: 'Фатально', key: 'fatal', width: 10 },
    { header: 'Код', key: 'code', width: 22 },
    { header: 'Сообщение', key: 'message', width: 60 },
    { header: 'Значение', key: 'value', width: 40 },
  ]);
  for (const i of meta.issues) {
    issues.addRow({ row: i.rowNo, fatal: i.fatal ? 'да' : '', code: i.code, message: i.message, value: i.value ?? '' });
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Отчёт dry-run отката: препятствия с приёмками. */
export async function buildRevertReportXlsx(result: RevertResult, importId: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const s = sheet(wb, 'Откат', [
    { header: 'Показатель', key: 'k', width: 40 },
    { header: 'Значение', key: 'v', width: 60 },
  ]);
  s.addRow({ k: 'Импорт', v: importId });
  s.addRow({ k: 'Отпечаток отката (для --confirm)', v: result.fingerprint.slice(0, FINGERPRINT_SHOWN) });
  s.addRow({ k: 'Вернуть строк в «до»', v: result.restore });
  s.addRow({ k: 'Удалить вставленных договоров', v: result.remove });
  s.addRow({ k: 'Препятствий', v: result.obstacles.length });
  const o = sheet(wb, 'Препятствия', [
    { header: 'Договор (id)', key: 'id', width: 38 },
    { header: 'GUID 1С', key: 'onec', width: 38 },
    { header: 'Причина', key: 'reason', width: 24 },
    { header: 'Подробно', key: 'detail', width: 50 },
    { header: 'Приёмки', key: 'deliveries', width: 40 },
  ]);
  for (const x of result.obstacles) {
    o.addRow({
      id: x.contractId,
      onec: x.onecId,
      reason: x.reason,
      detail: x.detail,
      deliveries: (x.deliveries ?? []).join(', '),
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
