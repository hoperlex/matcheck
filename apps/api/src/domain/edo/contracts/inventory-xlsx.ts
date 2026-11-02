/**
 * Опись договоров в Excel — то, что человек смотрит перед выгрузкой и после неё.
 *
 * Листы разделяют взятое, спорное, исключённое и нераспознанное: решение по
 * имени файла нечёткое, и пользователь должен видеть не только то, что
 * возьмётся, но и то, что отсеялось. После выгрузки опись переписывается с
 * колонками состояний: файл, подписи по сторонам, печатная форма, чего нет.
 */
import ExcelJS from 'exceljs';
import { CATEGORY_LABELS, REVIEW_CATEGORIES } from './classify.js';
import type { DownloadState, RowDownloadState } from './download.js';
import { isAnnulledOrRejected, moscowDay } from './layout.js';
import { ticksToDate } from '../list-windows.js';
import type { InventorySnapshot, SnapshotRow } from './snapshot.js';

const DIRECTION_LABELS = { inbound: 'входящий', outbound: 'исходящий' } as const;

function yesNo(v: boolean | null): string {
  return v === null ? '' : v ? 'да' : 'нет';
}

export async function buildContractsXlsx(snapshot: InventorySnapshot, download: DownloadState | null): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };
  const cps = new Map(snapshot.counterparties.map((c) => [c.boxId, c]));
  const selected = new Set(download?.selected?.rows ?? []);
  const by = (sel: SnapshotRow['selection']) => snapshot.rows.filter((r) => r.selection === sel);

  // ─── Сводка ───
  const summary = wb.addWorksheet('Сводка');
  summary.columns = [
    { header: 'Показатель', key: 'k', width: 46 },
    { header: 'Значение', key: 'v', width: 90 },
  ];
  summary.getRow(1).font = { bold: true };
  const add = (k: string, v: string | number) => summary.addRow({ k, v });
  add('Учётная запись', snapshot.accountName);
  add('Период', `${moscowDay(snapshot.since)} – ${moscowDay(snapshot.until)} (по ${snapshot.until})`);
  add('Опись составлена', `${snapshot.createdAt} – ${snapshot.finishedAt ?? '…'}`);
  add('Опись полная', snapshot.complete ? 'да' : 'НЕТ — выгрузка по ней запрещена');
  for (const r of snapshot.reasons) add('  причина неполноты', r);
  for (const n of snapshot.notes) add('  замечание', n);
  add('Запросов к Диадоку', snapshot.requests);
  add('Первый документ ящика: входящие', snapshot.firstDocumentAt.inbound ?? '—');
  add('Первый документ ящика: исходящие', snapshot.firstDocumentAt.outbound ?? '—');
  add('Пропущено: тестовые / удалённые / удалённые в пакетах',
    `${snapshot.skipped.test} / ${snapshot.skipped.deleted} / ${snapshot.skipped.deletedInPackages}`);
  for (const c of snapshot.typeControls) {
    const state = { ok: 'сошёлся', mismatch: 'НЕ сошёлся', error: 'ошибка', not_in_box: 'тип не заведён у ящика' }[c.state];
    add(`Контроль ${c.typeNamedId}.${c.direction}`, `${state}; по типу ${c.expected ?? '—'}, в общем списке ${c.listed}${c.error ? `; ${c.error}` : ''}`);
  }
  const auto = by('auto');
  for (const cat of ['contract', 'supplementary', 'package'] as const) {
    add(`Берём: ${CATEGORY_LABELS[cat]}`, auto.filter((r) => r.category === cat).length);
  }
  for (const cat of REVIEW_CATEGORIES) {
    add(`На просмотр: ${CATEGORY_LABELS[cat]} (--include ${cat})`, by('review').filter((r) => r.category === cat).length);
  }
  add('Похожие — исключены', by('excluded').length);
  add('Не распознаны (неформализованные)', by('unrecognized').length);
  add(
    'Что считается пакетом',
    'одно сообщение Диадока + документы с тем же PacketId в других сообщениях за период; документы пакета вне периода, удалённые и внутренние не видны',
  );
  if (download) {
    add(
      'Выгрузка',
      download.complete
        ? `завершена: ${download.done} из ${download.selected?.rows.length ?? 0}`
        : `НЕ завершена: готово ${download.done}, осталось ${download.pending}`,
    );
    if (download.selected) {
      add('Выбор: категории целиком', download.selected.include.join(', ') || '—');
      add('Выбор: добавленные строки', download.selected.addRows.join(', ') || '—');
    }
  } else {
    add('Выгрузка', 'не начата');
  }

  // ─── Строки ───
  const rowSheet = (title: string, rows: SnapshotRow[]) => {
    const ws = wb.addWorksheet(title, frozen);
    ws.columns = [
      { header: '№', key: 'row', width: 7 },
      { header: 'Категория', key: 'category', width: 14 },
      { header: 'Почему', key: 'reason', width: 36 },
      { header: 'Направление', key: 'direction', width: 11 },
      { header: 'Дата (МСК)', key: 'day', width: 11 },
      { header: 'Контрагент', key: 'cp', width: 32 },
      { header: 'ИНН', key: 'inn', width: 13 },
      { header: 'Имя файла', key: 'fileName', width: 50 },
      { header: 'Тип в Диадоке', key: 'type', width: 16 },
      { header: 'Номер', key: 'number', width: 14 },
      { header: 'Дата документа', key: 'date', width: 12 },
      { header: 'К договору (из имени)', key: 'ref', width: 20 },
      { header: 'Статус документооборота', key: 'docflow', width: 26 },
      { header: 'Аннулирован/отклонён', key: 'annulled', width: 11 },
      { header: 'Пакет', key: 'via', width: 12 },
      { header: 'Подписей при описи', key: 'sigs', width: 9 },
      { header: 'Нужна подпись получателя', key: 'needSig', width: 10 },
      ...(download
        ? [
            { header: 'Выбран', key: 'selected', width: 8 },
            { header: 'Файл', key: 'file', width: 9 },
            { header: 'Подп. отправителя', key: 'sSender', width: 9 },
            { header: 'Подп. получателя', key: 'sRecipient', width: 9 },
            { header: 'Ответная подпись', key: 'recipientState', width: 15 },
            { header: 'Согласующие', key: 'sApprove', width: 9 },
            { header: 'Новые с описи', key: 'newSigs', width: 8 },
            { header: 'Печатная форма', key: 'print', width: 12 },
            { header: 'Папка', key: 'dir', width: 50 },
            { header: 'Чего нет / ошибка', key: 'problem', width: 40 },
          ]
        : []),
      { header: 'MessageId', key: 'messageId', width: 38 },
      { header: 'EntityId', key: 'entityId', width: 38 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };
    for (const r of rows) {
      const cp = r.counteragentBoxId ? cps.get(r.counteragentBoxId) : undefined;
      const st: RowDownloadState | undefined = download?.rows.get(r.row);
      ws.addRow({
        row: r.row,
        category: CATEGORY_LABELS[r.category],
        reason: r.reason,
        direction: DIRECTION_LABELS[r.direction],
        day: moscowDay(r.at),
        cp: cp?.name ?? '',
        inn: cp?.inn ?? '',
        fileName: r.fileName ?? '',
        type: r.typeNamedId ?? '',
        number: r.number ?? '',
        date: r.date ?? '',
        ref: r.contractRef ?? '',
        docflow: r.docflowText ?? '',
        annulled: isAnnulledOrRejected(r) ? 'да' : '',
        via: r.packageVia === 'message' ? 'сообщение' : r.packageVia === 'packet' ? 'PacketId' : '',
        sigs: r.inventorySignatures ?? '',
        needSig: yesNo(r.needRecipientSignature),
        selected: download ? (selected.has(r.row) ? 'да' : '') : undefined,
        file: st?.file ?? '',
        sSender: st ? st.signatures.sender : '',
        sRecipient: st ? st.signatures.recipient : '',
        recipientState: st?.recipientState ?? '',
        sApprove: st ? st.signatures.approvement : '',
        newSigs: st?.newSignatures ?? '',
        print: st ? (st.printForm === 'недоступна' ? `недоступна: ${st.printFormReason ?? ''}` : st.printForm) : '',
        dir: st?.dir ?? '',
        problem: st ? [...st.missing, ...(st.error ? [st.error] : [])].join('; ') : '',
        messageId: r.messageId,
        entityId: r.entityId,
      });
    }
  };
  rowSheet('Берём', by('auto'));
  rowSheet('На просмотр', by('review'));
  rowSheet('Похожие — исключены', by('excluded'));
  rowSheet('Не распознаны', by('unrecognized'));

  // ─── По годам ───
  const years = wb.addWorksheet('По годам', frozen);
  years.columns = [
    { header: 'Год', key: 'year', width: 9 },
    { header: 'Направление', key: 'direction', width: 12 },
    { header: 'Тип в Диадоке', key: 'type', width: 40 },
    { header: 'Документов', key: 'count', width: 12 },
  ];
  years.getRow(1).font = { bold: true };
  for (const [k, count] of Object.entries(snapshot.counts).sort(([a], [b]) => a.localeCompare(b))) {
    const [year, direction, type] = k.split('|');
    years.addRow({ year, direction: DIRECTION_LABELS[direction as 'inbound' | 'outbound'] ?? direction, type, count });
  }

  // ─── Окна ───
  const windows = wb.addWorksheet('Окна', frozen);
  windows.columns = [
    { header: 'Категория', key: 'category', width: 14 },
    { header: 'С', key: 'from', width: 26 },
    { header: 'По', key: 'to', width: 26 },
    { header: 'Счёт', key: 'total', width: 8 },
    { header: 'Прочитано', key: 'read', width: 10 },
    { header: 'Сошлось', key: 'ok', width: 9 },
  ];
  windows.getRow(1).font = { bold: true };
  for (const w of snapshot.windows) {
    windows.addRow({
      category: w.category,
      from: ticksToDate(BigInt(w.from)).toISOString(),
      to: ticksToDate(BigInt(w.to)).toISOString(),
      total: w.total,
      read: w.read,
      ok: w.read === w.total ? 'да' : 'НЕТ',
    });
  }

  // ─── Типы ящика ───
  const types = wb.addWorksheet('Типы ящика', frozen);
  types.columns = [
    { header: 'Тип', key: 'name', width: 40 },
    { header: 'Название', key: 'title', width: 60 },
  ];
  types.getRow(1).font = { bold: true };
  for (const t of snapshot.boxTypes ?? []) types.addRow(t);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
