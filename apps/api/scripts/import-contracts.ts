/**
 * Импорт договоров с контрагентами из 1С (выгрузка «Договоры с контрагентами
 * из группы Снабжение», xlsx) в справочник supplier_contracts. Договоры потом
 * выбирают в карточке приёмки кнопкой «+ Договор».
 *
 * Логика — в src/domain/supplier-contracts/ (parse, site-rules, plan, apply,
 * report). Здесь только чтение файла, вывод, отчёт и снимок для отката.
 *
 * Порядок работы:
 *   1. dry-run (по умолчанию) — только чтение; печатает отпечаток плана и пишет
 *      report-*-dryrun.xlsx (листы «Объекты» и «Спорные объекты» — на сверку
 *      до записи). Можно запускать под read-only ролью.
 *   2. --apply --confirm <первые 16 символов отпечатка> — та же сверка внутри
 *      транзакции под advisory-lock; если план изменился — код 2. Перед
 *      записью — snapshot-*.json (внутри транзакции: если запись откатилась,
 *      снимок останется, но --revert его отклонит).
 *   3. повторный dry-run должен показать 0 операций.
 *   Если из выгрузки пропало больше 20 % живых договоров — без
 *   --allow-mass-missing запись не идёт (похоже на выгрузку другой группы).
 *
 * Откат данных импорта: --revert <snapshot.json> (dry-run: препятствия и
 * отпечаток), затем то же с --apply --confirm <отпечаток отката>. Откатывается
 * только ДЕЙСТВУЮЩИЙ (последний) импорт и только целиком: если договор из
 * импорта уже выбран в приёмке или строка изменилась после импорта — откат не
 * выполняется вовсе. Откат фичи целиком — сначала код, потом 0144_down.sql.
 *
 * Запуск на бою (контейнер под uid 1000, каталог вывода ему доступен на запись):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/tmp:/data matcheck-api node_modules/.bin/tsx scripts/import-contracts.ts \
 *     --file /data/contracts-1c-2026-11-10.xlsx --out-dir /data/contracts-2026-11-10
 *
 * Локально:
 *   pnpm --filter @matcheck/api exec tsx scripts/import-contracts.ts --file … --out-dir …
 *
 * Файл 1С читается только SheetJS: часть книги называется xl/SharedStrings.xml
 * (с заглавной), ExcelJS её не находит.
 *
 * Коды выхода: 0 — успех; 1 — ошибка или откат транзакции; 2 — занято другим
 * импортом, не дождались блокировки или план изменился после dry-run; 3 — файл
 * не прошёл проверку, массовая пропажа без флага или откат с препятствиями.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import XLSX from 'xlsx';
import { db, sql } from '../src/db/client.js';
import {
  ContractsImportError,
  runContractsImport,
  runContractsRevert,
  validateSnapshot,
  type ContractsImportSnapshot,
} from '../src/domain/supplier-contracts/apply.js';
import { parseContractRows, type ContractParseIssue } from '../src/domain/supplier-contracts/parse.js';
import { FINGERPRINT_SHOWN } from '../src/domain/supplier-contracts/plan.js';
import { buildContractsReportXlsx, buildRevertReportXlsx } from '../src/domain/supplier-contracts/report.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const filePath = argValue('--file');
const outDir = argValue('--out-dir');
const confirm = argValue('--confirm');
const revertPath = argValue('--revert');
const lockTimeoutArg = argValue('--lock-timeout-ms');
const apply = process.argv.includes('--apply');
const allowMassMissing = process.argv.includes('--allow-mass-missing');

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

function readSheet(path: string): unknown[][] {
  const wb = XLSX.readFile(path);
  const name = wb.SheetNames[0];
  const ws = name ? wb.Sheets[name] : undefined;
  if (!ws) throw new ExitError(3, `в книге ${path} нет листов`);
  // raw: false — ИНН и даты остаются строками как в 1С.
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: false });
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function printIssues(issues: ContractParseIssue[]) {
  if (issues.length === 0) return;
  console.info(`Замечаний разбора: ${issues.length}`);
  for (const i of issues.slice(0, 30)) {
    console.info(`  строка ${i.rowNo}${i.fatal ? ' [ФАТАЛЬНО]' : ''}: ${i.message}${i.value ? ` «${i.value}»` : ''}`);
  }
  if (issues.length > 30) console.info(`  … и ещё ${issues.length - 30} (все — в отчёте)`);
}

function lockTimeoutMs(): number | undefined {
  return lockTimeoutArg ? Number(lockTimeoutArg) : undefined;
}

async function runImport(): Promise<void> {
  if (!filePath || !outDir) {
    throw new ExitError(3, 'нужны --file <xlsx> и --out-dir <каталог>');
  }
  if (apply && !confirm) throw new ExitError(3, '--apply требует --confirm <отпечаток из dry-run>');
  await mkdir(outDir, { recursive: true });

  const fileSha256 = await sha256(filePath);
  const rows = readSheet(filePath);
  const { contracts, issues } = parseContractRows(rows);
  printIssues(issues);
  if (issues.some((i) => i.fatal)) {
    throw new ExitError(3, 'файл не прошёл проверку — в базу ничего не записано');
  }
  console.info(`Файл: ${filePath}\n  sha256 ${fileSha256}\n  договоров ${contracts.length}`);

  let snapshotPath: string | null = null;
  const result = await runContractsImport(
    db,
    contracts,
    { fileName: basename(filePath), fileSha256, rowsTotal: contracts.length },
    {
      apply,
      confirm: confirm ?? undefined,
      allowMassMissing,
      lockTimeoutMs: lockTimeoutMs(),
      beforeWrite: async (snapshot: ContractsImportSnapshot) => {
        snapshotPath = join(outDir, `snapshot-${stamp()}.json`);
        await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
        console.info(`Снимок для отката: ${snapshotPath}`);
      },
    },
  );

  const p = result.plan;
  console.info(
    `План: новых ${p.inserts.length}, изменённых ${p.updates.filter((u) => u.changed.length > 0).length}, ` +
      `вернулись ${p.returned}, пропали ${p.missing.length}, без изменений ${p.unchanged}`,
  );
  if (p.affectedLinks.length > 0) {
    console.info(`Затронутые привязки к приёмкам: ${p.affectedLinks.length} (лист «Затронутые привязки»)`);
  }
  if (p.massMissing) {
    console.info(
      `ВНИМАНИЕ: пропали ${p.missing.length} из ${p.liveBefore} живых договоров (> 20 %) — ` +
        'запись потребует --allow-mass-missing',
    );
  }
  console.info(`Отпечаток плана: ${p.fingerprint.slice(0, FINGERPRINT_SHOWN)}  (полный ${p.fingerprint})`);

  const reportPath = join(outDir, `report-${stamp()}-${result.applied ? 'apply' : 'dryrun'}.xlsx`);
  await writeFile(
    reportPath,
    await buildContractsReportXlsx(contracts, result.state, p, {
      mode: result.applied ? 'apply' : 'dry-run',
      file: { path: filePath, sha256: fileSha256 },
      issues,
    }),
  );
  console.info(`Отчёт: ${reportPath}`);

  if (!apply) {
    if (p.opCount === 0) console.info('Изменений нет — записывать нечего.');
    else console.info(`Запись: --apply --confirm ${p.fingerprint.slice(0, FINGERPRINT_SHOWN)}`);
    return;
  }
  if (!result.applied) {
    console.info('Изменений нет — ничего не записано.');
    return;
  }
  console.info(`Записано. Импорт ${result.snapshot?.importId}. Снимок: ${snapshotPath ?? '—'}`);
}

async function runRevert(path: string): Promise<void> {
  const snapshot = validateSnapshot(JSON.parse(await readFile(path, 'utf8')));
  const result = await runContractsRevert(db, snapshot, {
    apply,
    confirm: confirm ?? undefined,
    lockTimeoutMs: lockTimeoutMs(),
  });
  console.info(
    `Откат импорта ${snapshot.importId}: вернуть строк ${result.restore}, удалить договоров ${result.remove}, ` +
      `препятствий ${result.obstacles.length}`,
  );
  for (const o of result.obstacles.slice(0, 30)) {
    console.info(
      `  ${o.onecId}: ${o.detail}${o.deliveries?.length ? ` — приёмки ${o.deliveries.join(', ')}` : ''}`,
    );
  }
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    const reportPath = join(outDir, `revert-${stamp()}-${result.applied ? 'apply' : 'dryrun'}.xlsx`);
    await writeFile(reportPath, await buildRevertReportXlsx(result, snapshot.importId));
    console.info(`Отчёт: ${reportPath}`);
  }
  if (!apply) {
    if (result.obstacles.length > 0) {
      throw new ExitError(3, 'откат невозможен: есть препятствия — частичного отката не бывает');
    }
    console.info(`Откат: --revert ${path} --apply --confirm ${result.fingerprint.slice(0, FINGERPRINT_SHOWN)}`);
    return;
  }
  console.info('Откат выполнен.');
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
    if (err instanceof ContractsImportError) {
      console.error(`Не выполнено: ${err.message}`);
      if (err.code === 'busy' || err.code === 'fingerprint') return 2;
      if (
        err.code === 'mass_missing' ||
        err.code === 'obstacles' ||
        err.code === 'bad_snapshot' ||
        err.code === 'not_applied' ||
        err.code === 'already_reverted' ||
        err.code === 'not_latest'
      ) {
        return 3;
      }
      return 1;
    }
    const code = pgCode(err);
    if (code === '55P03' || code === '57014') {
      console.error(`Не дождались блокировки (${code}) — в базу ничего не записано. Повторите позже.`);
      return 2;
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.exitCode = await main();
