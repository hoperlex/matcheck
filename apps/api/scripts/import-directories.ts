/**
 * Импорт справочников: поставщики из выгрузки BillHub → «Поставщики»
 * (suppliers), подрядчики из выгрузки 1С «Списание по субподряду» →
 * «Контрагенты» (customer_counterparties), плюс склейка надёжных дублей
 * поставщиков, накопленных распознаванием.
 *
 * Логика и правила — в src/domain/directories/ (plan-*.ts, apply.ts). Здесь
 * только чтение файлов, отчёт и снимок для отката.
 *
 * Порядок работы:
 *   1. dry-run (по умолчанию) — только чтение, без блокировок; печатает
 *      отпечаток плана и пишет отчёт. Можно запускать под read-only ролью.
 *   2. --apply --confirm <первые 16 символов отпечатка> — та же сверка внутри
 *      транзакции под блокировками; если база изменилась и план другой —
 *      ROLLBACK, код 2, нужен новый dry-run. Перед записью — snapshot-*.json.
 *      На время записи останавливать воркер (docker compose stop matcheck-worker).
 *   3. повторный dry-run должен показать 0 операций.
 *   Откат: --revert <snapshot.json> (dry-run), затем то же с --apply.
 *
 * Запуск на бою (контейнер под uid 1000, каталог вывода ему доступен на запись):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/tmp:/data matcheck-api node_modules/.bin/tsx scripts/import-directories.ts \
 *     --suppliers /data/billhub-suppliers-2026-10-21.xlsx \
 *     --contractors /data/1c-contractors-2026-10-21.xlsx --out-dir /data/import-2026-10-21
 *
 * Локально:
 *   pnpm --filter @matcheck/api exec tsx scripts/import-directories.ts --suppliers … --out-dir …
 *
 * Склейка накопленных дублей поставщиков без файлов (27.10):
 *   --merges-only          правила 22.10 по текущей таблице, без файла BillHub;
 *   --near-inn             плюс битый ИНН в одной цифре от единственной записи
 *                          с корректным ИНН при близком имени (plan-near-inn.ts);
 *   --pairs <файл.csv>     плюс пары «id источника;id цели», подтверждённые
 *                          человеком по отчёту. Алиасы по парам не добавляются.
 *   Порядок тот же: dry-run → отчёт → --apply --confirm при остановленном
 *   воркере → повторный dry-run с теми же флагами показывает 0 → откат --revert.
 *
 * Файл 1С читается только SheetJS: часть книги называется xl/SharedStrings.xml
 * (с заглавной), ExcelJS её не находит и отдаёт пустые строки.
 *
 * Коды выхода: 0 — успех; 1 — ошибка или откат транзакции; 2 — занято другим
 * импортом, не дождались блокировки или план изменился после dry-run; 3 — файл
 * не прошёл проверку (до любой работы с базой).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { db, sql } from '../src/db/client.js';
import {
  DirectoriesImportError,
  runDirectoriesImport,
  type ImportResult,
  type ImportSnapshot,
} from '../src/domain/directories/apply.js';
import {
  parseBillhubSupplierRows,
  parseOneCContractorRows,
  type BillhubSupplier,
  type OneCContractor,
  type ParseIssue,
} from '../src/domain/directories/parse.js';
import { FINGERPRINT_SHOWN } from '../src/domain/directories/plan.js';
import { parseManualPairs, type ManualPair } from '../src/domain/directories/plan-near-inn.js';
import { buildImportReportXlsx, collectReportExtras } from '../src/domain/directories/report.js';
import { revertDirectoriesImport } from '../src/domain/directories/revert.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const suppliersPath = argValue('--suppliers');
const contractorsPath = argValue('--contractors');
const outDir = argValue('--out-dir');
const confirm = argValue('--confirm');
const revertPath = argValue('--revert');
const lockTimeoutArg = argValue('--lock-timeout-ms');
const pairsPath = argValue('--pairs');
const apply = process.argv.includes('--apply');
const mergesOnly = process.argv.includes('--merges-only');
const nearInn = process.argv.includes('--near-inn');

class ExitError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function readSheet(path: string, preferred: string): unknown[][] {
  const wb = XLSX.readFile(path);
  const name = wb.SheetNames.includes(preferred) ? preferred : wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws) throw new ExitError(3, `в книге ${path} нет листов`);
  // raw: false — ИНН остаётся строкой, без потери ведущих нулей и E+.
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function printIssues(label: string, issues: ParseIssue[]) {
  if (issues.length === 0) return;
  console.info(`${label}: замечаний разбора ${issues.length}`);
  for (const i of issues.slice(0, 30)) {
    console.info(
      `  строка ${i.rowNo}${i.fatal ? ' [ФАТАЛЬНО]' : ''}: ${i.message}${i.value ? ` «${i.value}»` : ''}`,
    );
  }
  if (issues.length > 30) console.info(`  … и ещё ${issues.length - 30} (все — в отчёте)`);
}

function printSummary(r: ImportResult) {
  const sp = r.plan.suppliers;
  const mp = r.plan.merges;
  const cp = r.plan.contractors;
  if (sp) {
    const by = (m: string) => sp.matches.filter((x) => x.match === m).length;
    console.info(
      `Поставщики: найдено по ID BillHub ${by('billhub_id')}, по id ${by('id')}, по ИНН ${by('inn')}; ` +
        `изменяется ${r.plan.supplierUpdates.size}, новых ${r.plan.supplierInserts.length}, находок ${sp.findings.length}`,
    );
  }
  if (mp) {
    const docs = mp.merges.reduce(
      (n, m) => n + m.sources.reduce((k, s) => k + (r.docs.bySource.get(s.id)?.length ?? 0), 0),
      0,
    );
    console.info(
      `Склейка: групп ${mp.merges.length}, удаляется дублей ${r.plan.supplierDeletes.length}, ` +
        `документов перепривязать ${docs}; сомнительных ${mp.doubtful.length}; грязный ИНН очищается у ${mp.innCleanups.length}`,
    );
    const byClass = new Map<string, number>();
    for (const m of mp.merges)
      for (const s of m.sources) byClass.set(s.class, (byClass.get(s.class) ?? 0) + 1);
    if (byClass.size > 0)
      console.info(`  по основаниям: ${[...byClass].map(([k, n]) => `${k} ${n}`).join(', ')}`);
    for (const p of mp.pairIssues)
      console.info(`  пара ${p.sourceId} → ${p.targetId} не выполняется: ${p.problem}`);
  }
  if (cp) {
    console.info(
      `Подрядчики: найдено ${cp.matches.length}, новых ${cp.inserts.length}, алиасов добавится ${cp.aliasUpdates.size}, ` +
        `неоднозначных ${cp.ambiguous.length}, по инициалам (вручную) ${cp.initialsCandidates.length}`,
    );
  }
  console.info(
    `Документы: сигнал планшету ${r.docs.touchIds.length}, старше окна синхронизации ${r.docs.outsideWindow}`,
  );
  if (!r.billhubColumn)
    console.info(
      'Колонки suppliers.billhub_id ещё нет (миграция 0137) — dry-run считает её пустой.',
    );
  if (r.timings)
    console.info(
      `Блокировки: ждали ${r.timings.lockWaitMs} мс, держали ${r.timings.lockHeldMs} мс`,
    );
  console.info(`Всего операций: ${r.plan.opCount}`);
  console.info(`Отпечаток плана: ${r.plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}`);
}

async function runImport(): Promise<void> {
  if (!outDir) throw new ExitError(3, 'нужен --out-dir (каталог для отчёта и снимка)');
  if (mergesOnly && (suppliersPath || contractorsPath))
    throw new ExitError(3, '--merges-only — склейка по текущей таблице, без файлов');
  if (!suppliersPath && !contractorsPath && !mergesOnly)
    throw new ExitError(
      3,
      'нужен хотя бы один файл: --suppliers и/или --contractors (или --merges-only)',
    );
  if ((nearInn || pairsPath) && !suppliersPath && !mergesOnly)
    throw new ExitError(
      3,
      '--near-inn и --pairs работают со склейкой: --suppliers или --merges-only',
    );

  const issues: ParseIssue[] = [];
  const files: Array<{ label: string; path: string; sha256: string }> = [];
  let billhub: BillhubSupplier[] | undefined;
  let contractors: OneCContractor[] | undefined;
  if (suppliersPath) {
    const parsed = parseBillhubSupplierRows(readSheet(suppliersPath, 'Поставщики'));
    printIssues('BillHub', parsed.issues);
    issues.push(...parsed.issues);
    billhub = parsed.suppliers;
    files.push({
      label: 'поставщики BillHub',
      path: suppliersPath,
      sha256: await sha256(suppliersPath),
    });
    console.info(`BillHub: строк ${parsed.suppliers.length}`);
  }
  if (contractorsPath) {
    const parsed = parseOneCContractorRows(readSheet(contractorsPath, 'TDSheet'));
    printIssues('1С', parsed.issues);
    issues.push(...parsed.issues);
    contractors = parsed.contractors;
    files.push({
      label: 'подрядчики 1С',
      path: contractorsPath,
      sha256: await sha256(contractorsPath),
    });
    console.info(`1С: уникальных подрядчиков ${parsed.contractors.length}`);
  }
  let pairs: ManualPair[] = [];
  if (pairsPath) {
    const parsed = parseManualPairs(await readFile(pairsPath, 'utf8'));
    for (const e of parsed.errors) console.error(`Пары: ${e}`);
    if (parsed.errors.length > 0)
      throw new ExitError(3, 'файл пар не прошёл проверку — в базу ничего не записано');
    pairs = parsed.pairs;
    files.push({ label: 'ручные пары', path: pairsPath, sha256: await sha256(pairsPath) });
    console.info(`Ручных пар: ${pairs.length}`);
  }
  if (issues.some((i) => i.fatal))
    throw new ExitError(3, 'файл не прошёл проверку — в базу ничего не записано');

  const lockTimeoutMs = lockTimeoutArg ? Number(lockTimeoutArg) : undefined;
  await mkdir(outDir, { recursive: true });
  const ts = stamp();
  const result = await runDirectoriesImport(
    db,
    { suppliers: billhub, contractors, mergesOnly, nearInn, pairs },
    {
      apply,
      confirm: confirm ?? undefined,
      lockTimeoutMs,
      beforeWrite: async (snapshot: ImportSnapshot) => {
        const path = join(outDir, `snapshot-${ts}.json`);
        await writeFile(path, JSON.stringify(snapshot, null, 2));
        console.info(`Снимок для отката: ${path}`);
      },
    },
  );
  printSummary(result);

  const extras = await collectReportExtras(db, result);
  const reportPath = join(outDir, `report-${ts}-${apply ? 'apply' : 'dryrun'}.xlsx`);
  await writeFile(
    reportPath,
    await buildImportReportXlsx(result, extras, {
      mode: apply ? 'apply' : 'dry-run',
      files,
      issues,
    }),
  );
  console.info(`Отчёт: ${reportPath}`);
  if (!apply) {
    console.info(
      result.plan.opCount === 0
        ? 'Изменений нет.'
        : `Записать: тот же запуск с --apply --confirm ${result.plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}`,
    );
  } else {
    console.info('Записано. Повторный dry-run должен показать 0 операций.');
  }
}

async function runRevert(path: string): Promise<void> {
  if (!outDir) throw new ExitError(3, 'нужен --out-dir (каталог для отчёта отката)');
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as ImportSnapshot;
  const result = await revertDirectoriesImport(db, snapshot, {
    apply,
    lockTimeoutMs: lockTimeoutArg ? Number(lockTimeoutArg) : undefined,
  });
  const p = result.plan;
  console.info(
    `Откат: поставщиков вернуть ${p.supplierRestores.length} (конфликтов ${p.supplierConflicts.length}), ` +
      `восстановить дублей ${p.reinserts.length}, документов вернуть ${p.repoints.reduce((n, r) => n + r.docIds.length, 0)}, ` +
      `удалить новых ${p.supplierDeletes.length} (оставить ${p.supplierKept.length}); ` +
      `подрядчиков вернуть ${p.contractorRestores.length} (конфликтов ${p.contractorConflicts.length}), ` +
      `удалить ${p.contractorDeletes.length} (оставить ${p.contractorKept.length})`,
  );
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, `revert-${stamp()}-${apply ? 'apply' : 'dryrun'}.json`);
  await writeFile(out, JSON.stringify(result, null, 2));
  console.info(`Подробности: ${out}`);
  if (!apply) console.info('Выполнить: тот же запуск с --apply.');
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

async function main(): Promise<number> {
  try {
    if (revertPath) await runRevert(revertPath);
    else await runImport();
    return 0;
  } catch (err) {
    if (err instanceof ExitError) {
      console.error(err.message);
      return err.exitCode;
    }
    if (err instanceof DirectoriesImportError) {
      console.error(`Импорт не выполнен: ${err.message}`);
      return err.code === 'busy' || err.code === 'fingerprint' ? 2 : 1;
    }
    // 55P03 — не дождались блокировки (lock_timeout), 57014 — statement_timeout.
    const code = pgCode(err);
    if (code === '55P03' || code === '57014') {
      console.error(
        `Не дождались блокировки (${code}) — в базу ничего не записано. Повторите позже.`,
      );
      return 2;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.exitCode = await main();
