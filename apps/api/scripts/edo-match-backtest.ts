/**
 * Бэктест подбора УПД из ЭДО к приёмке: старый подбор (33d26a2) против нового
 * (domain/operations/edo-candidates.ts) на одних и тех же приёмках.
 *
 * Разметка независима от подбора. Правильная пара — УПД из реестра ЭДО, у
 * которой НДС до копейки и число позиций совпали с бумажной УПД приёмки (или с
 * фото УПД, если бумажной нет), и такая УПД в окне [приезд − 30; приезд + 1]
 * ровно одна. Ни НДС, ни число позиций не участвуют ни в поиске, ни в правилах
 * уровня. Оговорка: итог с НДС входит в очки порядка, а с НДС он коррелирует —
 * поэтому место в списке частично зависит от того же признака, что и разметка;
 * уровень «сильное» — нет.
 *
 * Что считает:
 *   - положительные: на 1-м месте, в первой тройке, ниже, не найдена вовсе — для
 *     нового и старого подбора; для не найденных — каким ключом её должно было
 *     найти (номер, ИНН, название) и что помешало;
 *   - ложные «сильные»: УПД со «сильным» совпадением, которая не размеченная пара
 *     (должно быть 0), с классом: то же ядро номера у другого поставщика, соседний
 *     номер той же серии, прочее;
 *   - приёмки с несколькими УПД: сверено ли с той бумажной УПД, чья это пара.
 *
 * Только чтение: соединение открывается в режиме read only, скрипт ничего не пишет
 * в базу. Отчёт — CSV в --out и сводка в stdout.
 *
 * Запуск на adm1 (URL и CA не печатаются, см. tools/mcp-pg/smoke.mjs):
 *   cd apps/api && NODE_EXTRA_CA_CERTS=/root/projects/matcheck/infra/secrets/yandex-ca/root.crt \
 *     /usr/bin/env -u MATCHECK_DB_RO_URL \
 *     node --env-file=/root/projects/matcheck/infra/secrets/mcp-db.env --import tsx \
 *     scripts/edo-match-backtest.ts --from 2026-09-01 --to 2026-10-01 --out /tmp/edo-backtest.csv
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';
import { findEdoCandidates, type EdoCandidate } from '../src/domain/operations/edo-candidates.js';
import { normalizeInn } from '../src/domain/sourceDocuments/resolve-contractor.js';
import { escapeLike } from '../src/lib/like.js';
import {
  documentNumberCore,
  normalizeDocumentNumber,
  normalizeSupplierName,
} from '../src/domain/operations/edo-match.js';

const { values: args } = parseArgs({
  options: {
    from: { type: 'string', default: '2026-09-01' },
    to: { type: 'string', default: '2026-10-01' },
    out: { type: 'string', default: 'edo-match-backtest.csv' },
    limit: { type: 'string' },
  },
});

const url = process.env.MATCHECK_DB_RO_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Нужен MATCHECK_DB_RO_URL или DATABASE_URL');
const sql = postgres(url, {
  max: 2,
  prepare: false,
  connect_timeout: 15,
  ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
  connection: { default_transaction_read_only: true, application_name: 'edo-match-backtest' },
  onnotice: () => {},
});
const db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;

type Label = {
  deliveryId: string;
  displayId: string;
  origin: 'paper' | 'photo';
  /** Номер бумажной УПД / фото, с которой сделана пара. */
  referenceNumber: string | null;
  paperCount: number;
  expectedId: string;
  expectedNumber: string | null;
  expectedDate: string | null;
  expectedInn: string | null;
  expectedName: string | null;
  refInns: string[];
  refNames: string[];
};

async function loadLabels(): Promise<Label[]> {
  const rows = await sql<
    {
      delivery_id: string;
      display_id: string;
      origin: 'paper' | 'photo';
      ref_number: string | null;
      paper_count: number;
      expected_id: string;
      expected_number: string | null;
      expected_date: string | null;
      expected_inn: string | null;
      expected_name: string | null;
      ref_inns: (string | null)[];
      ref_names: (string | null)[];
    }[]
  >`
    with d as (
      select id, display_id, arrived_at from deliveries
       where arrived_at >= ${args.from}::date and arrived_at < ${args.to}::date
         and pending_deletion_at is null
    ),
    paper as (
      select d.id as delivery_id, d.display_id, d.arrived_at, sd.doc_number, sd.vat_sum,
             (select count(*) from source_document_items i where i.source_document_id = sd.id)::int as n_items,
             array[sd.supplier_inn_raw, sup.inn, cp.inn] as inns, array[sup.name, cp.name] as names
        from d join delivery_sources ds on ds.delivery_id = d.id
        join source_documents sd on sd.id = ds.source_document_id
        left join suppliers sup on sup.id = sd.supplier_directory_id
        left join counterparties cp on cp.id = sd.supplier_id
       where sd.kind = 'upd' and sd.origin <> 'edo_diadoc' and sd.vat_sum > 0
    ),
    photo as (
      select d.id as delivery_id, d.display_id, d.arrived_at, pri.doc_number, pri.vat_sum,
             jsonb_array_length(pri.items) as n_items,
             array[]::text[] as inns, array[]::text[] as names
        from d join delivery_photos p on p.delivery_id = d.id
        join photo_recognized_items pri on pri.delivery_photo_id = p.id
       where pri.parser = 'upd_vision' and pri.vat_sum > 0
         and not exists (select 1 from delivery_sources ds join source_documents sd on sd.id = ds.source_document_id
                          where ds.delivery_id = d.id and sd.kind = 'upd' and sd.origin <> 'edo_diadoc')
    ),
    refs as (select 'paper' as origin, * from paper union all select 'photo', * from photo),
    hits as (
      select r.*, e.id as expected_id, e.document_number, e.document_date, e.supplier_inn, e.supplier_name,
             count(*) over (partition by r.delivery_id, r.origin, r.doc_number, r.vat_sum) as n
        from refs r join edo_export_documents e
          on e.status = 'stored' and e.vat_sum = r.vat_sum and e.items_count = r.n_items
         and e.document_date >= (r.arrived_at - interval '30 days')::date
         and e.document_date < (r.arrived_at + interval '2 days')::date
    )
    select distinct on (h.delivery_id, h.expected_id)
           h.delivery_id, h.display_id::text, h.origin, h.doc_number as ref_number,
           (select count(*)::int from paper p2 where p2.delivery_id = h.delivery_id) as paper_count,
           h.expected_id, h.document_number as expected_number, h.document_date::date::text as expected_date,
           h.supplier_inn as expected_inn, h.supplier_name as expected_name,
           h.inns as ref_inns, h.names as ref_names
      from hits h where h.n = 1
     order by h.delivery_id, h.expected_id
  `;
  const labels = rows.map((r) => ({
    deliveryId: r.delivery_id,
    displayId: r.display_id,
    origin: r.origin,
    referenceNumber: r.ref_number,
    paperCount: r.paper_count,
    expectedId: r.expected_id,
    expectedNumber: r.expected_number,
    expectedDate: r.expected_date,
    expectedInn: r.expected_inn,
    expectedName: r.expected_name,
    refInns: r.ref_inns.filter((v): v is string => !!v),
    refNames: r.ref_names.filter((v): v is string => !!v),
  }));
  return args.limit ? labels.slice(0, Number(args.limit)) : labels;
}

// ── Старый подбор (33d26a2 + 522246b), только реестр: импортированных УПД на бою нет ──

function legacyNumber(value: string | null): string {
  return normalizeDocumentNumber(value);
}

function legacyRank(
  ref: { numbers: string[]; dates: string[]; inn: string | null; name: string | null; sums: string[]; arrived: string | null },
  doc: { number: string | null; date: string | null; inn: string | null; name: string | null; sum: string | null },
): number {
  let score = 0;
  const refNumbers = ref.numbers.map(legacyNumber).filter(Boolean);
  const number = legacyNumber(doc.number);
  if (refNumbers.length && number && refNumbers.includes(number)) score += 55;
  if (ref.dates.length && doc.date) {
    if (ref.dates.includes(doc.date)) score += 20;
  } else if (ref.arrived && doc.date) {
    const days = Math.abs(Date.parse(ref.arrived) - Date.parse(doc.date)) / 86_400_000;
    if (days <= 7) score += 5;
  }
  const refInn = (ref.inn ?? '').replace(/\D/g, '');
  const docInn = (doc.inn ?? '').replace(/\D/g, '');
  const plainName = (v: string | null) => (v ?? '').toLocaleLowerCase('ru').replace(/[^a-zа-яё0-9]/gi, '');
  if (refInn && docInn) {
    if (refInn === docInn) score += 30;
  } else if (plainName(ref.name) && plainName(ref.name) === plainName(doc.name)) {
    score += 12;
  }
  const money = (a: string, b: string) => Math.abs(Number(a) - Number(b)) < 0.01;
  if (ref.sums.length && doc.sum && ref.sums.some((s) => money(s, doc.sum!))) score += 20;
  return score;
}

async function legacyCandidates(deliveryId: string): Promise<{ id: string; score: number }[]> {
  const [delivery] = await sql<{ arrived: string | null; created: string; inn: string | null; name: string | null }[]>`
    select to_char(d.arrived_at at time zone 'UTC', 'YYYY-MM-DD') as arrived,
           to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD') as created, c.inn, c.name
      from deliveries d left join counterparties c on c.id = d.supplier_id where d.id = ${deliveryId}`;
  const papers = await sql<{ number: string | null; date: string | null; sum: string | null; inn: string | null; name: string | null }[]>`
    select sd.doc_number as number, sd.doc_date::date::text as date, sd.total_sum::text as sum,
           coalesce(nullif(sd.supplier_inn_raw, ''), nullif(sup.inn, ''), nullif(cp.inn, '')) as inn,
           coalesce(sup.name, cp.name) as name
      from delivery_sources ds join source_documents sd on sd.id = ds.source_document_id
      left join suppliers sup on sup.id = sd.supplier_directory_id
      left join counterparties cp on cp.id = sd.supplier_id
     where ds.delivery_id = ${deliveryId} and sd.kind = 'upd' and sd.origin <> 'edo_diadoc'`;
  const refs = papers.length
    ? papers.map((p) => ({
        numbers: p.number ? [p.number] : [],
        dates: p.date ? [p.date] : [],
        inn: p.inn ?? delivery!.inn,
        name: p.name ?? delivery!.name,
        sums: p.sum ? [p.sum] : [],
        arrived: delivery!.arrived,
      }))
    : [{ numbers: [], dates: [], inn: delivery!.inn, name: delivery!.name, sums: [], arrived: delivery!.arrived }];
  const anchor = refs.flatMap((r) => r.dates)[0] ?? delivery!.arrived ?? delivery!.created;
  const numbers = refs.flatMap((r) => r.numbers);
  const anchorTime = Date.parse(`${anchor}T00:00:00Z`);
  const lower = new Date(anchorTime - 30 * 86_400_000).toISOString().slice(0, 10);
  const upper = new Date(anchorTime + 31 * 86_400_000).toISOString().slice(0, 10);
  // Как у Codex: подстрока номера или номер целиком после нормализации.
  const NORMALIZED = sql`regexp_replace(translate(upper(coalesce(document_number, '')), 'АВЕКМНОРСТУХ', 'ABEKMHOPCTYX'), '[^A-Z0-9А-ЯЁ]', '', 'g')`;
  const numberHit = numbers
    .map((n) => sql`(document_number ilike ${`%${escapeLike(n)}%`} or ${NORMALIZED} = ${legacyNumber(n)})`)
    .reduce((acc, part) => sql`${acc} or ${part}`, sql`false`);
  const rows = await sql<{ id: string; number: string | null; date: string | null; inn: string | null; name: string | null; sum: string | null }[]>`
    select id, document_number as number, document_date::date::text as date, supplier_inn as inn,
           supplier_name as name, total_sum::text as sum, created_at
      from edo_export_documents
     where status = 'stored' and s3_key is not null
       and (content_category in ('materials', 'undetermined') or content_category is null)
       and ((document_date >= ${lower}::date and document_date < ${upper}::date) or ${numberHit})
     order by case when ${numberHit} then 0 else 1 end, document_date desc nulls last, created_at desc
     limit 500`;
  return rows
    .map((row) => ({
      id: row.id,
      date: row.date,
      score: Math.max(
        ...refs.map((ref) =>
          legacyRank(ref, { number: row.number, date: row.date, inn: row.inn, name: row.name, sum: row.sum }),
        ),
      ),
    }))
    .sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? ''));
}

// ── Отчёт ──

type Place = 'first' | 'top3' | 'lower' | 'missing';

function placeOf(index: number): Place {
  if (index < 0) return 'missing';
  if (index === 0) return 'first';
  if (index < 3) return 'top3';
  return 'lower';
}

function falseStrongClass(candidate: EdoCandidate, label: Label): string {
  const sameCore =
    documentNumberCore(candidate.docNumber) !== '' &&
    documentNumberCore(candidate.docNumber) === documentNumberCore(label.expectedNumber);
  const sameInn = normalizeInn(candidate.supplierInn) === normalizeInn(label.expectedInn);
  if (sameCore && !sameInn) return 'то же ядро номера, другой поставщик';
  if (sameInn) return 'тот же поставщик, другой документ';
  return 'прочее';
}

/** Для не найденной пары: каким ключом её должно было найти и что помешало. */
function missReason(label: Label): string {
  const refNumber = label.referenceNumber;
  const reasons: string[] = [];
  if (refNumber && label.expectedNumber) {
    if (normalizeDocumentNumber(refNumber) === normalizeDocumentNumber(label.expectedNumber)) reasons.push('номер совпадает целиком');
    else if (documentNumberCore(refNumber) && documentNumberCore(refNumber) === documentNumberCore(label.expectedNumber))
      reasons.push('номер совпадает по цифрам');
    else reasons.push(`номер другой (${refNumber} / ${label.expectedNumber})`);
  } else reasons.push('нет номера');
  const valid = label.refInns.map((v) => normalizeInn(v)).filter(Boolean);
  if (!valid.length) reasons.push(label.refInns.length ? 'ИНН приёмки битый' : 'ИНН приёмки нет');
  else if (valid.includes(normalizeInn(label.expectedInn))) reasons.push('ИНН совпадает');
  else reasons.push('ИНН другой');
  const names = label.refNames.map(normalizeSupplierName).filter(Boolean);
  if (names.length) reasons.push(names.includes(normalizeSupplierName(label.expectedName)) ? 'название совпадает' : 'название другое');
  return reasons.join('; ');
}

function csv(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main(): Promise<void> {
  const labels = await loadLabels();
  console.log(`Размечено пар: ${labels.length} (${args.from} … ${args.to})`);
  const lines: string[] = [
    [
      'приёмка', 'эталон', 'номер эталона', 'УПД в паре', 'дата', 'ИНН', 'новый: место', 'новый: уровень',
      'новый: найдена запросом', 'старый: место', '1-я новая: номер', '1-я новая: уровень', 'ложное сильное',
      'сверено с', 'почему не найдена',
    ].join(','),
  ];
  const tally = {
    new: { first: 0, top3: 0, lower: 0, missing: 0 } as Record<Place, number>,
    old: { first: 0, top3: 0, lower: 0, missing: 0 } as Record<Place, number>,
    expectedHigh: 0,
    falseStrong: new Map<string, number>(),
    multi: { total: 0, wrongReference: 0 },
  };

  // Подбор — один раз на приёмку: у приёмки с несколькими УПД каждая
  // бумажная УПД даёт свою пару, и «сильное» у соседней УПД той же приёмки —
  // не ошибка, а её собственная пара.
  const byDelivery = new Map<string, Label[]>();
  for (const label of labels) {
    byDelivery.set(label.deliveryId, [...(byDelivery.get(label.deliveryId) ?? []), label]);
  }
  let unverifiedStrong = 0;
  let done = 0;
  for (const [deliveryId, group] of byDelivery) {
    const fresh = await findEdoCandidates(db, deliveryId);
    const allItems = fresh?.items ?? [];
    const legacy = await legacyCandidates(deliveryId);
    const pairedIds = new Set(group.map((label) => label.expectedId));
    const labelByReference = new Map(group.map((label) => [label.referenceNumber ?? '', label]));

    // «Сильное» без размеченной пары у своего эталона — не ошибка и не
    // подтверждение: такие строки идут в отчёт на ручную проверку.
    for (const c of allItems) {
      if (c.level !== 'high' || pairedIds.has(c.id)) continue;
      if (!labelByReference.has(c.reference.label ?? '')) unverifiedStrong += 1;
    }

    for (const label of group) {
      // Место — среди кандидатов без соседних пар этой же приёмки.
      const others = new Set([...pairedIds].filter((id) => id !== label.expectedId));
      const items = allItems.filter((c) => !others.has(c.id));
      const index = items.findIndex((c) => c.source === 'export' && c.id === label.expectedId);
      const place = placeOf(index);
      tally.new[place] += 1;
      const expected = index >= 0 ? items[index]! : null;
      if (expected?.level === 'high') tally.expectedHigh += 1;

      // Ложное «сильное» — другая УПД, сверенная с ТЕМ ЖЕ эталоном, что и пара.
      const falseStrong = items.filter(
        (c) =>
          c.level === 'high' &&
          c.id !== label.expectedId &&
          (c.reference.label ?? '') === (label.referenceNumber ?? ''),
      );
      for (const c of falseStrong) {
        const cls = falseStrongClass(c, label);
        tally.falseStrong.set(cls, (tally.falseStrong.get(cls) ?? 0) + 1);
      }
      if (label.paperCount > 1 && expected) {
        tally.multi.total += 1;
        if (expected.reference.label !== label.referenceNumber) tally.multi.wrongReference += 1;
      }

      const oldItems = legacy.filter((c) => !others.has(c.id));
      const oldPlace = placeOf(oldItems.findIndex((c) => c.id === label.expectedId));
      tally.old[oldPlace] += 1;

      const top = items[0];
      lines.push(
        [
          label.displayId,
          label.origin === 'paper' ? 'бумажная УПД' : 'фото',
          label.referenceNumber,
          label.expectedNumber,
          label.expectedDate,
          label.expectedInn,
          index >= 0 ? index + 1 : 'нет',
          expected?.level ?? '',
          expected?.foundBy.join('+') ?? '',
          oldPlace,
          top?.docNumber ?? '',
          top?.level ?? '',
          falseStrong.map((c) => `${c.docNumber} (${falseStrongClass(c, label)})`).join(' | '),
          expected ? `${expected.reference.origin} ${expected.reference.label ?? ''}` : '',
          place === 'missing' ? missReason(label) : '',
        ]
          .map(csv)
          .join(','),
      );
    }
    done += 1;
    if (done % 50 === 0) console.log(`  … ${done}/${byDelivery.size} приёмок`);
  }

  writeFileSync(args.out!, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  const share = (n: number) => `${n} (${labels.length ? Math.round((n / labels.length) * 1000) / 10 : 0}%)`;
  console.log('\nПоложительные пары — место правильной УПД:');
  console.log('              новый           старый');
  for (const place of ['first', 'top3', 'lower', 'missing'] as const) {
    const title = { first: '1-е место', top3: '2–3 место', lower: 'ниже', missing: 'не найдена' }[place];
    console.log(`  ${title.padEnd(11)} ${share(tally.new[place]).padEnd(15)} ${share(tally.old[place])}`);
  }
  console.log(`\n«Сильное» у правильной УПД: ${share(tally.expectedHigh)}`);
  const falseTotal = [...tally.falseStrong.values()].reduce((a, b) => a + b, 0);
  console.log(`Ложных «сильных» (не та УПД): ${falseTotal}`);
  for (const [cls, n] of tally.falseStrong) console.log(`  ${cls}: ${n}`);
  console.log(
    `Приёмки с несколькими УПД: ${tally.multi.total}, сверено не с той бумажной УПД: ${tally.multi.wrongReference}`,
  );
  console.log(`«Сильных» у эталонов без размеченной пары (проверить вручную): ${unverifiedStrong}`);
  console.log(`\nОтчёт: ${args.out}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
