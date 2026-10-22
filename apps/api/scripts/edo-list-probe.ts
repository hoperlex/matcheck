/**
 * Проба списка документов Диадока (GetDocuments V3) против реестра выгрузки —
 * запуск. Что и зачем проверяется — в src/domain/edo/list-probe.ts.
 *
 * Только чтение: работает под лизом учётки (под ним обменивается
 * refresh-токен), в БД и хранилище ничего не пишет. Результат — JSON-файл и
 * сводка в stdout.
 *
 * Коды выхода: 0 — все шаги прошли; 1 — шаг упал или доступ неполный (файл
 * всё равно записан); 2 — учётку держит другая работа по ЭДО или лиз потерян.
 *
 * Запуск на бою (каталог /data должен быть доступен пользователю node на запись):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/tmp:/data matcheck-api \
 *     node_modules/.bin/tsx scripts/edo-list-probe.ts --month 2026-09 --out /data/edo-probe.json
 */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { edoAccounts } from '../src/db/schema.js';
import { EdoLeaseLost } from '../src/domain/edo/inventory.js';
import { DIADOC_PROVIDER, isDiadocAccount } from '../src/domain/edo/provider.js';
import {
  runListProbe,
  type ProbeRegistryRow,
  type ProbeReport,
} from '../src/domain/edo/list-probe.js';
import { runWithEdoClient } from '../src/domain/jobs/edo-poll-runner.js';
import { logger } from '../src/lib/logger.js';

const FLAGS_WITH_VALUE = new Set(['--month', '--out', '--account', '--max-read']);

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!FLAGS_WITH_VALUE.has(flag)) throw new Error(`неизвестный флаг «${flag}»`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`флагу ${flag} нужно значение`);
    out.set(flag, value);
    i++;
  }
  return out;
}

type Account = typeof edoAccounts.$inferSelect;

async function resolveAccount(accountId: string | undefined): Promise<Account> {
  if (accountId) {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, accountId)).limit(1);
    if (!row) throw new Error(`учётная запись ЭДО ${accountId} не найдена`);
    if (!isDiadocAccount(row)) throw new Error(`учётная запись ${accountId} — не Диадок (${row.provider}); проба только для Диадока`);
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

async function loadRegistry(accountId: string): Promise<ProbeRegistryRow[]> {
  return sql<ProbeRegistryRow[]>`
    select message_id, entity_id, status, document_type, document_number,
           to_char(document_date, 'YYYY-MM-DD') as document_date, document_function,
           correction_number, total_sum::text as total_sum, vat_sum::text as vat_sum,
           supplier_inn, supplier_name, seller_inns, received_at
      from edo_export_documents
     where edo_account_id = ${accountId}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const monthArg = args.get('--month');
  const outPath = args.get('--out');
  if (!monthArg || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthArg)) throw new Error('укажите --month ГГГГ-ММ');
  if (!outPath) throw new Error('укажите --out <файл.json>');
  const maxRead = Number(args.get('--max-read') ?? 3000);
  if (!Number.isInteger(maxRead) || maxRead < 1) throw new Error('--max-read ждёт целое число');

  const account = await resolveAccount(args.get('--account'));
  const report: ProbeReport = {
    startedAt: new Date().toISOString(),
    month: monthArg,
    requests: 0,
    steps: {},
    errors: [],
    summary: [],
  };
  let code = 0;
  try {
    const outcome = await runWithEdoClient(
      { db, log: logger.child({ service: 'edo-list-probe' }), owner: randomUUID() },
      account.id,
      (session) =>
        runListProbe(session, { month: monthArg, maxRead, loadRegistry: () => loadRegistry(account.id) }, report),
    );
    if (outcome && typeof outcome === 'object' && 'skipped' in outcome) {
      console.error(
        outcome.skipped === 'lease_taken'
          ? 'Учётная запись занята другой работой по ЭДО (осмотр, пробный разбор, выгрузка). Запустите позже.'
          : `Проба невозможна: ${outcome.skipped === 'no_box' ? 'у учётной записи не выбран ящик' : 'учётная запись не найдена'}`,
      );
      return outcome.skipped === 'lease_taken' ? 2 : 1;
    }
  } catch (err) {
    if (!(err instanceof EdoLeaseLost)) throw err;
    report.errors.push({ step: 'lease', error: 'лиз потерян — учётку забрала другая работа' });
    code = 2;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(outPath, JSON.stringify(report, null, 2), 'utf-8');
    console.info(`Отчёт: ${outPath}`);
  }
  console.info(
    [
      `Запросов к Диадоку: ${report.requests}`,
      ...report.summary,
      report.errors.length ? `Шагов с ошибкой: ${report.errors.length}` : 'Все шаги прошли.',
    ].join('\n'),
  );
  const access = report.steps.access as { full?: boolean } | undefined;
  if (code === 0 && (report.errors.length > 0 || !access?.full)) code = 1;
  return code;
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
