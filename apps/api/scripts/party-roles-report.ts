/**
 * Отчёт по правилу «покупатель совпал с поставщиком» (PARTY_ROLES_CHECK).
 * Только чтение.
 *
 * Три режима:
 *   по умолчанию — следы party_roles за N дней: ТОЧНЫЙ список решений на тех
 *     данных, что видел воркер (стороны — как их прочла модель). Перед
 *     переводом в on просматриваются ВСЕ drop_buyer отсюда.
 *   --backtest — ОЦЕНКА масштаба на истории. Прочитанное моделью имя
 *     поставщика после привязки по ИНН не хранится: берём его из llm_calls,
 *     если вызов связан с документом (точно), иначе — имя записи справочника
 *     (приближённо). История ролей — нынешняя, а не на момент разбора.
 *   --directory — подозрительные записи справочника поставщиков, заведённые
 *     распознаванием: (А) ИНН своей организации или подрядчика, (Б) имя как у
 *     записи BillHub, а ИНН другой или пустой. Решение по каждой — за человеком.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/party-roles-report.ts --days 7
 *   pnpm --filter @matcheck/api exec tsx scripts/party-roles-report.ts --backtest --days 90
 *   pnpm --filter @matcheck/api exec tsx scripts/party-roles-report.ts --directory
 * На бою — в контейнере, как supplier-inn-check-report.ts; с adm1 — под read-only ролью.
 */
import { sql as drSql } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { companyKey, formsCompatible } from '../src/domain/directories/names.js';
import { normalizeInn } from '../src/domain/sourceDocuments/resolve-contractor.js';
import { loadOwnInns } from '../src/domain/sourceDocuments/supplier-inn-check.js';
import {
  decideSameParty,
  loadPartyRoleStats,
  sameParty,
  type PartyRoleStats,
  type SamePartyDecision,
} from '../src/domain/sourceDocuments/party-roles.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const days = Number(argValue('--days') ?? '7');
const mode = process.argv.includes('--backtest')
  ? 'backtest'
  : process.argv.includes('--directory')
    ? 'directory'
    : 'traces';

type Party = { name: string | null; inn: string | null };

function decisionKey(d: SamePartyDecision): string {
  return d.kind === 'drop_buyer' ? 'drop_buyer' : `flag/${d.reason}`;
}

function party(p: Party): string {
  return `${p.name ?? '—'}${p.inn ? ` (ИНН ${p.inn})` : ''}`;
}

function statsLine(s: PartyRoleStats | undefined): string {
  if (!s) return '';
  return `ИНН ${s.inn ?? '—'} (${s.innSource ?? '—'}), поставщик ${s.asSupplier} : покупатель/грузополучатель ${s.asBuyerOrConsignee}${s.isOwn ? ', своя' : ''}${s.isContractor ? ', подрядчик' : ''}`;
}

async function traces() {
  const rows = (await db.execute(drSql`
    select e.payload, e.created_at::text as at, d.doc_number as number,
           (select string_agg(dl.display_id::text, ', ')
              from delivery_sources ds join deliveries dl on dl.id = ds.delivery_id
             where ds.source_document_id = e.source_document_id) as deliveries
      from recognition_evidence_events e
      left join source_documents d on d.id = e.source_document_id
     where e.evidence_type = 'party_roles'
       and e.created_at >= now() - make_interval(days => ${days})
     order by e.created_at`)) as unknown as Array<{
    payload: {
      mode: string;
      decision: SamePartyDecision;
      supplier: Party;
      buyer: Party;
      stats?: PartyRoleStats;
    };
    at: string;
    number: string | null;
    deliveries: string | null;
  }>;
  if (rows.length === 0) {
    console.info(`Следов за ${days} дн. нет: флаг PARTY_ROLES_CHECK=off?`);
    return;
  }
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.payload.mode}/${decisionKey(r.payload.decision)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  console.info(`Следов за ${days} дн.: ${rows.length}`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.info(`  ${k.padEnd(32)} ${String(n).padStart(6)}`);
  }
  // Все решения, не выборка: сбросы проверяются по сканам каждый.
  for (const kind of ['drop_buyer', 'flag'] as const) {
    console.info(`\n${kind === 'drop_buyer' ? 'Сброс покупателя' : 'Пометка'}:`);
    for (const r of rows.filter((x) => x.payload.decision.kind === kind)) {
      console.info(
        `  ${r.at.slice(0, 16)}  приёмка ${r.deliveries ?? '—'}  № ${r.number ?? '—'}  [${decisionKey(r.payload.decision)}]`,
      );
      console.info(
        `      поставщик ${party(r.payload.supplier)} / покупатель ${party(r.payload.buyer)}`,
      );
      console.info(`      ${statsLine(r.payload.stats)}`);
    }
  }
}

/** Поставщик из ответа модели, если вызов связан с документом. */
function supplierFromResponse(raw: string | null): Party | null {
  if (!raw) return null;
  try {
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(text) as { supplier?: { name?: unknown; inn?: unknown } };
    const s = parsed.supplier;
    if (!s || typeof s.name !== 'string') return null;
    return { name: s.name, inn: typeof s.inn === 'string' ? s.inn : null };
  } catch {
    return null;
  }
}

async function runBacktest() {
  const docs = (await db.execute(drSql`
    select d.id, d.doc_number as number, d.buyer_name_raw as buyer_name, d.buyer_inn_raw as buyer_inn,
           d.supplier_inn_raw as supplier_inn, s.name as directory_name, s.inn as directory_inn,
           (select l.response_raw from llm_calls l
             where l.source_document_id = d.id and l.doc_kind = 'upd' and l.response_raw is not null
             order by l.created_at desc limit 1) as response
      from source_documents d
      left join suppliers s on s.id = d.supplier_directory_id
     where not coalesce(d.is_technical, false)
       and d.buyer_name_raw is not null
       and d.created_at >= now() - make_interval(days => ${days})`)) as unknown as Array<{
    id: string;
    number: string | null;
    buyer_name: string;
    buyer_inn: string | null;
    supplier_inn: string | null;
    directory_name: string | null;
    directory_inn: string | null;
    response: string | null;
  }>;

  const counts = new Map<string, number>();
  const drops: string[] = [];
  let hits = 0;
  for (const d of docs) {
    const fromModel = supplierFromResponse(d.response);
    const supplier: Party = fromModel ?? {
      name: d.directory_name,
      inn: d.supplier_inn ?? d.directory_inn,
    };
    const source = fromModel ? 'точно' : 'приближённо';
    const buyer: Party = { name: d.buyer_name, inn: d.buyer_inn };
    if (!sameParty(supplier, buyer)) continue;
    hits += 1;
    const stats = await loadPartyRoleStats(db, supplier, buyer, d.id);
    const decision = decideSameParty(stats);
    const key = `${decisionKey(decision)} (${source})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (decision.kind === 'drop_buyer') {
      drops.push(
        `  № ${d.number ?? '—'} [${source}]  поставщик ${party(supplier)} / покупатель ${party(buyer)}\n      ${statsLine(stats)}`,
      );
    }
  }
  console.info(
    `Бэктест за ${days} дн. — ОЦЕНКА (имя поставщика из llm_calls где есть, иначе из справочника; история ролей — нынешняя).`,
  );
  console.info(`Документов с покупателем: ${docs.length}, покупатель = поставщик: ${hits}`);
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.info(`  ${k.padEnd(40)} ${String(n).padStart(6)}`);
  }
  console.info(`\nСбросы покупателя (${drops.length}):`);
  for (const line of drops) console.info(line);
}

async function directory() {
  const ownInns = await loadOwnInns(db);
  const contractors = (await db.execute(drSql`
    select name, inn from customer_counterparties`)) as unknown as Array<{
    name: string;
    inn: string | null;
  }>;
  const contractorInns = new Set(
    contractors.map((c) => normalizeInn(c.inn)).filter((v): v is string => v !== null),
  );
  const rows = (await db.execute(drSql`
    select s.id, s.name, s.inn, s.billhub_id is not null as billhub,
           (select count(*)::int from source_documents d where d.supplier_directory_id = s.id) as docs
      from suppliers s`)) as unknown as Array<{
    id: string;
    name: string;
    inn: string | null;
    billhub: boolean;
    docs: number;
  }>;
  const billhub = rows.filter((r) => r.billhub);
  const auto = rows.filter((r) => !r.billhub && r.docs > 0);

  console.info('(А) Автозаписи с ИНН своей организации или подрядчика из «Контрагентов»:');
  for (const r of auto) {
    const inn = normalizeInn(r.inn);
    if (!inn || (!ownInns.has(inn) && !contractorInns.has(inn))) continue;
    console.info(
      `  ${r.name}  ИНН ${r.inn}  док. ${r.docs}  [${ownInns.has(inn) ? 'своя' : 'подрядчик'}]  ${r.id}`,
    );
  }

  console.info('\n(Б) Автозаписи с именем как у записи BillHub, но с другим или пустым ИНН:');
  for (const r of auto) {
    const key = companyKey(r.name);
    if (!key) continue;
    const twins = billhub.filter(
      (b) => companyKey(b.name) === key && formsCompatible(r.name, b.name) && b.inn !== r.inn,
    );
    if (twins.length === 0) continue;
    console.info(
      `  ${r.name}  ИНН ${r.inn || '—'}  док. ${r.docs}  ${r.id}\n      BillHub: ${twins.map((b) => `${b.name} (ИНН ${b.inn})`).join('; ')}`,
    );
  }
}

async function main(): Promise<number> {
  try {
    if (!Number.isInteger(days) || days <= 0)
      throw new Error(`--days ждёт целое > 0, получено ${days}`);
    if (mode === 'backtest') await runBacktest();
    else if (mode === 'directory') await directory();
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
