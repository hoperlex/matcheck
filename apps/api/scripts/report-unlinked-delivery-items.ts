/**
 * Позиции приёмок, потерявшие привязку к документу: ОТЧЁТ.
 *
 * Откуда взялись. При upsert происхождение восстанавливал `resolveItemOrigins`,
 * и шаг 1 (совпадение по id строки) считал ответом даже пустое наследство:
 * строка, однажды записанная без привязки, не получала её уже никогда, сколько
 * бы раз клиент ни присылал корректный `sourceDocumentId`. Дыра закрыта, но
 * накопленное правка не чинит. Боевой эталон — приёмка 14289: «ЦПС-С5» 22, в
 * документе «м³», в приёмке «шт», в карточке «УПД № 125 (0 из 1)» и отдельный
 * блок «без привязки к документу».
 *
 * СКРИПТ НИЧЕГО НЕ ПИШЕТ. Флага --apply здесь нет намеренно: правка строк в
 * подтверждённых МОЛ приёмках — решение владельца, а не следствие выката. К
 * тому же upsert без `baseVersion` принимается как есть, и офлайн-клиент со
 * старым снимком способен вернуть строку в прежний вид.
 *
 * Само правило сопоставления живёт в
 * src/domain/operations/unlinked-item-restore.ts и закрыто тестами, а название
 * нормализуется той же функцией, что и в upsert
 * (`normalizeItemNameForMatch`), — иначе отчёт разошёлся бы с поведением
 * сервера.
 *
 * Что на выходе:
 *   1. полный текст SQL — чтобы цифры можно было проверить независимо;
 *   2. по каждой приёмке: строки к восстановлению с пометками о расхождении
 *      единицы и количества;
 *   3. отдельный список «на ручной разбор» (нет пары либо неоднозначно);
 *   4. готовые UPDATE — их выполняет человек, а не скрипт.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/report-unlinked-delivery-items.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/report-unlinked-delivery-items.ts --days 60
 */
import { sql } from '../src/db/client.js';
import {
  planUnlinkedRestores,
  type DocumentItemRow,
  type UnlinkedItemRow,
} from '../src/domain/operations/unlinked-item-restore.js';

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 30;
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error('--days ожидает положительное число');
  process.exit(1);
}

/**
 * Кандидаты: строки без происхождения в приёмках, у которых ровно ОДНА связь с
 * документом. При нескольких документах одинаковая позиция встречается в разных
 * УПД, и сопоставлять по названию нельзя.
 */
const QUERY = `
SELECT
  d.id           AS delivery_id,
  d.display_id   AS delivery_display_id,
  st.code        AS delivery_status,
  d.version      AS delivery_version,
  ds.source_document_id,
  sd.doc_number,
  di.id          AS item_id,
  di.name_raw    AS item_name,
  di.unit        AS item_unit,
  di.qty_actual  AS item_qty
FROM deliveries d
JOIN statuses st ON st.id = d.status_id
JOIN delivery_items di ON di.delivery_id = d.id AND di.source_document_id IS NULL
JOIN delivery_sources ds ON ds.delivery_id = d.id
JOIN source_documents sd ON sd.id = ds.source_document_id
WHERE d.arrived_at >= now() - ($1 || ' days')::interval
  AND (SELECT count(*) FROM delivery_sources x WHERE x.delivery_id = d.id) = 1
ORDER BY d.display_id, di.line_no`;

const DOC_ITEMS_QUERY = `
SELECT id AS item_id, name_raw, unit, qty
FROM source_document_items
WHERE source_document_id = $1
ORDER BY line_no`;

type CandidateRow = {
  delivery_id: string;
  delivery_display_id: number;
  delivery_status: string;
  delivery_version: number;
  source_document_id: string;
  doc_number: string | null;
  item_id: string;
  item_name: string;
  item_unit: string;
  item_qty: string | null;
};

async function main(): Promise<void> {
  console.log(`Окно: последние ${DAYS} дн. Запрос кандидатов (выполняется как есть):`);
  console.log('─'.repeat(78));
  console.log(QUERY.trim());
  console.log('─'.repeat(78));
  console.log();

  const rows = (await sql.unsafe(QUERY, [String(DAYS)])) as unknown as CandidateRow[];
  const byDelivery = new Map<string, CandidateRow[]>();
  for (const row of rows) {
    const list = byDelivery.get(row.delivery_id) ?? [];
    list.push(row);
    byDelivery.set(row.delivery_id, list);
  }

  const updates: string[] = [];
  const manual: string[] = [];
  let restoredCount = 0;

  for (const [, items] of byDelivery) {
    const head = items[0]!;
    const docItems = (await sql.unsafe(DOC_ITEMS_QUERY, [head.source_document_id])) as unknown as {
      item_id: string;
      name_raw: string;
      unit: string;
      qty: string | null;
    }[];

    const unlinked: UnlinkedItemRow[] = items.map((i) => ({
      itemId: i.item_id,
      nameRaw: i.item_name,
      unit: i.item_unit,
      qty: i.item_qty,
    }));
    const documentItems: DocumentItemRow[] = docItems.map((i) => ({
      itemId: i.item_id,
      nameRaw: i.name_raw,
      unit: i.unit,
      qty: i.qty,
    }));

    const plan = planUnlinkedRestores({ unlinked, documentItems });
    const closed = head.delivery_status === 'confirmed_mol' ? ' — ПОДТВЕРЖДЕНА МОЛ' : '';
    console.log(
      `#${head.delivery_display_id} · ${head.delivery_status}${closed} · версия ` +
        `${head.delivery_version} · УПД ${head.doc_number ?? '—'} · ` +
        `строк без привязки ${items.length} из ${documentItems.length} в документе`,
    );

    for (const r of plan.restore) {
      const notes = [
        r.unitDiffers ? 'единица расходится' : null,
        r.qtyDiffers ? 'КОЛИЧЕСТВО расходится' : null,
      ]
        .filter(Boolean)
        .join(', ');
      console.log(`   ✓ «${r.nameRaw}» → ${r.sourceDocumentItemId}${notes ? ` (${notes})` : ''}`);
      updates.push(
        `UPDATE delivery_items SET source_document_id = '${head.source_document_id}', ` +
          `source_document_item_id = '${r.sourceDocumentItemId}' WHERE id = '${r.itemId}';`,
      );
      restoredCount += 1;
    }
    for (const m of plan.manual) {
      const why = m.reason === 'no_match' ? 'в документе нет такой позиции' : 'неоднозначно';
      console.log(`   ? «${m.nameRaw}» — ${why}`);
      manual.push(`  ${m.itemId}  -- #${head.delivery_display_id} «${m.nameRaw}», ${why}`);
    }
    console.log();
  }

  console.log('═'.repeat(78));
  console.log(`Приёмок затронуто: ${byDelivery.size}`);
  console.log(`Строк восстанавливается однозначно: ${restoredCount}`);
  console.log(`На ручной разбор: ${manual.length}`);
  if (manual.length) {
    console.log();
    for (const line of manual) console.log(line);
  }
  if (updates.length) {
    console.log();
    console.log('Готовые UPDATE (выполняет человек, скрипт их НЕ применяет):');
    for (const u of updates) console.log(u);
  }
  console.log();
  console.log('Ничего не изменено: скрипт только читает.');
  await sql.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
