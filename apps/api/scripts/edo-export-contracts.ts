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
 * Портал не страдает:
 *   - скачивание идёт частями (--chunk-minutes) и между ними отпускает учётку,
 *     дожидаясь прохода автовыгрузки УПД, — реестр УПД не отстаёт;
 *   - пауза между запросами к Диадоку (--pause-ms);
 *   - при нехватке места на диске (--min-free-gb) скачивание останавливается само.
 *
 * Коды выхода: 0 — опись полная / выгрузка завершена; 1 — опись неполная,
 * выгрузка не завершена или сбой (файлы и отчёт записаны); 2 — учётку держит
 * другая работа по ЭДО или лиз потерян.
 *
 * Запуск на бою без деплоя: разовый контейнер из работающего образа, свежий код
 * подложен монтированием (из ~/app после `git pull --ff-only`). Каталог /data
 * должен быть доступен на запись пользователю 1000.
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -e NODE_OPTIONS=--max-old-space-size=512 -v /srv/matcheck/tmp:/data \
 *     -v "$PWD/apps/api/src:/app/apps/api/src:ro" -v "$PWD/apps/api/scripts:/app/apps/api/scripts:ro" \
 *     -v "$PWD/packages/contracts/src:/app/packages/contracts/src:ro" matcheck-api \
 *     node_modules/.bin/tsx scripts/edo-export-contracts.ts --inventory --since 2021-11-02 --out-dir /data/edo-contracts
 *   … --download --out-dir /data/edo-contracts [--include spec,protocol,agreement] [--add-rows /data/rows.txt]
 *               [--limit 5] [--chunk-minutes 25] [--max-minutes 480] [--pause-ms 150] [--min-free-gb 5]
 *               [--max-file-mb 50]
 *   … --verify --out-dir /data/edo-contracts
 */
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, statfs } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { edoAccounts } from '../src/db/schema.js';
import { runDownloadInChunks, type ChunkedResult } from '../src/domain/edo/contracts/chunks.js';
import { REVIEW_CATEGORIES, type ReviewCategory } from '../src/domain/edo/contracts/classify.js';
import {
  DownloadRefused,
  assertDownloadable,
  collectDownloadState,
  runContractDownload,
  type DownloadState,
} from '../src/domain/edo/contracts/download.js';
import { runContractInventory } from '../src/domain/edo/contracts/inventory.js';
import { writeContractsXlsx } from '../src/domain/edo/contracts/inventory-xlsx.js';
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
import { isRunnerSkipped, runWithEdoClient } from '../src/domain/jobs/edo-poll-runner.js';
import { loadEnv } from '../src/lib/env.js';
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
  '--chunk-minutes',
  '--pause-ms',
  '--min-free-gb',
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

function nonNegativeInt(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} ждёт целое число не меньше нуля`);
  return n;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  if (!isRunnerSkipped(outcome)) return null;
  const skipped = outcome.skipped;
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
  await writeContractsXlsx(path.join(outDir, XLSX_FILE), snapshot, download);
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

/** Новый завершённый проход автовыгрузки УПД, начатый после `after`. */
async function waitAutoExportPass(accountId: string, after: Date, maxWaitMs: number): Promise<boolean> {
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from edo_export_runs
       where edo_account_id = ${accountId} and outcome = 'completed' and started_at > ${after}`;
    if ((row?.n ?? 0) > 0) return true;
    if (Date.now() >= until) return false;
    await sleep(30_000);
  }
}

const STOP_MESSAGES: Record<ChunkedResult['stoppedBy'], string> = {
  done: 'Всё выбранное обработано.',
  limit: 'Остановлено по --limit.',
  deadline: 'Остановлено по общему времени (--max-minutes); запустите ещё раз — продолжит с того же места.',
  disk: 'Остановлено: мало места на диске (--min-free-gb). Освободите место и запустите ещё раз.',
  lease_lost: 'Лиз потерян — учётку забрала другая работа; запустите ещё раз.',
  lease_busy: 'Учётка долго занята другой работой по ЭДО; запустите позже.',
  no_box: 'У учётной записи не выбран ящик.',
  not_found: 'Учётная запись не найдена.',
};

async function download(outDir: string, args: Map<string, string>): Promise<number> {
  const snapshot = await readSnapshot(outDir);
  assertDownloadable(snapshot);
  const include = (args.get('--include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = include.filter((c) => !(REVIEW_CATEGORIES as readonly string[]).includes(c));
  if (unknown.length > 0) throw new Error(`--include: неизвестные категории ${unknown.join(', ')}; есть ${REVIEW_CATEGORIES.join(', ')}`);
  const addRows = await readAddRows(args.get('--add-rows'));
  const limit = positiveInt(args.get('--limit'), '--limit', null);
  const maxMinutes = positiveInt(args.get('--max-minutes'), '--max-minutes', 480)!;
  const chunkMinutes = positiveInt(args.get('--chunk-minutes'), '--chunk-minutes', 25)!;
  const pauseMs = nonNegativeInt(args.get('--pause-ms'), '--pause-ms', 150);
  const minFreeGb = nonNegativeInt(args.get('--min-free-gb'), '--min-free-gb', 5);
  const maxFileMb = positiveInt(args.get('--max-file-mb'), '--max-file-mb', 50)!;
  const account = await resolveAccount(snapshot.accountId);
  const autoExportEnabled = loadEnv().EDO_EXPORT_AUTO_ENABLED;
  const freeBytes = async () => {
    const st = await statfs(outDir);
    return Number(st.bavail) * Number(st.bsize);
  };
  console.info(
    `Части по ${chunkMinutes} мин, всего не больше ${maxMinutes} мин, пауза ${pauseMs} мс, порог диска ${minFreeGb} ГБ; ` +
      (autoExportEnabled ? 'между частями — ожидание прохода автовыгрузки УПД.' : 'автовыгрузка УПД выключена — без ожидания.'),
  );

  const result = await runDownloadInChunks(
    {
      runChunk: (deadline, left) =>
        runWithEdoClient(runnerDeps(), account.id, (session) =>
          runContractDownload(session, snapshot, {
            outDir,
            include: include as ReviewCategory[],
            addRows,
            limit: left,
            deadline,
            pauseMs,
            freeBytes,
            minFreeBytes: minFreeGb * 1024 ** 3,
            maxFileBytes: maxFileMb * 1024 * 1024,
            log: (l) => console.info(l),
          }),
        ),
      waitAutoExportPass: (after, maxWaitMs) => waitAutoExportPass(account.id, after, maxWaitMs),
      autoExportEnabled,
      now: () => new Date(),
      sleep,
      log: (l) => console.info(l),
    },
    {
      chunkMs: chunkMinutes * 60_000,
      overallDeadline: new Date(Date.now() + maxMinutes * 60_000),
      limit,
      waitPassMaxMs: 35 * 60_000,
      leaseRetryMs: 60_000,
      leaseRetries: 40,
    },
  );
  console.info(
    `Частей: ${result.chunks}, обработано документов: ${result.processed}, запросов: ${result.requests}, ошибок: ${result.errors}`,
  );
  console.info(STOP_MESSAGES[result.stoppedBy]);

  const state = await collectDownloadState(outDir, snapshot);
  await writeReports(outDir, snapshot, state);
  printDownloadState(state);
  if (result.stoppedBy === 'lease_lost' || result.stoppedBy === 'lease_busy') return 2;
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
