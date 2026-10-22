/**
 * Отчёт по проверке ИНН поставщика (SUPPLIER_INN_CHECK). Только чтение.
 *
 * Два режима:
 *   по умолчанию — следы supplier_inn_check за N дней: сколько документов
 *     получило каждое решение и откуда исправлено, с примерами. Им смотрят
 *     неделю shadow перед переводом в on.
 *   --backtest — то же решение, посчитанное на истории: по supplier_inn_raw
 *     документов и текущему справочнику. Имя поставщика в истории не хранится,
 *     поэтому берётся имя привязанной записи справочника — это приближение
 *     (после склейки дублей оно уже исправлено).
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/supplier-inn-check-report.ts --days 7
 *   pnpm --filter @matcheck/api exec tsx scripts/supplier-inn-check-report.ts --backtest --days 90
 * На бою — в контейнере, как edo-export-upd.ts; с adm1 — под read-only ролью.
 */
import { sql as drSql } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { normalizeInn } from '../src/domain/sourceDocuments/resolve-contractor.js';
import {
  loadDirectoryInns,
  loadOwnInns,
  resolveSupplierInn,
  type EdoRegistryEntry,
  type SupplierInnCheck,
} from '../src/domain/sourceDocuments/supplier-inn-check.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const days = Number(argValue('--days') ?? '7');
const backtest = process.argv.includes('--backtest');
const samplesPerKey = Number(argValue('--samples') ?? '5');

type Sample = { name: string | null; raw: string | null; inn: string | null; extra?: string };

function keyOf(
  c: Pick<SupplierInnCheck, 'decision' | 'source' | 'reason' | 'linkInn' | 'candidates'>,
): string {
  if (c.decision === 'corrected') return `corrected/${c.source}`;
  if (c.decision === 'unverified') {
    const how = c.linkInn ? 'по имени' : c.candidates ? 'неоднозначно' : 'без опоры';
    return `unverified/${c.reason ?? '?'}/${how}`;
  }
  return c.decision;
}

function print(counts: Map<string, number>, samples: Map<string, Sample[]>, total: number) {
  console.info(`Документов: ${total}`);
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.info(
      `  ${key.padEnd(36)} ${String(n).padStart(6)}  ${((100 * n) / Math.max(total, 1)).toFixed(1)}%`,
    );
    for (const s of samples.get(key) ?? []) {
      console.info(
        `      ${s.raw ?? '—'} → ${s.inn ?? '—'}  ${s.name ?? ''}${s.extra ? `  [${s.extra}]` : ''}`,
      );
    }
  }
}

function add(counts: Map<string, number>, samples: Map<string, Sample[]>, key: string, s: Sample) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  const list = samples.get(key) ?? [];
  if (list.length < samplesPerKey && !['valid', 'absent'].includes(key)) list.push(s);
  samples.set(key, list);
}

async function traces() {
  const rows = await db.execute(drSql`
    select d.supplier_inn_check as check, s.name as name
      from source_documents d
      left join suppliers s on s.id = d.supplier_directory_id
     where d.supplier_inn_check is not null
       and d.created_at >= now() - make_interval(days => ${days})`);
  const byMode = new Map<
    string,
    { counts: Map<string, number>; samples: Map<string, Sample[]>; total: number }
  >();
  for (const r of rows as unknown as Array<{
    check: SupplierInnCheck & { mode: string };
    name: string | null;
  }>) {
    const m = byMode.get(r.check.mode) ?? { counts: new Map(), samples: new Map(), total: 0 };
    m.total += 1;
    add(m.counts, m.samples, keyOf(r.check), {
      name: r.name,
      raw: r.check.raw,
      inn: r.check.inn ?? r.check.linkInn ?? null,
    });
    byMode.set(r.check.mode, m);
  }
  if (byMode.size === 0) console.info(`Следов за ${days} дн. нет: флаг SUPPLIER_INN_CHECK=off?`);
  for (const [mode, m] of byMode) {
    console.info(`\nРежим ${mode}:`);
    print(m.counts, m.samples, m.total);
  }
}

async function runBacktest() {
  const [directory, ownInns] = await Promise.all([loadDirectoryInns(db), loadOwnInns(db)]);
  const docs = (await db.execute(drSql`
    select d.supplier_inn_raw as raw, s.name as name, d.doc_number as number,
           to_char(d.doc_date, 'YYYY-MM-DD') as day, d.total_sum::float8 as total
      from source_documents d
      left join suppliers s on s.id = d.supplier_directory_id
     where d.is_technical = false
       and d.supplier_inn_raw is not null
       and d.created_at >= now() - make_interval(days => ${days})`)) as unknown as Array<{
    raw: string;
    name: string | null;
    number: string | null;
    day: string | null;
    total: number | null;
  }>;
  const edoRows = (await db.execute(drSql`
    select to_char(document_date, 'YYYY-MM-DD') as day, document_number as number,
           supplier_inn, seller_inns, supplier_name, total_sum::float8 as total
      from edo_export_documents
     where document_date >= now() - make_interval(days => ${days + 30})`)) as unknown as Array<{
    day: string;
    number: string | null;
    supplier_inn: string | null;
    seller_inns: string[] | null;
    supplier_name: string | null;
    total: number | null;
  }>;
  const edoByDay = new Map<string, EdoRegistryEntry[]>();
  for (const e of edoRows) {
    const list = edoByDay.get(e.day) ?? [];
    list.push({
      number: e.number,
      supplierInn: e.supplier_inn,
      sellerInns: e.seller_inns ?? [],
      supplierName: e.supplier_name,
      totalSum: e.total,
    });
    edoByDay.set(e.day, list);
  }

  const counts = new Map<string, number>();
  const samples = new Map<string, Sample[]>();
  for (const d of docs) {
    const check = resolveSupplierInn({
      raw: d.raw,
      name: d.name,
      docNumber: d.number,
      totalSum: d.total,
      directory: normalizeInn(d.raw) ? [] : directory,
      edo: d.day ? (edoByDay.get(d.day) ?? []) : [],
      ownInns,
    });
    add(counts, samples, keyOf(check), {
      name: d.name,
      raw: d.raw,
      inn: check.inn ?? check.linkInn ?? null,
      extra: check.candidates?.join(', '),
    });
  }
  console.info(`Бэктест за ${days} дн. (имя — по привязанной записи справочника):`);
  print(counts, samples, docs.length);
}

async function main(): Promise<number> {
  try {
    if (!Number.isInteger(days) || days <= 0)
      throw new Error(`--days ждёт целое > 0, получено ${days}`);
    if (backtest) await runBacktest();
    else await traces();
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

process.exitCode = await main();
