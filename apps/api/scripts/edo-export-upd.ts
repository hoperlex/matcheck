/**
 * Выгрузка УПД из Диадока по списку поставщиков: XML в хранилище + реестр.
 *
 * Что делает. Читает ленту ящика с даты --since, скачивает каждый УПД и
 * исправление, по XML определяет продавца и кладёт в хранилище
 * (edo-export/<ИНН>/…) только документы поставщиков из списка. Каждый
 * увиденный документ получает строку в edo_export_documents: выгружен, не из
 * списка или сбой с причиной.
 *
 * Чего НЕ делает. Карточек в портале нет: source_documents, контрагенты,
 * журнал приёма (edo_events/edo_receipts) и курсор ленты учётной записи не
 * трогаются. Будущий импорт эти документы не потеряет.
 *
 * Повтор безопасен: уже выгруженное и известное «не из списка» не качается.
 * Расширить период — тот же запуск с более ранним --since.
 *
 * С --out-dir дополнительно собирает папку для скачивания — реестр.xlsx и XML
 * по папкам поставщиков. Папка собирается из реестра и хранилища, без Диадока,
 * поэтому её можно пересобрать в любой момент (--no-download).
 *
 * Коды выхода: 0 — всё прошло; 1 — обход остановлен (связь, лимиты, лента не
 * сдвинулась, прочитано не всё) — повторный запуск продолжит; 2 — учётная
 * запись занята другой работой по ЭДО или лиз потерян.
 *
 * Запуск на бою (контейнер работает под пользователем node, каталог /data
 * должен быть ему доступен на запись):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/tmp:/data matcheck-api \
 *     node_modules/.bin/tsx scripts/edo-export-upd.ts \
 *     --suppliers /data/suppliers-unique.xlsx --since 2026-09-22 --out-dir /data/edo-export
 *
 * Локально:
 *   pnpm --filter @matcheck/api exec tsx scripts/edo-export-upd.ts --suppliers … --since …
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import XLSX from 'xlsx';
import { db, sql } from '../src/db/client.js';
import { edoAccounts, edoExportDocuments } from '../src/db/schema.js';
import { CONTENT_CATEGORY_LABELS, type EdoContentCategory } from '../src/domain/edo/document-kind.js';
import { EdoExportStopped, type ExportSummary } from '../src/domain/edo/export-upd.js';
import {
  SUPPLIER_ISSUE_LABELS,
  parseSupplierRows,
  type SupplierList,
} from '../src/domain/edo/export-suppliers.js';
import { runEdoExport } from '../src/domain/jobs/edo-poll-runner.js';
import { slugify } from '../src/domain/storage/s3.path.js';
import { getObject, putObject } from '../src/domain/storage/s3.signer.js';
import { logger } from '../src/lib/logger.js';
import { MONEY_FMT, fmtDateTimeRu, numOrNull } from '../src/lib/xlsx-format.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const suppliersPath = argValue('--suppliers');
const sinceArg = argValue('--since');
const accountArg = argValue('--account');
const outDir = argValue('--out-dir');
const noDownload = process.argv.includes('--no-download');

type Account = typeof edoAccounts.$inferSelect;

/** Дата YYYY-MM-DD → начало суток по Москве (UTC+3 круглый год). */
function parseSince(raw: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`--since ждёт дату ГГГГ-ММ-ДД, получено «${raw}»`);
  const date = new Date(`${raw}T00:00:00+03:00`);
  if (Number.isNaN(date.getTime())) throw new Error(`--since: неверная дата «${raw}»`);
  return date;
}

function readSupplierList(path: string): SupplierList {
  const wb = XLSX.readFile(path);
  const sheetName = wb.SheetNames.includes('Поставщики') ? 'Поставщики' : wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) throw new Error(`в книге ${path} нет листов`);
  // raw: false — ИНН с ведущим нулём остаётся строкой, а не числом без нуля.
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });
  return parseSupplierRows(rows);
}

function printSupplierList(list: SupplierList) {
  console.info(
    `Список: строк ${list.rows}, валидных ИНН ${list.byInn.size}, отброшено ${list.issues.length}`,
  );
  for (const issue of list.issues) {
    const inn = issue.inn ? ` «${issue.inn}»` : '';
    console.info(`  строка ${issue.row}: ${issue.name || '(без названия)'}${inn} — ${SUPPLIER_ISSUE_LABELS[issue.reason]}`);
  }
}

async function resolveAccount(): Promise<Account> {
  if (accountArg) {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountArg)).limit(1);
    if (!row) throw new Error(`учётная запись ЭДО ${accountArg} не найдена`);
    return row;
  }
  const rows = await db
    .select()
    .from(edoAccounts)
    .where(and(eq(edoAccounts.isActive, true), isNotNull(edoAccounts.boxId)));
  if (rows.length === 1) return rows[0]!;
  const names = rows.map((r) => `${r.id} (${r.name})`).join(', ') || 'нет ни одной';
  throw new Error(`выберите учётную запись через --account; активных с ящиком: ${names}`);
}

function printSummary(s: Readonly<ExportSummary>) {
  console.info(
    [
      `Страниц: ${s.pages}, событий: ${s.eventsSeen}` +
        (s.from ? `, лента с ${fmtMsk(s.from)} по ${fmtMsk(s.to)} (Москва)` : ''),
      `УПД и исправлений: ${s.candidates}`,
      `  выгружено новых:        ${s.stored}`,
      `  уже были в хранилище:   ${s.alreadyStored}`,
      `  не из списка:           ${s.notInList}`,
      `  не из списка (известно): ${s.notInListKnown}`,
      `  сбоев:                  ${s.failed}`,
      s.truncated ? 'ВНИМАНИЕ: лента прочитана не до конца — запустите ещё раз.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

const ddmmyyyy = 'dd.mm.yyyy';

/** Время по Москве (UTC+3 круглый год) — так его видят в Диадоке. */
function fmtMsk(d: Date | string | null): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? '' : fmtDateTimeRu(new Date(date.getTime() + 3 * 3600_000));
}

function contentLabel(category: string | null): string {
  return category ? (CONTENT_CATEGORY_LABELS[category as EdoContentCategory] ?? category) : '';
}

/**
 * Папка для скачивания: XML по папкам поставщиков и реестр. Собирается из
 * реестра и хранилища — Диадок не нужен.
 */
async function writeOutDir(account: Account, list: SupplierList, dir: string) {
  const docs = await db
    .select()
    .from(edoExportDocuments)
    .where(eq(edoExportDocuments.edoAccountId, account.id))
    .orderBy(
      asc(edoExportDocuments.supplierInn),
      asc(edoExportDocuments.documentDate),
      asc(edoExportDocuments.createdAt),
    );
  const stored = docs.filter((d) => d.status === 'stored');
  const listName = (inn: string | null) => (inn ? (list.byInn.get(inn) ?? null) : null);

  await mkdir(dir, { recursive: true });
  const fileOf = new Map<string, string>();
  let written = 0;
  let missing = 0;
  let mismatched = 0;
  for (const doc of stored) {
    // Имена только ASCII: при копировании на Windows кириллица в путях
    // бывает искажена, а номер УПД может содержать «/».
    const folder = `${doc.supplierInn}_${slugify(listName(doc.supplierInn) ?? doc.supplierName ?? '')}`;
    const rel = `${folder}/${doc.s3Key!.split('/').pop()!}`;
    try {
      const body = await getObject(doc.s3Key!);
      if (createHash('sha256').update(body).digest('hex') !== doc.contentSha256) {
        mismatched += 1;
        console.warn(`  ВНИМАНИЕ: содержимое ${doc.s3Key} не совпало с реестром по sha256`);
      }
      await mkdir(join(dir, folder), { recursive: true });
      await writeFile(join(dir, rel), body);
      fileOf.set(doc.id, rel);
      written += 1;
    } catch (err) {
      missing += 1;
      console.error(`  не удалось взять ${doc.s3Key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };

  const upd = wb.addWorksheet('УПД', frozen);
  upd.columns = [
    { header: 'ИНН поставщика', key: 'inn', width: 14 },
    { header: 'Поставщик (список)', key: 'listName', width: 32 },
    { header: 'Продавец в УПД', key: 'seller', width: 32 },
    { header: '№ УПД', key: 'number', width: 16 },
    { header: 'Дата УПД', key: 'date', width: 12 },
    { header: 'Функция', key: 'fn', width: 10 },
    { header: 'Исправление', key: 'correction', width: 12 },
    { header: 'Сумма с НДС', key: 'total', width: 16 },
    { header: 'НДС', key: 'vat', width: 14 },
    { header: 'Позиций', key: 'items', width: 9 },
    { header: 'Содержимое', key: 'content', width: 18 },
    { header: 'Получен в Диадоке', key: 'received', width: 18 },
    { header: 'Файл в папке', key: 'file', width: 50 },
    { header: 'Ключ в хранилище', key: 's3Key', width: 60 },
    { header: 'MessageId', key: 'messageId', width: 38 },
    { header: 'EntityId', key: 'entityId', width: 38 },
  ];
  for (const doc of stored) {
    const row = upd.addRow({
      inn: doc.supplierInn,
      listName: listName(doc.supplierInn),
      seller: doc.supplierName,
      number: doc.documentNumber,
      date: doc.documentDate,
      fn: doc.documentType === 'UniversalTransferDocumentRevision' ? `${doc.documentFunction ?? ''} (ИУПД)` : doc.documentFunction,
      correction: doc.correctionNumber,
      total: numOrNull(doc.totalSum),
      vat: numOrNull(doc.vatSum),
      items: doc.itemsCount,
      content: contentLabel(doc.contentCategory),
      received: fmtMsk(doc.receivedAt),
      file: fileOf.get(doc.id) ?? '(не скачан из хранилища)',
      s3Key: doc.s3Key,
      messageId: doc.messageId,
      entityId: doc.entityId,
    });
    row.getCell('date').numFmt = ddmmyyyy;
    row.getCell('total').numFmt = MONEY_FMT;
    row.getCell('vat').numFmt = MONEY_FMT;
  }

  // Все поставщики списка, включая тех, от кого в ЭДО ничего не пришло.
  const byInn = new Map<string, { count: number; sum: number }>();
  for (const doc of stored) {
    const acc = byInn.get(doc.supplierInn!) ?? { count: 0, sum: 0 };
    acc.count += 1;
    acc.sum += numOrNull(doc.totalSum) ?? 0;
    byInn.set(doc.supplierInn!, acc);
  }
  const suppliers = wb.addWorksheet('Поставщики', frozen);
  suppliers.columns = [
    { header: 'ИНН', key: 'inn', width: 14 },
    { header: 'Поставщик', key: 'name', width: 40 },
    { header: 'УПД выгружено', key: 'count', width: 14 },
    { header: 'Сумма с НДС', key: 'sum', width: 18 },
  ];
  for (const [inn, name] of list.byInn) {
    const acc = byInn.get(inn);
    const row = suppliers.addRow({ inn, name, count: acc?.count ?? 0, sum: acc?.sum ?? 0 });
    row.getCell('sum').numFmt = MONEY_FMT;
  }

  // Продавцы, приславшие УПД, но не попавшие в список: кого может не хватать.
  const others = new Map<string, { name: string | null; count: number; sum: number }>();
  for (const doc of docs) {
    if (doc.status !== 'not_in_list') continue;
    const key = doc.supplierInn ?? '';
    const acc = others.get(key) ?? { name: doc.supplierName, count: 0, sum: 0 };
    acc.count += 1;
    acc.sum += numOrNull(doc.totalSum) ?? 0;
    others.set(key, acc);
  }
  const notListed = wb.addWorksheet('Не из списка', frozen);
  notListed.columns = [
    { header: 'ИНН продавца', key: 'inn', width: 14 },
    { header: 'Продавец в УПД', key: 'name', width: 40 },
    { header: 'УПД', key: 'count', width: 8 },
    { header: 'Сумма с НДС', key: 'sum', width: 18 },
  ];
  for (const [inn, acc] of [...others].sort((a, b) => b[1].count - a[1].count)) {
    const row = notListed.addRow({ inn, name: acc.name, count: acc.count, sum: acc.sum });
    row.getCell('sum').numFmt = MONEY_FMT;
  }

  const failures = wb.addWorksheet('Сбои', frozen);
  failures.columns = [
    { header: '№ документа', key: 'number', width: 16 },
    { header: 'Дата', key: 'date', width: 12 },
    { header: 'Тип', key: 'type', width: 34 },
    { header: 'Получен в Диадоке', key: 'received', width: 18 },
    { header: 'Причина', key: 'error', width: 50 },
    { header: 'MessageId', key: 'messageId', width: 38 },
    { header: 'EntityId', key: 'entityId', width: 38 },
  ];
  for (const doc of docs) {
    if (doc.status !== 'failed') continue;
    const row = failures.addRow({
      number: doc.documentNumber,
      date: doc.documentDate,
      type: doc.documentType,
      received: fmtMsk(doc.receivedAt),
      error: doc.lastError,
      messageId: doc.messageId,
      entityId: doc.entityId,
    });
    row.getCell('date').numFmt = ddmmyyyy;
  }

  const registryPath = join(dir, 'реестр.xlsx');
  await writeFile(registryPath, Buffer.from(await wb.xlsx.writeBuffer()));

  console.info(
    `Папка ${dir}: XML ${written} из ${stored.length}` +
      (missing ? `, не взято из хранилища ${missing}` : '') +
      (mismatched ? `, расхождений sha256 ${mismatched}` : '') +
      `; реестр ${registryPath}`,
  );
  return { failed: missing + mismatched };
}

async function main(): Promise<number> {
  if (!suppliersPath) throw new Error('укажите --suppliers <файл xlsx со списком поставщиков>');
  if (noDownload && !outDir) throw new Error('--no-download имеет смысл только вместе с --out-dir');
  if (!noDownload && !sinceArg) throw new Error('укажите --since ГГГГ-ММ-ДД');

  const list = readSupplierList(suppliersPath);
  printSupplierList(list);
  if (list.byInn.size === 0) throw new Error('в списке нет ни одного валидного ИНН');

  const account = await resolveAccount();
  console.info(`Учётная запись: ${account.name} (${account.id}), ящик ${account.boxId ?? '—'}`);

  let exitCode = 0;
  if (!noDownload) {
    const since = parseSince(sinceArg!);
    console.info(`Выгрузка с ${fmtMsk(since)} (Москва)…`);
    try {
      const outcome = await runEdoExport(
        { db, log: logger.child({ service: 'edo-export' }), owner: randomUUID(), put: putObject },
        account.id,
        {
          since,
          suppliers: list.byInn,
          onPage: (s) =>
            console.info(
              `  страница ${s.pages}: событий ${s.eventsSeen}, УПД ${s.candidates}, новых ${s.stored}, ` +
                `уже было ${s.alreadyStored}, не из списка ${s.notInList + s.notInListKnown}, сбоев ${s.failed}`,
            ),
        },
      );
      if ('ok' in outcome) {
        printSummary(outcome.summary);
        if (outcome.summary.truncated) exitCode = 1;
      } else if (outcome.skipped === 'lease_lost') {
        printSummary(outcome.summary);
        console.error('Остановлено: учётную запись забрала другая работа по ЭДО. Запустите позже.');
        exitCode = 2;
      } else if (outcome.skipped === 'lease_taken') {
        console.error('Учётная запись занята другой работой по ЭДО (осмотр, пробный разбор, опрос). Запустите позже.');
        return 2;
      } else {
        console.error(`Выгрузка невозможна: ${outcome.skipped === 'no_box' ? 'у учётной записи не выбран ящик' : 'учётная запись не найдена'}`);
        return 1;
      }
    } catch (err) {
      if (!(err instanceof EdoExportStopped)) throw err;
      printSummary(err.summary);
      console.error(`Остановлено: ${err.message}. Всё выгруженное сохранено; повторный запуск продолжит.`);
      exitCode = 1;
    }
  }

  if (outDir) {
    const result = await writeOutDir(account, list, outDir);
    if (result.failed > 0 && exitCode === 0) exitCode = 1;
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
