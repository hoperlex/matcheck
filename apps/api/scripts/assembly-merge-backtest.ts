/**
 * Бэктест склейки экземпляров УПД по номеру позиции (UPD_ASSEMBLY_COPY_BY_ROW_NO):
 * прежнее правило против нового на всех склейках боевой базы.
 *
 * Вход каждой склейки восстанавливается из БД:
 *   - копии — архивные документы с `parse_error_details.mergedInto`: их строки
 *     склейка не трогает;
 *   - keeper — его строки до дописанных: первые K по `line_no`, где K — число
 *     позиций в последнем ответе модели по сегменту keeper (дописанные строки
 *     встают в конец, `lineNo = keeperItems.length + index + 1`).
 * Прежнее правило прогоняется заново и обязано дать фактическое число строк
 * keeper. Иначе вход восстановлен неверно (переразбор, ручная правка позиций),
 * и склейка уходит в «не воспроизводится», а не в выводы.
 *
 * Критерии включения рубильника — все должны выполниться:
 *   а) где прежнее правило не дало повторов номера, новое даёт тот же набор строк;
 *   б) после нового правила повторов номера нет, кроме тех, что уже были внутри
 *      самого keeper (их склейка не создавала);
 *   в) при заявленном итоге сумма строк не удаляется от него;
 *   г) строк не становится больше.
 *
 * Только чтение: соединение открывается в режиме read only. Отчёт — JSON в
 * --out и сводка в stdout.
 *
 * Запуск на adm1 (URL и CA не печатаются, см. tools/mcp-pg/smoke.mjs):
 *   cd apps/api && NODE_EXTRA_CA_CERTS=/root/projects/matcheck/infra/secrets/yandex-ca/root.crt \
 *     /usr/bin/env -u MATCHECK_DB_RO_URL \
 *     node --env-file=/root/projects/matcheck/infra/secrets/mcp-db.env --import tsx \
 *     scripts/assembly-merge-backtest.ts --since 2026-08-25T09:38:00+03:00 --out /tmp/assembly-merge-backtest.json
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import postgres from 'postgres';
import {
  compareCopyByRowNo,
  planAssemblyDocumentMerges,
  type AssemblyMergeAction,
  type AssemblyMergeDocument,
  type AssemblyMergeItem,
} from '../src/domain/edo/upd-assembly-merge.js';

const { values: args } = parseArgs({
  options: {
    since: { type: 'string', default: '2026-08-25T09:38:00+03:00' },
    out: { type: 'string', default: 'assembly-merge-backtest.json' },
  },
});

const url = process.env.MATCHECK_DB_RO_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Нужен MATCHECK_DB_RO_URL или DATABASE_URL');
const sql = postgres(url, {
  max: 2,
  prepare: false,
  connect_timeout: 15,
  ssl: /sslmode=(require|verify)/.test(url) ? { rejectUnauthorized: true } : undefined,
  connection: { default_transaction_read_only: true, application_name: 'assembly-merge-backtest' },
  onnotice: () => {},
});

type KeeperRow = {
  id: string;
  doc_number: string | null;
  supplier_directory_id: string | null;
  doc_date: Date | null;
  total_sum: string | null;
  created_at: Date;
  in_delivery: boolean;
};
type MemberRow = { keeper_id: string; id: string; segment_index: number | null };
type ItemRow = {
  id: string;
  source_document_id: string;
  line_no: number;
  name_raw: string;
  qty: string;
  sum: string | null;
  unit: string | null;
  price: string | null;
  row_no: number | null;
  vat_rate: string | null;
  vat_sum: string | null;
  qty_read: string | null;
};

const toItem = (row: ItemRow): AssemblyMergeItem => ({
  id: row.id,
  nameRaw: row.name_raw,
  qty: row.qty,
  sum: row.sum,
  unit: row.unit,
  price: row.price,
  rowNo: row.row_no,
  vatRate: row.vat_rate,
  vatSum: row.vat_sum,
  qtyRead: row.qty_read,
});

function sumOf(itemIds: string[], byId: Map<string, AssemblyMergeItem>): number | null {
  let total = 0;
  for (const id of itemIds) {
    const value = byId.get(id)?.sum;
    if (value == null) return null;
    total += Number(value);
  }
  return Math.round(total * 100) / 100;
}

async function main(): Promise<void> {
  const keepers = await sql<KeeperRow[]>`
    SELECT k.id, k.doc_number, k.supplier_directory_id, k.doc_date, k.total_sum, k.created_at,
           EXISTS (SELECT 1 FROM delivery_sources ds WHERE ds.source_document_id = k.id) AS in_delivery
      FROM source_documents k
     WHERE k.created_at >= ${args.since!}
       AND EXISTS (SELECT 1 FROM source_documents t
                    WHERE t.is_technical AND t.status = 'archived'
                      AND t.parse_error_details->>'mergedInto' = k.id::text)
     ORDER BY k.created_at`;
  const keeperIds = keepers.map((k) => k.id);

  const members = await sql<MemberRow[]>`
    SELECT t.parse_error_details->>'mergedInto' AS keeper_id, t.id,
           (SELECT min(s.segment_index) FROM bundle_segments s WHERE s.source_document_id = t.id) AS segment_index
      FROM source_documents t
     WHERE t.is_technical AND t.status = 'archived'
       AND t.parse_error_details->>'mergedInto' = ANY(${keeperIds.map(String)})`;
  const allIds = [...keeperIds, ...members.map((m) => m.id)];

  const items = await sql<ItemRow[]>`
    SELECT id, source_document_id, line_no, name_raw, qty::text, sum::text, unit, price::text,
           row_no, vat_rate::text, vat_sum::text, qty_read::text
      FROM source_document_items
     WHERE source_document_id = ANY(${allIds})
     ORDER BY source_document_id, line_no`;

  // Сколько строк было у keeper до склейки: позиции в последнем успешном
  // ответе модели по его сегменту.
  const lastAnswers = await sql<{ id: string; items: number }[]>`
    SELECT DISTINCT ON (l.source_document_id) l.source_document_id AS id,
           jsonb_array_length(coalesce(l.response_parsed->'items', '[]'::jsonb)) AS items
      FROM llm_calls l
     WHERE l.source_document_id = ANY(${keeperIds})
       AND l.response_parsed IS NOT NULL
       AND l.request_messages->0->>'content' LIKE '[segment %'
     ORDER BY l.source_document_id, l.created_at DESC`;
  const keeperOriginalCount = new Map(lastAnswers.map((a) => [a.id, a.items]));

  const itemsByDoc = new Map<string, ItemRow[]>();
  for (const row of items) {
    const list = itemsByDoc.get(row.source_document_id);
    if (list) list.push(row);
    else itemsByDoc.set(row.source_document_id, [row]);
  }
  const membersByKeeper = new Map<string, MemberRow[]>();
  for (const m of members) {
    const list = membersByKeeper.get(m.keeper_id);
    if (list) list.push(m);
    else membersByKeeper.set(m.keeper_id, [m]);
  }

  const unreproducible: Array<Record<string, unknown>> = [];
  const changed: Array<Record<string, unknown>> = [];
  const violations: Array<Record<string, unknown>> = [];
  let reproduced = 0;
  let repeatedBefore = 0;
  let repeatedAfter = 0;

  for (const keeper of keepers) {
    const label = {
      keeperId: keeper.id,
      docNumber: keeper.doc_number,
      inDelivery: keeper.in_delivery,
    };
    const keeperRows = itemsByDoc.get(keeper.id) ?? [];
    const originalCount = keeperOriginalCount.get(keeper.id);
    if (originalCount == null) {
      unreproducible.push({ ...label, reason: 'нет ответа модели по сегменту keeper' });
      continue;
    }
    const copies = [...(membersByKeeper.get(keeper.id) ?? [])].sort(
      (a, b) =>
        (a.segment_index ?? Number.MAX_SAFE_INTEGER) - (b.segment_index ?? Number.MAX_SAFE_INTEGER),
    );
    // Группа на бою уже собрана по (поставщик, номер, дата) — здесь её состав
    // известен, поэтому реквизиты keeper подставляются всем участникам.
    const identity = {
      supplierDirectoryId: keeper.supplier_directory_id ?? 'backtest',
      docNumber: keeper.doc_number ?? 'backtest',
      docDate: keeper.doc_date ?? '1970-01-01',
    };
    const documents: AssemblyMergeDocument[] = [
      {
        id: keeper.id,
        ...identity,
        declaredTotal: keeper.total_sum,
        items: keeperRows.slice(0, originalCount).map(toItem),
      },
      ...copies.map((copy) => ({
        id: copy.id,
        ...identity,
        items: (itemsByDoc.get(copy.id) ?? []).map(toItem),
      })),
    ];
    const before = planAssemblyDocumentMerges(documents);
    const after = planAssemblyDocumentMerges(documents, { copyByRowNo: true });
    const old: AssemblyMergeAction | undefined = before[0];
    const next: AssemblyMergeAction | undefined = after[0];
    if (!old || !next || old.itemIds.length !== keeperRows.length) {
      unreproducible.push({
        ...label,
        reason: 'прежнее правило не воспроизводит фактический состав',
        actualRows: keeperRows.length,
        replayedRows: old?.itemIds.length ?? null,
        keeperOriginalCount: originalCount,
      });
      continue;
    }
    reproduced++;

    const [group] = compareCopyByRowNo(documents, before, after);
    repeatedBefore += group!.repeatedRowNosBefore;
    repeatedAfter += group!.repeatedRowNosAfter;

    const byId = new Map(documents.flatMap((d) => d.items.map((i) => [i.id, i] as const)));
    const total = keeper.total_sum == null ? null : Number(keeper.total_sum);
    const sumBefore = sumOf(old.itemIds, byId);
    const sumAfter = sumOf(next.itemIds, byId);
    const sameSet =
      old.itemIds.length === next.itemIds.length &&
      old.itemIds.every((id, i) => next.itemIds[i] === id);
    const row = {
      ...label,
      relation: old.relation,
      copies: copies.length,
      itemsBefore: group!.itemsBefore,
      itemsAfter: group!.itemsAfter,
      repeatedRowNosBefore: group!.repeatedRowNosBefore,
      repeatedRowNosAfter: group!.repeatedRowNosAfter,
      total,
      sumBefore,
      sumAfter,
    };
    if (!sameSet) changed.push(row);

    if (group!.repeatedRowNosBefore === 0 && !sameSet) {
      violations.push({ criterion: 'а: без повторов набор строк изменился', ...row });
    }
    // Повтор номера внутри самого keeper (модель прочла «1» у двух строк) —
    // не след склейки: номера у такого экземпляра ключом не считаются, и
    // склейка идёт прежним путём. Считаются только повторы сверх него.
    const keeperOwnNos = documents[0]!.items
      .map((i) => i.rowNo)
      .filter((n): n is number => n != null);
    const keeperOwnRepeats = keeperOwnNos.length - new Set(keeperOwnNos).size;
    if (group!.repeatedRowNosAfter > keeperOwnRepeats) {
      violations.push({
        criterion: 'б: склейка оставила повторы номера',
        keeperOwnRepeats,
        ...row,
      });
    }
    if (total != null && sumBefore != null && sumAfter != null) {
      if (Math.abs(sumAfter - total) > Math.abs(sumBefore - total) + 0.01) {
        violations.push({ criterion: 'в: сумма строк удалилась от итога', ...row });
      }
    }
    if (group!.itemsAfter > group!.itemsBefore) {
      violations.push({ criterion: 'г: строк стало больше', ...row });
    }
  }

  const summary = {
    since: args.since,
    keepers: keepers.length,
    reproduced,
    unreproducible: unreproducible.length,
    changed: changed.length,
    changedInDelivery: changed.filter((c) => c.inDelivery).length,
    repeatedRowNosBefore: repeatedBefore,
    repeatedRowNosAfter: repeatedAfter,
    violations: violations.length,
  };
  writeFileSync(
    args.out!,
    JSON.stringify({ summary, violations, changed, unreproducible }, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
  for (const v of violations) console.log('НАРУШЕНИЕ', JSON.stringify(v));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
