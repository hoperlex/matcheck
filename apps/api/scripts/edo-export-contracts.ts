/**
 * Выгрузка договоров и ДС из Диадока в папку для архива — запуск. Что и зачем
 * делается — в src/domain/edo/contracts/*.
 *
 * Три режима, по одному за запуск:
 *   --inventory  опись без скачивания: inventory.json, опись.xlsx, summary.json;
 *   --download   скачивание по ПОЛНОЙ описи (неполную не берёт), частями;
 *   --verify     проверка, что выгрузка завершена, — без Диадока, по файлам.
 *
 * Только чтение Диадока: работает под лизом учётки (под ним обменивается
 * refresh-токен); в БД, кроме лиза и токена, ничего не пишет, в хранилище — ничего.
 *
 * Коды выхода: 0 — опись полная / выгрузка завершена; 1 — опись неполная,
 * выгрузка не завершена или сбой (файлы и отчёт записаны); 2 — учётку держит
 * другая работа по ЭДО или лиз потерян.
 *
 * Запуск на бою (каталог /data должен быть доступен пользователю node на запись):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/tmp:/data matcheck-api \
 *     node_modules/.bin/tsx scripts/edo-export-contracts.ts --inventory --since 2021-11-02 --out-dir /data/edo-contracts
 *   … --download --out-dir /data/edo-contracts [--include spec,protocol,agreement] [--add-rows /data/rows.txt]
 *               [--limit 5] [--max-minutes 60] [--max-file-mb 50]
 *   … --verify --out-dir /data/edo-contracts
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { edoAccounts } from '../src/db/schema.js';
import { REVIEW_CATEGORIES, type ReviewCategory } from '../src/domain/edo/contracts/classify.js';
import {
  DownloadRefused,
  assertDownloadable,
  collectDownloadState,
  runContractDownload,
  type DownloadState,
} from '../src/domain/edo/contracts/download.js';
import { runContractInventory } from '../src/domain/edo/contracts/inventory.js';
import { buildContractsXlsx } from '../src/domain/edo/contracts/inventory-xlsx.js';
import {
  INVENTORY_FILE,
  PROGRESS_FILE,
  SELECTION_FILE,
  SUMMARY_FILE,
  XLSX_FILE,
  readSnapshot,
  writeJsonAtomic,
  type InventorySnapshot,
} from '../src/domain/edo/contracts/snapshot.js';
import { moscowMidnight } from '../src/domain/edo/list-windows.js';
import { DIADOC_PROVIDER, isDiadocAccount } from '../src/domain/edo/provider.js';
import { runWithEdoClient } from '../src/domain/jobs/edo-poll-runner.js';
import { logger } from '../src/lib/logger.js';

const MODES = new Set(['--inventory', '--download', '--verify']);
const FLAGS_WITH_VALUE = new Set([
  '--since',
  '--out-dir',
  '--account',
  '--include',
  '--add-rows',
  '--limit',
  '--max-minutes',
  '--max-file-mb',
]);

function parseArgs(argv: string[]): { mode: string; args: Map<string, string> } {
  const args = new Map<string, string>();
  const modes: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (MODES.has(flag)) {
      modes.push(flag);
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(flag)) throw new Error(`неизвестный флаг «${flag}»`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`флагу ${flag} нужно значение`);
    args.set(flag, value);
    i++;
  }
  if (modes.length !== 1) throw new Error('укажите ровно один режим: --inventory, --download или --verify');
  return { mode: modes[0]!, args };
}

function positiveInt(raw: string | undefined, flag: string, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} ждёт целое число больше нуля`);
  return n;
}

type Account = typeof edoAccounts.$inferSelect;

async function resolveAccount(accountId: string | undefined): Promise<Account> {
  if (accountId) {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId)).limit(1);
    if (!row) throw new Error(`учётная запись ЭДО ${accountId} не найдена`);
    if (!isDiadocAccount(row)) throw new Error(`учётная запись ${accountId} — не Диадок (${row.provider})`);
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

const runnerDeps = () => ({ db, log: logger.child({ service: 'edo-export-contracts' }), owner: randomUUID() });

function skippedCode(outcome: unknown): number | null {
  if (!outcome || typeof outcome !== 'object' || !('skipped' in outcome)) return null;
  const skipped = (outcome as { skipped: string }).skipped;
  console.error(
    skipped === 'lease_taken'
      ? 'Учётная запись занята другой работой по ЭДО (автовыгрузка, осмотр). Запустите через несколько минут.'
      : `Запуск невозможен: ${skipped === 'no_box' ? 'у учётной записи не выбран ящик' : 'учётная запись не найдена'}`,
  );
  return skipped === 'lease_taken' ? 2 : 1;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeReports(outDir: string, snapshot: InventorySnapshot, download: DownloadState | null): Promise<void> {
  await writeFile(path.join(outDir, XLSX_FILE), await buildContractsXlsx(snapshot, download));
  const count = (sel: string) => snapshot.rows.filter((r) => r.selection === sel).length;
  await writeJsonAtomic(path.join(outDir, SUMMARY_FILE), {
    at: new Date().toISOString(),
    inventory: {
      complete: snapshot.complete,
      reasons: snapshot.reasons,
      notes: snapshot.notes,
      since: snapshot.since,
      until: snapshot.until,
      rows: { auto: count('auto'), review: count('review'), excluded: count('excluded'), unrecognized: count('unrecognized') },
    },
    download: download
      ? {
          complete: download.complete,
          selected: download.selected?.rows.length ?? 0,
          done: download.done,
          pending: download.pending,
        }
      : null,
  });
}

function printDownloadState(state: DownloadState): void {
  const total = state.selected?.rows.length ?? 0;
  if (state.complete) {
    console.info(`Выгрузка завершена: ${state.done} из ${total}. Можно упаковывать архив.`);
    return;
  }
  console.info(`Выгрузка НЕ завершена: готово ${state.done} из ${total}, осталось ${state.pending}.`);
  const unfinished = [...state.rows.values()].filter((r) => !r.complete).slice(0, 20);
  for (const r of unfinished) {
    console.info(`  строка ${r.row}: нет — ${r.missing.join(', ')}${r.error ? `; ${r.error}` : ''}`);
  }
  if (state.pending > unfinished.length) console.info(`  … и ещё ${state.pending - unfinished.length}`);
}

async function inventory(outDir: string, args: Map<string, string>): Promise<number> {
  const since = args.get('--since');
  const m = since ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(since) : null;
  if (!m) throw new Error('укажите --since ГГГГ-ММ-ДД');
  if ((await exists(path.join(outDir, PROGRESS_FILE))) || (await exists(path.join(outDir, SELECTION_FILE)))) {
    throw new Error(`в ${outDir} уже начата выгрузка — новую опись составляйте в другой папке`);
  }
  const account = await resolveAccount(args.get('--account'));
  const sinceDate = moscowMidnight(Number(m[1]), Number(m[2]), Number(m[3]));
  const until = new Date();
  const outcome = await runWithEdoClient(runnerDeps(), account.id, (session) =>
    runContractInventory(session, { since: sinceDate, until, log: (l) => console.info(l) }),
  );
  const skipped = skippedCode(outcome);
  if (skipped !== null) return skipped;
  const snapshot = outcome as InventorySnapshot;
  await writeJsonAtomic(path.join(outDir, INVENTORY_FILE), snapshot);
  await writeReports(outDir, snapshot, null);
  const count = (sel: string) => snapshot.rows.filter((r) => r.selection === sel).length;
  console.info(
    [
      `Опись: ${path.join(outDir, XLSX_FILE)}`,
      `Запросов к Диадоку: ${snapshot.requests}`,
      `Берём: ${count('auto')}, на просмотр: ${count('review')}, похожие — исключены: ${count('excluded')}, не распознаны: ${count('unrecognized')}`,
      ...snapshot.notes.map((n) => `Замечание: ${n}`),
      snapshot.complete ? 'Опись ПОЛНАЯ — по ней можно выгружать.' : 'Опись НЕПОЛНАЯ — выгрузка по ней запрещена:',
      ...snapshot.reasons.map((r) => `  — ${r}`),
    ].join('\n'),
  );
  if (snapshot.complete) return 0;
  return snapshot.reasons.some((r) => r.includes('лиз')) ? 2 : 1;
}

async function readAddRows(file: string | undefined): Promise<number[]> {
  if (!file) return [];
  const tokens = (await readFile(file, 'utf-8')).split(/[\s,;]+/).filter(Boolean);
  const bad = tokens.filter((t) => !/^\d+$/.test(t));
  if (bad.length > 0) throw new Error(`в ${file} не номера строк: ${bad.slice(0, 5).join(', ')}`);
  return tokens.map(Number);
}

async function download(outDir: string, args: Map<string, string>): Promise<number> {
  const snapshot = await readSnapshot(outDir);
  assertDownloadable(snapshot);
  const include = (args.get('--include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = include.filter((c) => !(REVIEW_CATEGORIES as readonly string[]).includes(c));
  if (unknown.length > 0) throw new Error(`--include: неизвестные категории ${unknown.join(', ')}; есть ${REVIEW_CATEGORIES.join(', ')}`);
  const addRows = await readAddRows(args.get('--add-rows'));
  const limit = positiveInt(args.get('--limit'), '--limit', null);
  const maxMinutes = positiveInt(args.get('--max-minutes'), '--max-minutes', 60)!;
  const maxFileMb = positiveInt(args.get('--max-file-mb'), '--max-file-mb', 50)!;
  const account = await resolveAccount(snapshot.accountId);
  const deadline = new Date(Date.now() + maxMinutes * 60_000);

  const outcome = await runWithEdoClient(runnerDeps(), account.id, (session) =>
    runContractDownload(session, snapshot, {
      outDir,
      include: include as ReviewCategory[],
      addRows,
      limit,
      deadline,
      maxFileBytes: maxFileMb * 1024 * 1024,
      log: (l) => console.info(l),
    }),
  );
  const skipped = skippedCode(outcome);
  if (skipped !== null) return skipped;
  const run = outcome as Awaited<ReturnType<typeof runContractDownload>>;
  console.info(`Обработано документов: ${run.processed}, запросов: ${run.requests}, ошибок: ${run.errors}`);
  if (run.stoppedBy === 'limit') console.info('Остановлено по --limit.');
  if (run.stoppedBy === 'deadline') console.info(`Остановлено по времени (--max-minutes ${maxMinutes}); запустите ещё раз — продолжит с того же места.`);
  if (run.stoppedBy === 'lease_lost') console.info('Лиз потерян — учётку забрала другая работа; запустите ещё раз.');

  const state = await collectDownloadState(outDir, snapshot);
  await writeReports(outDir, snapshot, state);
  printDownloadState(state);
  if (run.stoppedBy === 'lease_lost') return 2;
  return state.complete ? 0 : 1;
}

async function verify(outDir: string): Promise<number> {
  const snapshot = await readSnapshot(outDir);
  const state = await collectDownloadState(outDir, snapshot);
  if (!state.selected) {
    console.info('Выгрузка не начиналась (нет selection.json).');
    return 1;
  }
  await writeReports(outDir, snapshot, state);
  printDownloadState(state);
  return state.complete ? 0 : 1;
}

async function main(): Promise<number> {
  const { mode, args } = parseArgs(process.argv.slice(2));
  const outDir = args.get('--out-dir');
  if (!outDir) throw new Error('укажите --out-dir <папка>');
  await mkdir(outDir, { recursive: true });
  try {
    if (mode === '--inventory') return await inventory(outDir, args);
    if (mode === '--download') return await download(outDir, args);
    return await verify(outDir);
  } catch (err) {
    if (err instanceof DownloadRefused) {
      console.error(`Выгрузка не начата: ${err.message}`);
      return 1;
    }
    throw err;
  }
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
