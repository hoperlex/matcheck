/**
 * Импорт связей «подрядчик × объект → вид» из выгрузки 1С «Списание по
 * субподряду» (ПроектРодитель, Контрагент, число и сумма документов
 * «Реализация» / «Давальческий акт») в customer_counterparty_sites (0159).
 * На портале — колонка «Объекты и вид» во вкладке «Справочники → Контрагенты».
 *
 * Импорт пишет ТОЛЬКО слой onec_*: правки из карточки контрагента (manual_*)
 * не трогает, скрытые вручную строки не возвращает. Справочник контрагентов не
 * меняет: ненайденные подрядчики и неопределённые объекты — в отчёт, их
 * добавляют руками в карточке.
 *
 * Логика — в src/domain/contractor-sites/ (parse, plan, apply, report).
 *
 * Порядок работы:
 *   1. dry-run (по умолчанию) — только чтение, без блокировок: печатает сводку и
 *      отпечаток плана, пишет отчёт. Можно под read-only ролью.
 *   2. --apply --confirm <первые 16 символов отпечатка> — та же сверка внутри
 *      транзакции под блокировками; если база изменилась и план другой —
 *      ROLLBACK, код 2, нужен новый dry-run. Перед записью — snapshot-*.json.
 *      Воркер останавливать не нужно: он эту таблицу не трогает.
 *   3. повторный dry-run должен показать 0 операций.
 *   Откат слоя 1С к снимку: --revert <snapshot.json> (dry-run, печатает
 *   отпечаток), затем то же с --apply --confirm <отпечаток>.
 *
 * Запуск на бою (контейнер под uid 1000, каталог вывода ему доступен на запись):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/tmp:/data matcheck-api node_modules/.bin/tsx scripts/import-contractor-sites.ts \
 *     --file /data/1c-spisanie-2026-11-25.xlsx --out-dir /data/contractor-sites-2026-11-25
 *
 * Локально:
 *   pnpm --filter @matcheck/api exec tsx scripts/import-contractor-sites.ts --file … --out-dir …
 *
 * Коды выхода: 0 — успех; 1 — ошибка или откат транзакции; 2 — занято другим
 * импортом, не дождались блокировки или план изменился после dry-run; 3 — файл
 * не прошёл проверку (до любой работы с базой).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { CONTRACTOR_SITE_KIND_LABELS } from '@matcheck/contracts';
import { db, sql } from '../src/db/client.js';
import {
  ContractorSitesImportError,
  runContractorSitesImport,
  type ImportResult,
} from '../src/domain/contractor-sites/apply.js';
import {
  parseContractorSiteRows,
  readContractorSitesSheet,
  type ContractorSiteIssue,
} from '../src/domain/contractor-sites/parse.js';
import {
  buildFileTarget,
  FINGERPRINT_SHOWN,
  snapshotTarget,
  type ContractorSitesPlan,
  type ContractorSitesSnapshot,
  type FileTarget,
} from '../src/domain/contractor-sites/plan.js';
import { buildContractorSitesReportXlsx } from '../src/domain/contractor-sites/report.js';

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

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function printIssues(issues: ContractorSiteIssue[]) {
  if (issues.length === 0) return;
  console.info(`Замечаний разбора: ${issues.length}`);
  for (const i of issues.slice(0, 30)) {
    console.info(
      `  строка ${i.rowNo}${i.fatal ? ' [ФАТАЛЬНО]' : ''}: ${i.message}${i.value ? ` «${i.value}»` : ''}`,
    );
  }
  if (issues.length > 30) console.info(`  … и ещё ${issues.length - 30} (все — в отчёте)`);
}

function printPlan(plan: ContractorSitesPlan, timings: ImportResult<unknown>['timings']) {
  const c = plan.counts;
  console.info(
    `План: новых ${c.insert}, обновить ${c.update}, снять данные 1С ${c.clear}, удалить ${c.delete}; ` +
      `без изменений ${plan.unchanged}`,
  );
  for (const s of plan.skipped) console.info(`  пропуск ${s.ccId} × ${s.siteId}: ${s.reason}`);
  if (timings)
    console.info(`Блокировки: ждали ${timings.lockWaitMs} мс, держали ${timings.lockHeldMs} мс`);
  console.info(`Всего операций: ${plan.ops.length}`);
  console.info(`Отпечаток плана: ${plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}`);
}

function printTarget(r: ImportResult<FileTarget>) {
  const t = r.target;
  const via = new Map<string, number>();
  for (const m of t.contractorMatches) via.set(m.via, (via.get(m.via) ?? 0) + 1);
  console.info(
    `Подрядчики: сопоставлено ${t.contractorMatches.length} (${[...via].map(([k, n]) => `${k} ${n}`).join(', ')}), ` +
      `не сопоставлено ${t.unresolvedContractors.length}`,
  );
  for (const u of t.unresolvedContractors)
    console.info(`  «${u.raw}»: ${u.reason} (строки ${u.rowNos.join(', ')})`);
  console.info(`Строк без объекта портала: ${t.unresolvedObjects.length}`);
  for (const u of t.unresolvedObjects)
    console.info(`  строка ${u.rowNo} «${u.raw}» — «${u.objectText || '(пусто)'}»: ${u.reason}`);
  const kinds = new Map<string, number>();
  for (const e of t.entries) kinds.set(e.layer.kind, (kinds.get(e.layer.kind) ?? 0) + 1);
  const closed = new Set(r.state.sites.filter((s) => !s.isActive).map((s) => s.id));
  console.info(
    `Связей по файлу: ${t.entries.length} у ${new Set(t.entries.map((e) => e.ccId)).size} подрядчиков — ` +
      [...kinds]
        .map(
          ([k, n]) =>
            `${CONTRACTOR_SITE_KIND_LABELS[k as keyof typeof CONTRACTOR_SITE_KIND_LABELS]} ${n}`,
        )
        .join(', ') +
      `; на закрытых объектах ${t.entries.filter((e) => closed.has(e.siteId)).length}`,
  );
}

function snapshotWriter(dir: string, ts: string) {
  return async (snapshot: ContractorSitesSnapshot) => {
    const path = join(dir, `snapshot-${ts}.json`);
    await writeFile(path, JSON.stringify(snapshot, null, 2));
    console.info(`Снимок для отката: ${path}`);
  };
}

async function runImport(): Promise<void> {
  if (!filePath)
    throw new ExitError(3, 'нужен --file (выгрузка 1С «Списание по субподряду», xlsx)');
  if (!outDir) throw new ExitError(3, 'нужен --out-dir (каталог для отчёта и снимка)');
  const sheet = readContractorSitesSheet(XLSX.readFile(filePath));
  if (!sheet) throw new ExitError(3, `в книге ${filePath} нет листов`);
  const parsed = parseContractorSiteRows(sheet);
  printIssues(parsed.issues);
  if (parsed.issues.some((i) => i.fatal))
    throw new ExitError(3, 'файл не прошёл проверку — в базу ничего не записано');
  const file = { path: filePath, sha256: await sha256(filePath) };
  console.info(
    `Файл: строк с данными ${parsed.rows.length}, подрядчиков ${parsed.contractors.length}, sha256 ${file.sha256.slice(0, 16)}…`,
  );

  await mkdir(outDir, { recursive: true });
  const ts = stamp();
  const result = await runContractorSitesImport(
    db,
    (state) => buildFileTarget(parsed.rows, parsed.contractors, state),
    {
      apply,
      confirm: confirm ?? undefined,
      lockTimeoutMs: lockTimeoutArg ? Number(lockTimeoutArg) : undefined,
      beforeWrite: snapshotWriter(outDir, ts),
    },
  );
  printTarget(result);
  printPlan(result.plan, result.timings);
  if (result.tableMissing)
    console.info(
      'Таблицы customer_counterparty_sites ещё нет (миграция 0159) — dry-run считает её пустой.',
    );

  const reportPath = join(outDir, `report-${ts}-${apply ? 'apply' : 'dryrun'}.xlsx`);
  await writeFile(
    reportPath,
    await buildContractorSitesReportXlsx(result, {
      mode: apply ? 'apply' : 'dry-run',
      file,
      issues: parsed.issues,
    }),
  );
  console.info(`Отчёт: ${reportPath}`);
  if (!apply) {
    console.info(
      result.plan.ops.length === 0
        ? 'Изменений нет.'
        : `Записать: тот же запуск с --apply --confirm ${result.plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}`,
    );
  } else {
    console.info('Записано. Повторный dry-run должен показать 0 операций.');
  }
}

async function runRevert(path: string): Promise<void> {
  if (!outDir) throw new ExitError(3, 'нужен --out-dir (каталог для снимка перед откатом)');
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as ContractorSitesSnapshot;
  let target: ReturnType<typeof snapshotTarget>;
  try {
    target = snapshotTarget(snapshot);
  } catch (err) {
    throw new ExitError(3, err instanceof Error ? err.message : String(err));
  }
  await mkdir(outDir, { recursive: true });
  const result = await runContractorSitesImport(db, () => target, {
    apply,
    confirm: confirm ?? undefined,
    lockTimeoutMs: lockTimeoutArg ? Number(lockTimeoutArg) : undefined,
    beforeWrite: snapshotWriter(outDir, stamp()),
  });
  console.info(`Откат к снимку ${snapshot.takenAt}: связей в снимке ${snapshot.layer.length}`);
  printPlan(result.plan, result.timings);
  if (!apply)
    console.info(
      result.plan.ops.length === 0
        ? 'Откатывать нечего.'
        : `Выполнить: тот же запуск с --apply --confirm ${result.plan.fingerprint.slice(0, FINGERPRINT_SHOWN)}`,
    );
  else console.info('Откат записан.');
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
    if (err instanceof ContractorSitesImportError) {
      console.error(`Импорт не выполнен: ${err.message}`);
      return err.code === 'busy' || err.code === 'fingerprint' ? 2 : 1;
    }
    // 55P03 — не дождались блокировки (lock_timeout), 57014 — statement_timeout,
    // 40P01 — взаимная блокировка (например, объект удаляли в момент записи).
    const code = pgCode(err);
    if (code === '55P03' || code === '57014' || code === '40P01') {
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
