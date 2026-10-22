/**
 * Проба СБИС (Saby) — запуск. Что и зачем проверяется — в
 * src/domain/edo/sbis/probe.ts.
 *
 * Только чтение: к СБИС уходят лишь вход и три читающих метода (разрешающий
 * список в sbis.http.ts), соединение с БД открывается в режиме read only, в
 * хранилище и в edo_accounts ничего не пишется. Результат — JSON-файл, сводка в
 * stdout и, если задан --out-dir, скачанные образцы УПД.
 *
 * Ключи — только в файле infra/secrets/sbis.env (права 600, в git закрыт):
 *   SBIS_APP_CLIENT_ID=…   «ID подключения»
 *   SBIS_APP_SECRET=…      «Защищённый ключ»
 *   SBIS_SECRET_KEY=…      «Сервисный ключ» — без него вход по ключу не пробуется
 *   SBIS_LOGIN=… / SBIS_PASSWORD=…   запасной вход логином
 * Значения не печатаются: только длина и первые 8 знаков sha256.
 *
 * Коды выхода: 0 — все шаги прошли; 1 — вход не удался, не хватает ключей или
 * шаг упал (отчёт всё равно записан).
 *
 * Запуск на adm1 (URL БД и ключи не печатаются):
 *   cd apps/api && NODE_EXTRA_CA_CERTS=/root/projects/matcheck/infra/secrets/yandex-ca/root.crt \
 *     /usr/bin/env -u MATCHECK_DB_RO_URL \
 *     node --env-file=/root/projects/matcheck/infra/secrets/sbis.env \
 *          --env-file=/root/projects/matcheck/infra/secrets/mcp-db.env --import tsx \
 *     scripts/sbis-probe.ts --since 2026-09-01 --sample 5 \
 *     --out /tmp/sbis-probe.json --out-dir /tmp/sbis-xml
 * Без БД (нет MATCHECK_DB_RO_URL и DATABASE_URL) сверка с реестром Диадока пропускается.
 * Если в карточке приложения СБИС заданы «Разрешённые адреса», внешний IP машины
 * должен быть в списке.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import {
  loginByKey,
  loginByPassword,
  missingKeyFields,
  type SbisSession,
} from '../src/domain/edo/sbis/sbis.auth.js';
import { createSbisClient } from '../src/domain/edo/sbis/sbis.client.js';
import type { DiadocCoverageRow } from '../src/domain/edo/sbis/diadoc-coverage.js';
import {
  parseOrgArg,
  runSbisProbe,
  type DiadocRegistryRow,
  type SbisProbeDeps,
  type SbisProbeReport,
} from '../src/domain/edo/sbis/probe.js';
import { parseSbisDateTime } from '../src/domain/edo/sbis/sbis.types.js';

const { values: args } = parseArgs({
  options: {
    since: { type: 'string' },
    until: { type: 'string' },
    org: { type: 'string' },
    'max-docs': { type: 'string', default: '20000' },
    sample: { type: 'string', default: '5' },
    'empty-wait-sec': { type: 'string', default: '60' },
    out: { type: 'string' },
    'out-dir': { type: 'string' },
  },
});

const SECRET_VARS = ['SBIS_APP_CLIENT_ID', 'SBIS_APP_SECRET', 'SBIS_SECRET_KEY', 'SBIS_LOGIN', 'SBIS_PASSWORD'];

function intArg(name: string, value: string | undefined, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name}: целое от ${min} до ${max}`);
  return n;
}

/** «ГГГГ-ММ-ДД» → начало дня по Москве; «ГГГГ-ММ-ДД» для --until → конец дня. */
function dayArg(name: string, value: string, endOfDay: boolean): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = m ? parseSbisDateTime(`${m[3]}.${m[2]}.${m[1]}${endOfDay ? ' 23.59.59' : ''}`) : null;
  if (!date) throw new Error(`--${name}: ожидается дата ГГГГ-ММ-ДД, получено «${value}»`);
  return date;
}

function fingerprint(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) return `${name}: не задан`;
  const sha = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8);
  return `${name}: длина ${value.length}, sha256 ${sha}…`;
}

function chooseLogin(): { mode: 'key' | 'password'; login: () => Promise<SbisSession> } | { missing: string[] } {
  const env = process.env;
  const key = { appClientId: env.SBIS_APP_CLIENT_ID ?? '', appSecret: env.SBIS_APP_SECRET ?? '', secretKey: env.SBIS_SECRET_KEY ?? '' };
  const missing = missingKeyFields(key);
  if (missing.length === 0) return { mode: 'key', login: () => loginByKey(key) };
  if (env.SBIS_LOGIN?.trim() && env.SBIS_PASSWORD) {
    return { mode: 'password', login: () => loginByPassword({ login: env.SBIS_LOGIN!, password: env.SBIS_PASSWORD! }) };
  }
  return { missing: [...missing, 'или SBIS_LOGIN и SBIS_PASSWORD'] };
}

function openReadOnlyDb() {
  const url = process.env.MATCHECK_DB_RO_URL ?? process.env.DATABASE_URL;
  if (!url) return null;
  return postgres(url, {
    max: 2,
    prepare: false,
    connect_timeout: 15,
    ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
    connection: { default_transaction_read_only: true, application_name: 'sbis-probe' },
    onnotice: () => {},
  });
}

type Sql = NonNullable<ReturnType<typeof openReadOnlyDb>>;

function diadocLoaders(sql: Sql, since: Date, until: Date): NonNullable<SbisProbeDeps['diadoc']> {
  return {
    async loadCoverage(): Promise<DiadocCoverageRow[]> {
      const rows = await sql<
        {
          account_id: string;
          account_name: string;
          provider: string;
          cursor_since: Date | null;
          last_full_pass_at: Date | null;
          failed_in_interval: number;
          failed_undated: number;
        }[]
      >`
        select a.id::text as account_id, a.name as account_name, a.provider, c.since as cursor_since,
               (select max(r.feed_completed_at) from edo_export_runs r
                 where r.edo_account_id = a.id and r.scope = 'all') as last_full_pass_at,
               (select count(*)::int from edo_export_documents d
                 where d.edo_account_id = a.id and d.status = 'failed'
                   and d.received_at >= ${since} and d.received_at <= ${until}) as failed_in_interval,
               (select count(*)::int from edo_export_documents d
                 where d.edo_account_id = a.id and d.status = 'failed' and d.received_at is null) as failed_undated
          from edo_accounts a
          left join edo_export_cursors c on c.edo_account_id = a.id
         where a.is_active and a.box_id is not null and a.provider = 'diadoc'
         order by a.name`;
      return rows.map((r) => ({
        accountId: r.account_id,
        accountName: r.account_name,
        provider: r.provider,
        cursorSince: r.cursor_since,
        lastFullPassAt: r.last_full_pass_at,
        failedInInterval: r.failed_in_interval,
        failedUndated: r.failed_undated,
      }));
    },
    async loadRegistry(inns: string[]): Promise<DiadocRegistryRow[]> {
      // Не sql.array: при prepare:false первый запрос на свежем соединении уходит, пока
      // типы массивов ещё не загружены, и массив сериализуется строкой «a,b,c» (проверено
      // 22.10 на бою). ИНН — только цифры, поэтому склейка через запятую безопасна.
      const list = inns.filter((inn) => /^\d+$/.test(inn)).join(',');
      return sql<DiadocRegistryRow[]>`
        select e.status, e.document_number, to_char(e.document_date, 'YYYY-MM-DD') as document_date,
               e.supplier_inn, e.seller_inns
          from edo_export_documents e
          join edo_accounts a on a.id = e.edo_account_id
         where a.provider = 'diadoc' and e.status <> 'failed'
           and (e.supplier_inn = any(string_to_array(${list}, ',')) or e.seller_inns && string_to_array(${list}, ','))`;
    },
  };
}

async function main(): Promise<number> {
  if (!args.since) throw new Error('укажите --since ГГГГ-ММ-ДД');
  if (!args.out) throw new Error('укажите --out <файл.json>');
  const startedAt = new Date();
  const since = dayArg('since', args.since, false);
  // Конец интервала фиксируется при запуске: «просмотрен до …» должно значить одно и то же
  // для всех организаций, сколько бы ни шла проба.
  const until = args.until ? new Date(Math.min(dayArg('until', args.until, true).getTime(), startedAt.getTime())) : startedAt;
  if (since.getTime() >= until.getTime()) throw new Error('--since должен быть раньше --until');
  if (args.org) parseOrgArg(args.org);
  const maxDocs = intArg('max-docs', args['max-docs'], 1, 1_000_000);
  const sample = intArg('sample', args.sample, 0, 50);
  const emptyWaitSec = intArg('empty-wait-sec', args['empty-wait-sec'], 60, 300);
  const outDir = args['out-dir'];

  console.info(SECRET_VARS.map(fingerprint).join('\n'));
  const report: SbisProbeReport = {
    startedAt: startedAt.toISOString(),
    interval: { since: since.toISOString(), until: until.toISOString() },
    requests: {},
    steps: {},
    errors: [],
    summary: [],
  };

  const login = chooseLogin();
  if ('missing' in login) {
    // До сети не доходим: без всех ключей вход заведомо не пройдёт, а лишние
    // попытки приближают блокировку по лимиту входов.
    report.errors.push({ step: 'login', error: `не заданы: ${login.missing.join(', ')}` });
    report.summary.push(`Вход не пробовался: не заданы ${login.missing.join(', ')}`);
    await writeFile(args.out, JSON.stringify(report, null, 2), 'utf-8');
    console.error(report.summary.join('\n'));
    console.info(`Отчёт: ${args.out}`);
    return 1;
  }

  const sql = openReadOnlyDb();
  if (!sql) console.info('БД не задана — сверка с реестром Диадока будет пропущена.');
  if (outDir) await mkdir(outDir, { recursive: true });

  try {
    await runSbisProbe(
      {
        login: login.login,
        createClient: (session, onRequest) => createSbisClient({ session, onRequest }),
        diadoc: sql ? diadocLoaders(sql, since, until) : undefined,
        saveSample: outDir
          ? async (name, bytes) => {
              const path = join(outDir, name);
              await writeFile(path, bytes);
              return path;
            }
          : undefined,
      },
      { since, until, org: args.org ?? null, maxDocs, sample, emptyWaitMs: emptyWaitSec * 1000 },
      report,
    );
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(args.out, JSON.stringify(report, null, 2), 'utf-8');
    console.info(`Отчёт: ${args.out}`);
    await sql?.end({ timeout: 5 });
  }

  console.info(
    [
      `Запросов к СБИС: ${Object.entries(report.requests).map(([k, v]) => `${k} ${v}`).join(', ') || '0'}`,
      ...report.summary,
      report.errors.length ? `Шагов с ошибкой: ${report.errors.length}` : 'Все шаги прошли.',
    ].join('\n'),
  );
  return report.errors.length ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
