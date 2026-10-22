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
 * Другие режимы (все пишут в журнал edo_export_runs):
 *   --auto — один полный проход, как у автообновления mail-worker'а: все УПД
 *     ящика по постоянному курсору, перепись сканов, повтор сбоев. Список не
 *     нужен. Так проверяют выгрузку перед включением EDO_EXPORT_AUTO_ENABLED.
 *   --census-only --since ГГГГ-ММ-ДД [--max-events N] — только перепись сканов,
 *     счетов-фактур и накладных за период, без скачиваний; курсор не трогает.
 *     Предел по умолчанию 100 000 событий; при усечении печатает, с какой даты
 *     продолжить. Повтор безопасен.
 *   --retry-failed — сбросить счётчики попыток у всех сбоев учётки: следующий
 *     полный проход (или этот же, вместе с --auto) повторит их заново.
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
import { and, asc, eq, isNotNull, sql as drSql } from 'drizzle-orm';
import XLSX from 'xlsx';
import { db, sql } from '../src/db/client.js';
import { edoAccounts, edoExportDocuments } from '../src/db/schema.js';
import { CONTENT_CATEGORY_LABELS, type EdoContentCategory } from '../src/domain/edo/document-kind.js';
import type { ExportSummary } from '../src/domain/edo/export-upd.js';
import {
  SUPPLIER_ISSUE_LABELS,
  parseSupplierRows,
  type SupplierList,
} from '../src/domain/edo/export-suppliers.js';
import {
  parseSince,
  runEdoExportPass,
  type ExportRunMode,
  type ExportRunResult,
} from '../src/domain/jobs/edo-export-runner.js';
import { DIADOC_PROVIDER, isDiadocAccount } from '../src/domain/edo/provider.js';
import { slugify } from '../src/domain/storage/s3.path.js';
import { getObject, putObject } from '../src/domain/storage/s3.signer.js';
import { loadEnv } from '../src/lib/env.js';
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
const maxEventsArg = argValue('--max-events');
const noDownload = process.argv.includes('--no-download');
const auto = process.argv.includes('--auto');
const censusOnly = process.argv.includes('--census-only');
const retryFailed = process.argv.includes('--retry-failed');

/** Предел переписи по умолчанию: с 01.08 ожидается около 40 тысяч событий. */
const CENSUS_MAX_EVENTS = 100_000;

type Account = typeof edoAccounts.$inferSelect;

function since(raw: string): Date {
  try {
    return parseSince(raw);
  } catch (err) {
    throw new Error(`--since: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function maxEvents(fallback: number): number {
  if (!maxEventsArg) return fallback;
  const n = Number(maxEventsArg);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--max-events ждёт целое > 0, получено «${maxEventsArg}»`);
  return n;
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
    if (!isDiadocAccount(row)) throw new Error(`учётная запись ${accountArg} — не Диадок (${row.provider}); скрипт только для Диадока`);
    return row;
  }
  const rows = await db
    .select()
    .from(edoAccounts)
    .where(
      and(eq(edoAccounts.isActive, true), isNotNull(edoAccounts.boxId), eq(edoAccounts.provider, DIADOC_PROVIDER)),
    );
  if (rows.length === 1) return rows[0]!;
  const names = rows.map((r) => `${r.id} (${r.name})`).join(', ') || 'нет ни одной';
  throw new Error(`выберите учётную запись через --account; активных учёток Диадока с ящиком: ${names}`);
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
      `  сбои прошлых проходов (ждут повтора): ${s.failedKnown}`,
      `Переписано сканов, счетов-фактур и накладных: ${s.census}`,
      s.truncated
        ? s.truncateReason === 'no_index_key'
          ? 'ВНИМАНИЕ: Диадок вернул страницу без ключа продолжения — лента прочитана не до конца.'
          : 'ВНИМАНИЕ: достигнут предел прохода — лента прочитана не до конца.'
        : '',
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
  const listName = (inn: string | null) => (inn ? (list.byInn.get(inn) ?? null) : null);
  // С автообновлением в хранилище лежат УПД всех продавцов: в папку — только из
  // списка, по тому продавцу документа, который в списке есть.
  const listedInn = (d: (typeof docs)[number]) =>
    [d.supplierInn, ...d.sellerInns].find((inn): inn is string => !!inn && list.byInn.has(inn)) ?? null;
  const stored = docs.filter((d) => d.status === 'stored' && listedInn(d) !== null);

  await mkdir(dir, { recursive: true });
  const fileOf = new Map<string, string>();
  let written = 0;
  let missing = 0;
  let mismatched = 0;
  for (const doc of stored) {
    // Имена только ASCII: при копировании на Windows кириллица в путях
    // бывает искажена, а номер УПД может содержать «/».
    const folder = `${listedInn(doc)}_${slugify(listName(listedInn(doc)) ?? doc.supplierName ?? '')}`;
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
      inn: listedInn(doc),
      listName: listName(listedInn(doc)),
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
    const inn = listedInn(doc)!;
    const acc = byInn.get(inn) ?? { count: 0, sum: 0 };
    acc.count += 1;
    acc.sum += numOrNull(doc.totalSum) ?? 0;
    byInn.set(inn, acc);
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
    // «Не из списка» — и отсеянные списком, и выгруженные автообновлением.
    if (doc.status === 'failed' || (doc.status === 'stored' && listedInn(doc) !== null)) continue;
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

const SKIPPED_TEXT: Record<'lease_taken' | 'no_box' | 'not_found' | 'inactive', string> = {
  lease_taken: 'Учётная запись занята другой работой по ЭДО (осмотр, автообновление, опрос). Запустите позже.',
  no_box: 'Выгрузка невозможна: у учётной записи не выбран ящик.',
  not_found: 'Выгрузка невозможна: учётная запись не найдена.',
  inactive: 'Выгрузка невозможна: учётная запись выключена.',
};

/** Печать результата прохода и код выхода: 0 — дочитано, 1 — не до конца, 2 — учётка занята. */
function report(result: ExportRunResult): number {
  if ('skipped' in result) {
    console.error(SKIPPED_TEXT[result.skipped]);
    return result.skipped === 'lease_taken' ? 2 : 1;
  }
  if (result.summary) printSummary(result.summary);
  if (result.retry?.picked) {
    const r = result.retry;
    console.info(
      `Повтор сбоев: взято ${r.picked}, выгружено ${r.stored}, не из списка ${r.notInList}, ` +
        `снова сбой ${r.failed}, закрыто ${r.closed}`,
    );
  }
  console.info(`Журнал: edo_export_runs ${result.runId}, исход ${result.outcome}`);
  if (result.outcome === 'completed') return 0;
  if (result.outcome === 'stopped') {
    console.error(`Остановлено: ${result.error}. Всё сделанное сохранено; запустите позже.`);
    return 2;
  }
  if (result.error) console.error(`Остановлено: ${result.error}. Всё сделанное сохранено; повторный запуск продолжит.`);
  return 1;
}

const progress = (s: Readonly<ExportSummary>) =>
  console.info(
    `  страница ${s.pages}: событий ${s.eventsSeen}, УПД ${s.candidates}, новых ${s.stored}, ` +
      `уже было ${s.alreadyStored}, не из списка ${s.notInList + s.notInListKnown}, сбоев ${s.failed}, ` +
      `перепись ${s.census}`,
  );

async function main(): Promise<number> {
  const modes = [auto, censusOnly, !!suppliersPath].filter(Boolean).length;
  if (modes > 1) throw new Error('--auto, --census-only и --suppliers взаимоисключающие');
  if (modes === 0 && !retryFailed) {
    throw new Error('укажите режим: --suppliers <xlsx> --since …, --auto, --census-only --since … или --retry-failed');
  }
  if (noDownload && !outDir) throw new Error('--no-download имеет смысл только вместе с --out-dir');
  if ((censusOnly || (suppliersPath && !noDownload)) && !sinceArg) throw new Error('укажите --since ГГГГ-ММ-ДД');

  const account = await resolveAccount();
  console.info(`Учётная запись: ${account.name} (${account.id}), ящик ${account.boxId ?? '—'}`);
  // Ctrl+C или остановка контейнера: проход завершается между запросами к
  // Диадоку, пишет в журнал «stopped» и освобождает учётку.
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.error(`Получен ${signal}: останавливаю после текущего запроса…`);
      abort.abort();
    });
  }
  const deps = {
    db,
    log: logger.child({ service: 'edo-export' }),
    owner: randomUUID(),
    put: putObject,
    onPage: progress,
    signal: abort.signal,
  };

  if (retryFailed) {
    const reset = await db
      .update(edoExportDocuments)
      .set({ attempts: 0, nextRetryAt: drSql`now()`, updatedAt: new Date() })
      .where(and(eq(edoExportDocuments.edoAccountId, account.id), eq(edoExportDocuments.status, 'failed')))
      .returning({ id: edoExportDocuments.id });
    console.info(`Сброшены счётчики попыток у ${reset.length} сбоев: их повторит ближайший полный проход.`);
    if (modes === 0) return 0;
  }

  if (auto) {
    const env = loadEnv();
    const mode: ExportRunMode = {
      scope: 'all',
      trigger: 'script',
      maxEvents: maxEvents(env.EDO_EXPORT_MAX_EVENTS),
      maxDownloads: env.EDO_EXPORT_MAX_DOWNLOADS,
    };
    console.info('Полный проход по курсору (как автообновление)…');
    return report(await runEdoExportPass(deps, account.id, mode));
  }

  if (censusOnly) {
    const from = since(sinceArg!);
    console.info(`Перепись с ${fmtMsk(from)} (Москва), без скачиваний…`);
    const result = await runEdoExportPass(deps, account.id, {
      scope: 'census',
      trigger: 'script',
      since: from,
      maxEvents: maxEvents(CENSUS_MAX_EVENTS),
    });
    const code = report(result);
    if (!('skipped' in result) && result.summary?.truncated && result.summary.to) {
      // Повтор с того же дня идемпотентен: уже переписанное не задвоится.
      const day = new Date(Date.parse(result.summary.to) + 3 * 3600_000).toISOString().slice(0, 10);
      console.info(`Продолжить: --census-only --since ${day}${maxEventsArg ? ` --max-events ${maxEventsArg}` : ''}`);
    }
    return code;
  }

  const list = readSupplierList(suppliersPath!);
  printSupplierList(list);
  if (list.byInn.size === 0) throw new Error('в списке нет ни одного валидного ИНН');

  let exitCode = 0;
  if (!noDownload) {
    const from = since(sinceArg!);
    console.info(`Выгрузка с ${fmtMsk(from)} (Москва)…`);
    exitCode = report(
      await runEdoExportPass(deps, account.id, {
        scope: 'list',
        trigger: 'script',
        since: from,
        suppliers: list.byInn,
        maxEvents: maxEventsArg ? maxEvents(0) : undefined,
      }),
    );
    if (exitCode === 2) return 2;
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
