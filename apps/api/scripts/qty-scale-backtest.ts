/**
 * Бэктест правила ×1000 (qty-scale) на уже сохранённых данных.
 *
 * Отвечает на вопрос «что правило сделало бы, будь оно включено», до перевода
 * QTY_SCALE_REPAIR из shadow в on. Источники:
 *  - документы (УПД-путь и накладные пакетного пути) — позиции из БД;
 *  - распознавания фото (обе ветки: upd_vision и photo_v1).
 *
 * Что это НЕ точная копия боевого прогона. Правило в воркере видит СЫРОЙ ответ
 * модели, а здесь — сохранённые строки: построчный НДС мог быть нормализован
 * по шапке, итог — синтезирован. Количество восстанавливается как прочитанное
 * (`qty_read ?? qty`), так что уже применённые правки бэктест видит заново.
 * Отклонения возможны в правиле A на строках с переписанным НДС (условие R4) —
 * в обе стороны. Для точного ответа по документу смотрите llm_calls.
 *
 * Инвариант, при нарушении которого скрипт падает с кодом 1: правило A не
 * выдаёт кандидата на строке, у которой проверка «количество × цена» сходится,
 * а правило B — на строке с ценой или суммой. Именно это гарантирует, что
 * сходящиеся строки (настоящие 1000 и 1 000 000 шт) правка не трогает.
 *
 * Запуск (только чтение):
 *   pnpm --filter @matcheck/api exec tsx scripts/qty-scale-backtest.ts --days 90
 *   … --list   — построчный список кандидатов
 */
import { sql as pg } from '../src/db/client.js';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';
import {
  detectQtyScale,
  type QtyScaleCandidate,
  type QtyScaleInput,
} from '../src/domain/edo/qty-scale.js';

const argv = process.argv.slice(2);
const daysAt = argv.indexOf('--days');
const days = daysAt >= 0 ? Number(argv[daysAt + 1]) : 90;
const list = argv.includes('--list');
if (!Number.isInteger(days) || days <= 0) {
  console.error('--days: целое число дней больше нуля');
  process.exit(2);
}

/** Режимы разбора, в которых воркер правку применяет (QTY_REPAIR_PARSE_MODES). */
const APPLY_PARSE_MODES = new Set([
  'vision_pdf',
  'vision_bundle',
  'image_vision',
  'm15_vision',
  'segment_vision',
  // Накладные пакетного пути — при создании документа.
  'waybill_batch',
]);

type Row = {
  source: string;
  ref: string;
  label: string;
  wouldApply: boolean;
  inOperation: string | null;
  candidate: QtyScaleCandidate;
  nameRaw: string;
};

const n = (v: unknown): number | null => (v == null ? null : Number(v));

let violations = 0;

/** Проверка инварианта для одного входа и его кандидатов. */
function checkInvariant(input: QtyScaleInput, candidates: QtyScaleCandidate[], ref: string): void {
  const validation = validateUpdTotals({
    totalSum: input.totalSum ?? null,
    vatSum: input.vatSum ?? null,
    itemsCount: null,
    items: input.items.map((i) => ({
      rowNo: i.rowNo ?? null,
      qty: i.qty ?? null,
      unit: i.unit ?? null,
      price: i.price ?? null,
      sum: i.sum ?? null,
      vatRate: i.vatRate ?? null,
      vatSum: i.vatSum ?? null,
    })),
  });
  for (const c of candidates) {
    const item = input.items[c.row - 1];
    if (c.kind === 'unpriced_million') {
      if (item?.price != null || item?.sum != null) {
        violations += 1;
        console.error(`НАРУШЕНИЕ: ${ref}, строка ${c.row}: правило B на строке с ценой/суммой`);
      }
      continue;
    }
    const check = validation.checks.find(
      (x) => x.name === 'row_qty_price' && x.scope !== 'document' && x.scope.row === c.row,
    );
    if (!check || check.ok) {
      violations += 1;
      console.error(`НАРУШЕНИЕ: ${ref}, строка ${c.row}: правило A на сходящейся строке`);
    }
  }
}

async function documents(): Promise<Row[]> {
  const docs = await pg<
    Array<{
      id: string;
      doc_number: string | null;
      kind: string;
      parse_mode: string | null;
      total_sum: string | null;
      vat_sum: string | null;
      in_operation: string | null;
    }>
  >`
    SELECT sd.id, sd.doc_number, sd.kind, sd.parse_mode, sd.total_sum, sd.vat_sum,
           (SELECT 'приёмка #' || d.display_id || ' (' || st.code || ')'
              FROM delivery_sources ds
              JOIN deliveries d ON d.id = ds.delivery_id
              JOIN statuses st ON st.id = d.status_id
             WHERE ds.source_document_id = sd.id LIMIT 1) AS in_operation
      FROM source_documents sd
     WHERE sd.is_technical = false
       AND sd.created_at >= now() - make_interval(days => ${days})
       AND EXISTS (SELECT 1 FROM source_document_items i WHERE i.source_document_id = sd.id)`;

  const out: Row[] = [];
  const BATCH = 500;
  for (let at = 0; at < docs.length; at += BATCH) {
    const chunk = docs.slice(at, at + BATCH);
    const items = await pg<
      Array<{
        source_document_id: string;
        name_raw: string;
        qty: string;
        qty_read: string | null;
        unit: string | null;
        price: string | null;
        sum: string | null;
        vat_rate: string | null;
        vat_sum: string | null;
        row_no: number | null;
      }>
    >`
      SELECT source_document_id, name_raw, qty, qty_read, unit, price, sum, vat_rate, vat_sum, row_no
        FROM source_document_items
       WHERE source_document_id = ANY(${chunk.map((d) => d.id)})
       ORDER BY source_document_id, line_no`;
    const byDoc = new Map<string, Array<(typeof items)[number]>>();
    for (const it of items) {
      const bucket = byDoc.get(it.source_document_id);
      if (bucket) bucket.push(it);
      else byDoc.set(it.source_document_id, [it]);
    }
    for (const d of chunk) {
      const rows = byDoc.get(d.id) ?? [];
      const waybill = d.parse_mode === 'waybill_batch';
      // Вход — ровно тот, что даёт воркер: у накладной нет ни НДС, ни ставок.
      const input: QtyScaleInput = {
        totalSum: n(d.total_sum),
        vatSum: waybill ? null : n(d.vat_sum),
        items: rows.map((r) => ({
          rowNo: r.row_no,
          qty: n(r.qty_read) ?? n(r.qty),
          unit: r.unit,
          price: n(r.price),
          sum: n(r.sum),
          vatRate: waybill ? null : n(r.vat_rate),
          vatSum: waybill ? null : n(r.vat_sum),
        })),
      };
      const ref = `документ ${d.doc_number ?? '—'} [${d.id}]`;
      const candidates = detectQtyScale(input);
      checkInvariant(input, candidates, ref);
      for (const c of candidates) {
        out.push({
          source: `документ:${d.parse_mode ?? 'нет режима'}`,
          ref,
          label: d.kind,
          wouldApply: c.applicable && APPLY_PARSE_MODES.has(d.parse_mode ?? ''),
          inOperation: d.in_operation,
          candidate: c,
          nameRaw: rows[c.row - 1]?.name_raw ?? '',
        });
      }
    }
  }
  return out;
}

async function photos(): Promise<Row[]> {
  const rows = await pg<
    Array<{
      id: string;
      doc_number: string | null;
      parser: string | null;
      total_sum: string | null;
      vat_sum: string | null;
      items: Array<Record<string, unknown>> | null;
      qty_scale: { entries?: Array<{ row: number; qtyFrom: number; state: string }> } | null;
    }>
  >`
    SELECT id, doc_number, parser, total_sum, vat_sum, items, qty_scale
      FROM photo_recognized_items
     WHERE updated_at >= now() - make_interval(days => ${days})
       AND error_message IS NULL`;

  const out: Row[] = [];
  for (const r of rows) {
    const items = r.items ?? [];
    // Применённая правка уже в items — возвращаем прочитанное из следа.
    const readByRow = new Map(
      (r.qty_scale?.entries ?? [])
        .filter((e) => e.state === 'applied')
        .map((e) => [e.row, e.qtyFrom]),
    );
    const input: QtyScaleInput = {
      totalSum: n(r.total_sum),
      vatSum: n(r.vat_sum),
      items: items.map((i, idx) => ({
        rowNo: (i.rowNo as number | null | undefined) ?? null,
        qty: readByRow.get(idx + 1) ?? n(i.qty),
        unit: (i.unit as string | null | undefined) ?? null,
        price: n(i.price),
        sum: n(i.sum),
        vatRate: n(i.vatRate),
        vatSum: n(i.vatSum),
      })),
    };
    const ref = `фото ${r.doc_number ?? '—'} [${r.id}]`;
    const candidates = detectQtyScale(input);
    checkInvariant(input, candidates, ref);
    for (const c of candidates) {
      out.push({
        source: `фото:${r.parser ?? 'нет парсера'}`,
        ref,
        label: 'фото',
        // Состояние приёмки на момент распознавания не хранится — показываем,
        // что правило выдало бы по числам.
        wouldApply: c.applicable,
        inOperation: null,
        candidate: c,
        nameRaw: String(items[c.row - 1]?.nameRaw ?? ''),
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`=== бэктест qty-scale за ${days} дн., только чтение ===`);
  const rows = [...(await documents()), ...(await photos())];

  // Сводка: источник × правило → применилось бы / только наблюдение (причина).
  const summary = new Map<string, { apply: number; docs: Set<string>; blocked: Map<string, number> }>();
  for (const r of rows) {
    const key = `${r.source} · ${r.candidate.kind}`;
    const s = summary.get(key) ?? { apply: 0, docs: new Set<string>(), blocked: new Map() };
    if (r.wouldApply) {
      s.apply += 1;
      s.docs.add(r.ref);
    } else {
      const reason = r.candidate.blockedBy ?? 'режим разбора без применения';
      s.blocked.set(reason, (s.blocked.get(reason) ?? 0) + 1);
    }
    summary.set(key, s);
  }
  console.log('\nисточник · правило | правка: строк (документов) | только наблюдение');
  for (const [key, s] of [...summary.entries()].sort()) {
    const blocked = [...s.blocked.entries()].map(([k, v]) => `${k}: ${v}`).join(', ') || '—';
    console.log(`${key} | ${s.apply} (${s.docs.size}) | ${blocked}`);
  }

  if (list) {
    console.log('\nисточник | ссылка | строка | наименование | было → станет | решение | операция');
    for (const r of rows) {
      const c = r.candidate;
      console.log(
        [
          r.source,
          r.ref,
          c.row,
          r.nameRaw.slice(0, 60),
          `${c.qtyFrom} → ${c.qtyTo}`,
          r.wouldApply ? 'правка' : `наблюдение (${c.blockedBy ?? 'режим'})`,
          r.inOperation ?? '—',
        ].join(' | '),
      );
    }
  }

  if (violations > 0) {
    console.error(`\nнарушений инварианта: ${violations}`);
    process.exit(1);
  }
  console.log('\nинвариант соблюдён: сходящиеся строки и строки с ценой правило не трогает');
  process.exit(0);
}

void main();
