/**
 * Ручной проход выгрузки реестра УПД из СБИС — тот же, что делает mail-worker
 * (src/domain/jobs/sbis-export-runner.ts), но по команде и независимо от
 * EDO_SBIS_ENABLED. Им делают первую загрузку истории (с EDO_SBIS_SINCE) и
 * проверку перед включением выключателя.
 *
 * Что делает: под лизом учётки читает ленту СБИС с постоянного курсора, кладёт
 * входящие УПД события «Получение» в хранилище и реестр edo_export_documents,
 * повторяет сбои по расписанию, пишет журнал edo_export_runs. Карточек не создаёт.
 *
 *   --account <uuid>   учётка СБИС (без флага — единственная активная с организацией)
 *   --passes N         повторять проход, пока он упирается в предел (первая загрузка
 *                      истории — несколько проходов); по умолчанию 1
 *   --max-events N     предел событий одного прохода (по умолчанию EDO_EXPORT_MAX_EVENTS)
 *   --max-downloads N  предел скачиваний (по умолчанию EDO_EXPORT_MAX_DOWNLOADS)
 *
 * Пустая страница ленты не объявляет её дочитанной: проход оставляет в курсоре
 * подтверждение, и следующий проход (этот же скрипт через 1–5 минут или
 * mail-worker) начнёт с него.
 *
 * Коды выхода: 0 — проход дошёл до конца ленты; 1 — ошибка или упор в предел;
 * 2 — учётка занята другой работой или лиз потерян.
 *
 * Запуск на бою:
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T matcheck-api \
 *     node_modules/.bin/tsx scripts/sbis-export.ts --passes 10
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { edoAccounts } from '../src/db/schema.js';
import { SBIS_PROVIDER } from '../src/domain/edo/sbis/sbis-account.js';
import { runSbisExportPass, type SbisExportResult } from '../src/domain/jobs/sbis-export-runner.js';
import { putObject } from '../src/domain/storage/s3.signer.js';
import { loadEnv } from '../src/lib/env.js';
import { logger } from '../src/lib/logger.js';

const { values: args } = parseArgs({
  options: {
    account: { type: 'string' },
    passes: { type: 'string', default: '1' },
    'max-events': { type: 'string' },
    'max-downloads': { type: 'string' },
  },
});

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name}: ожидается целое больше нуля`);
  return n;
}

async function resolveAccount(): Promise<string> {
  if (args.account) {
    const [row] = await db.select().from(edoAccounts).where(eq(edoAccounts.id, args.account)).limit(1);
    if (!row) throw new Error(`учётка ${args.account} не найдена`);
    if (row.provider !== SBIS_PROVIDER) throw new Error(`учётка ${args.account} — не СБИС (${row.provider})`);
    return row.id;
  }
  const rows = await db
    .select({ id: edoAccounts.id, name: edoAccounts.name })
    .from(edoAccounts)
    .where(and(eq(edoAccounts.provider, SBIS_PROVIDER), eq(edoAccounts.isActive, true), isNotNull(edoAccounts.boxId)));
  if (rows.length === 1) return rows[0]!.id;
  const names = rows.map((r) => `${r.id} (${r.name})`).join(', ') || 'нет ни одной';
  throw new Error(`выберите учётку через --account; активных учёток СБИС с организацией: ${names}`);
}

function report(i: number, result: SbisExportResult): void {
  if ('skipped' in result) {
    console.info(`Проход ${i}: пропущен (${result.skipped})`);
    return;
  }
  const s = result.summary;
  console.info(
    [
      `Проход ${i}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`,
      `  страниц ${s.pages}, событий ${s.eventsSeen}, УПД «Получение» ${s.candidates}`,
      `  сохранено ${s.stored}, сбоев ${s.failed}, уже в реестре ${s.alreadyKnown}, повторно получено ${s.revisionsIgnored}`,
      `  скачиваний ${s.downloads}, свежих ссылок ${s.refreshedLinks}, восстановлений курсора ${s.cursorRecoveries}`,
      `  повторы: ${result.retry ? `взято ${result.retry.picked}, сохранено ${result.retry.stored}, закрыто ${result.retry.closed}` : '—'}`,
      `  лента: ${s.feedConfirmed ? 'проверена до границы подтверждения' : s.confirmPending ? 'пустая страница ждёт подтверждения' : s.truncated ? 'упор в предел' : '—'}`,
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const env = loadEnv();
  const passes = positiveInt('passes', args.passes, 1);
  const mode = {
    trigger: 'script' as const,
    maxEvents: positiveInt('max-events', args['max-events'], env.EDO_EXPORT_MAX_EVENTS),
    maxDownloads: positiveInt('max-downloads', args['max-downloads'], env.EDO_EXPORT_MAX_DOWNLOADS),
  };
  const accountId = await resolveAccount();
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
  const deps = {
    db,
    log: logger.child({ service: 'sbis-export-script' }),
    owner: randomUUID(),
    put: putObject,
    signal: controller.signal,
  };

  let last: SbisExportResult | null = null;
  for (let i = 1; i <= passes; i++) {
    last = await runSbisExportPass(deps, accountId, mode);
    report(i, last);
    if ('skipped' in last || last.outcome !== 'truncated') break;
  }
  if (!last || 'skipped' in last) return last && last.skipped === 'lease_taken' ? 2 : 1;
  if (last.outcome === 'stopped') return 2;
  return last.outcome === 'completed' ? 0 : 1;
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
