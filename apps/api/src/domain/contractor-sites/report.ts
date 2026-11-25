// Отчёт импорта связей «подрядчик × объект» (xlsx): что записывается, кого и
// что не удалось сопоставить — для ручной правки в карточке контрагента.

import ExcelJS from 'exceljs';
import { CONTRACTOR_SITE_KIND_LABELS } from '@matcheck/contracts';
import type { ImportResult } from './apply.js';
import type { ContractorSiteIssue } from './parse.js';
import {
  CONTRACTOR_LINK_LABELS,
  FINGERPRINT_SHOWN,
  type FileTarget,
  type OnecLayer,
  type OpType,
} from './plan.js';

const OP_LABELS: Record<OpType, string> = {
  insert: 'новая связь',
  update: 'обновятся данные 1С',
  clear: 'пары нет в файле — данные 1С снимаются, ручной вид остаётся',
  delete: 'пары нет в файле — связь удаляется',
};

export type ReportMeta = {
  mode: 'dry-run' | 'apply';
  file: { path: string; sha256: string } | null;
  issues: ContractorSiteIssue[];
};

function layerText(l: OnecLayer | null): string {
  if (!l) return '—';
  return (
    `${CONTRACTOR_SITE_KIND_LABELS[l.kind]}: реал. ${l.realizationDocs} на ${l.realizationSum}, ` +
    `дав. ${l.tollingDocs} на ${l.tollingSum}`
  );
}

export async function buildContractorSitesReportXlsx(
  r: ImportResult<FileTarget>,
  meta: ReportMeta,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };
  const bold = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).font = { bold: true };
  };
  const cc = new Map(r.state.cc.map((c) => [c.id, c]));
  const site = new Map(r.state.sites.map((s) => [s.id, s]));
  const opByKey = new Map(r.plan.ops.map((o) => [`${o.ccId}|${o.siteId}`, o]));
  const t = r.target;

  const summary = wb.addWorksheet('Сводка');
  summary.columns = [
    { header: 'Показатель', key: 'k', width: 52 },
    { header: 'Значение', key: 'v', width: 80 },
  ];
  bold(summary);
  const kinds = new Map<string, number>();
  for (const e of t.entries) kinds.set(e.layer.kind, (kinds.get(e.layer.kind) ?? 0) + 1);
  const rows: Array<[string, string | number]> = [
    ['Режим', meta.mode === 'apply' ? 'запись' : 'проверка (dry-run)'],
    ['Файл', meta.file?.path ?? '—'],
    ['sha256 файла', meta.file?.sha256 ?? '—'],
    ['Отпечаток плана', r.plan.fingerprint.slice(0, FINGERPRINT_SHOWN)],
    ['Подрядчиков сопоставлено', t.contractorMatches.length],
    ['Подрядчиков не сопоставлено', t.unresolvedContractors.length],
    ['Строк без объекта портала', t.unresolvedObjects.length],
    ['Связей по файлу', t.entries.length],
    ...[...kinds].map(
      ([k, n]) =>
        [`  из них ${CONTRACTOR_SITE_KIND_LABELS[k as OnecLayer['kind']]}`, n] as [string, number],
    ),
    [
      '  на закрытых объектах',
      t.entries.filter((e) => site.get(e.siteId)?.isActive === false).length,
    ],
    ['Без изменений', r.plan.unchanged],
    ...(Object.keys(OP_LABELS) as OpType[]).map(
      (k) => [`Операция: ${OP_LABELS[k]}`, r.plan.counts[k]] as [string, number],
    ),
    ['Замечаний разбора', meta.issues.length],
  ];
  for (const [k, v] of rows) summary.addRow({ k, v });

  const links = wb.addWorksheet('Связи', frozen);
  links.columns = [
    { header: 'Подрядчик (справочник)', key: 'cc', width: 40 },
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'Объект', key: 'code', width: 10 },
    { header: 'Название объекта', key: 'site', width: 36 },
    { header: 'Закрыт', key: 'closed', width: 8 },
    { header: 'Вид', key: 'kind', width: 26 },
    { header: 'Реализаций', key: 'rd', width: 11 },
    { header: 'Сумма реализаций', key: 'rs', width: 16 },
    { header: 'Давальческих актов', key: 'td', width: 11 },
    { header: 'Сумма давальческих', key: 'ts', width: 16 },
    { header: 'Объект в 1С', key: 'objects', width: 60 },
    { header: 'Строки файла', key: 'rows', width: 14 },
    { header: 'Операция', key: 'op', width: 28 },
  ];
  bold(links);
  for (const e of t.entries) {
    const c = cc.get(e.ccId);
    const s = site.get(e.siteId);
    const op = opByKey.get(`${e.ccId}|${e.siteId}`);
    links.addRow({
      cc: c?.name ?? e.ccId,
      inn: c?.inn || '—',
      code: s?.code ?? e.siteId,
      site: s?.name ?? '—',
      closed: s?.isActive === false ? 'да' : '',
      kind: CONTRACTOR_SITE_KIND_LABELS[e.layer.kind],
      rd: e.layer.realizationDocs,
      rs: Number(e.layer.realizationSum),
      td: e.layer.tollingDocs,
      ts: Number(e.layer.tollingSum),
      objects: e.layer.objects.join(' | '),
      rows: e.rowNos.join(', '),
      op: op ? OP_LABELS[op.type] : 'без изменений',
    });
  }
  links.getColumn('rs').numFmt = '#,##0.00';
  links.getColumn('ts').numFmt = '#,##0.00';

  const matched = wb.addWorksheet('Подрядчики — найдены', frozen);
  matched.columns = [
    { header: 'Имя в 1С', key: 'raw', width: 42 },
    { header: 'Запись справочника', key: 'cc', width: 42 },
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'Как найден', key: 'via', width: 44 },
    { header: 'Строки файла', key: 'rows', width: 14 },
  ];
  bold(matched);
  for (const m of [...t.contractorMatches].sort((a, b) => a.raw.localeCompare(b.raw, 'ru'))) {
    const c = cc.get(m.ccId);
    matched.addRow({
      raw: m.raw,
      cc: c?.name ?? m.ccId,
      inn: c?.inn || '—',
      via: CONTRACTOR_LINK_LABELS[m.via],
      rows: m.rowNos.join(', '),
    });
  }

  const notFound = wb.addWorksheet('Подрядчики — не сопоставлены', frozen);
  notFound.columns = [
    { header: 'Имя в 1С', key: 'raw', width: 42 },
    { header: 'Причина', key: 'reason', width: 50 },
    { header: 'Кандидаты в справочнике', key: 'cands', width: 70 },
    { header: 'Строки файла', key: 'rows', width: 14 },
  ];
  bold(notFound);
  for (const u of t.unresolvedContractors) {
    notFound.addRow({
      raw: u.raw,
      reason: u.reason,
      cands: u.candidateIds
        .map((id) => cc.get(id))
        .map((c) => (c ? `${c.name} [${c.inn || 'без ИНН'}]` : '?'))
        .join('; '),
      rows: u.rowNos.join(', '),
    });
  }

  const noSite = wb.addWorksheet('Объект не определён', frozen);
  noSite.columns = [
    { header: 'Строка файла', key: 'row', width: 12 },
    { header: 'Подрядчик в 1С', key: 'raw', width: 40 },
    { header: 'Объект в 1С', key: 'obj', width: 70 },
    { header: 'Причина', key: 'reason', width: 50 },
  ];
  bold(noSite);
  for (const u of t.unresolvedObjects)
    noSite.addRow({ row: u.rowNo, raw: u.raw, obj: u.objectText || '(пусто)', reason: u.reason });

  const changes = wb.addWorksheet('Изменения', frozen);
  changes.columns = [
    { header: 'Операция', key: 'op', width: 44 },
    { header: 'Подрядчик', key: 'cc', width: 40 },
    { header: 'Объект', key: 'code', width: 10 },
    { header: 'Было (1С)', key: 'before', width: 60 },
    { header: 'Стало (1С)', key: 'after', width: 60 },
  ];
  bold(changes);
  for (const o of r.plan.ops)
    changes.addRow({
      op: OP_LABELS[o.type],
      cc: cc.get(o.ccId)?.name ?? o.ccId,
      code: site.get(o.siteId)?.code ?? o.siteId,
      before: layerText(o.before),
      after: layerText(o.after),
    });

  const issues = wb.addWorksheet('Замечания разбора', frozen);
  issues.columns = [
    { header: 'Строка', key: 'row', width: 8 },
    { header: 'Фатально', key: 'fatal', width: 9 },
    { header: 'Код', key: 'code', width: 20 },
    { header: 'Сообщение', key: 'msg', width: 70 },
    { header: 'Значение', key: 'value', width: 40 },
  ];
  bold(issues);
  for (const i of meta.issues)
    issues.addRow({
      row: i.rowNo,
      fatal: i.fatal ? 'да' : '',
      code: i.code,
      msg: i.message,
      value: i.value ?? '',
    });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
