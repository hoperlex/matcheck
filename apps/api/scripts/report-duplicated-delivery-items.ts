/**
 * Строки приёмок, задвоенные разрезанным надвое документом: ОТЧЁТ.
 *
 * Откуда берутся. Сегментация разрезала документ на два, у второго фрагмента
 * модель прочла чужую дату — строгая склейка их не свела, и оба опубликовались.
 * Обе копии привязались к одной приёмке, и позиция попала в учёт дважды. Боевой
 * эталон — приёмка 13776: «Соединитель пруток — полоса, 80х80», 47 шт учтено
 * как 94, лишние 12 482 ₽. Профилактика — relaxed-проход склейки
 * (UPD_ASSEMBLY_RELAXED_COPY); историю она не чинит, для этого нужен отдельный
 * разбор — вот он.
 *
 * СКРИПТ НИЧЕГО НЕ ПИШЕТ. Флага --apply здесь нет намеренно: удаление строк из
 * подтверждённых МОЛ приёмок — решение владельца, а не следствие выката. И до
 * него нужно закрыть ещё одну дыру: сервер сверяет версию приёмки только когда
 * клиент прислал baseVersion (deliveries.ts, upsert), а запрос без него
 * принимается как есть — старый офлайн-клиент воскресит удалённые строки.
 *
 * Само правило «это одна и та же позиция» живёт в
 * src/domain/edo/duplicated-delivery-items.ts и закрыто тестами: по нему потом
 * будут удалять строки, и прятать его в CLI нельзя.
 *
 * Что отчёт даёт на выходе:
 *   1. полный текст SQL — чтобы цифры можно было проверить независимо;
 *   2. снимок ВСЕХ полей каждой строки-кандидата и её пары;
 *   3. явный список id строк к удалению — по нему потом и пойдёт правка;
 *   4. отдельный список «на ручной разбор» — там, где строки различаются хоть
 *      одним пользовательским полем или поставщиком документа.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/report-duplicated-delivery-items.ts
 */
import { sql } from '../src/db/client.js';
import {
  COMPARED_ITEM_FIELDS,
  EXCLUDED_ITEM_FIELDS,
  fieldValue,
  findDuplicatePairs,
  looksLikeKpp,
  type DuplicateCandidateRow,
} from '../src/domain/edo/duplicated-delivery-items.js';

const QUERY = `
SELECT
  d.id            AS delivery_id,
  d.display_id    AS delivery_display_id,
  st.code         AS delivery_status,
  d.version       AS delivery_version,
  di.id, di.line_no, di.material_id, di.item_kind, di.asset_id,
  di.inventory_number, di.serial_number, di.name_raw,
  di.qty_planned, di.qty_actual, di.unit, di.comment,
  di.volume_m3, di.mass_kg, di.price, di.vat_rate, di.vat_sum,
  di.volume_confidence, di.group_name,
  di.source_document_id, di.source_document_item_id,
  sd.bundle_id, sd.doc_number, sd.doc_date, sd.supplier_directory_id,
  sup.name AS supplier_name, sup.inn AS supplier_inn,
  sd.is_technical AS doc_is_technical, sd.status AS doc_status, sd.created_at AS doc_created_at,
  (SELECT count(*) FROM source_document_items i WHERE i.source_document_id = sd.id) AS doc_items
FROM deliveries d
JOIN statuses st ON st.id = d.status_id
JOIN delivery_items di ON di.delivery_id = d.id
JOIN source_documents sd ON sd.id = di.source_document_id
LEFT JOIN suppliers sup ON sup.id = sd.supplier_directory_id
WHERE d.id IN (
  -- Приёмки, куда попали строки из ДВУХ И БОЛЕЕ документов одного пакета:
  -- только там разрез надвое и мог задвоить позицию.
  SELECT di2.delivery_id
  FROM delivery_items di2
  JOIN source_documents sd2 ON sd2.id = di2.source_document_id
  WHERE sd2.bundle_id IS NOT NULL
  GROUP BY di2.delivery_id, sd2.bundle_id
  HAVING count(DISTINCT sd2.id) > 1
)
ORDER BY d.display_id, di.line_no`;

type Row = DuplicateCandidateRow & {
  delivery_id: string;
  delivery_display_id: number;
  delivery_status: string;
  delivery_version: number;
};

/** Поставщик документа человеческой строкой, с пометкой о подозрительном ИНН. */
function supplierLabel(row: Row): string {
  const inn = row.supplier_inn ?? '—';
  const suspect = looksLikeKpp(row.supplier_inn) ? ' (9 цифр — похоже на КПП)' : '';
  return `${row.supplier_name ?? '(поставщик не определён)'} · ИНН ${inn}${suspect}`;
}

function printPair(keep: Row, drop: Row, reasons: string[]): void {
  const width = Math.max(...COMPARED_ITEM_FIELDS.map((f) => f.length)) + 4;
  console.log(`      ${'поле'.padEnd(width)}${'остаётся'.padEnd(28)}кандидат на удаление`);
  for (const field of COMPARED_ITEM_FIELDS) {
    const mark = reasons.includes(field) ? ' ← РАЗЛИЧАЕТСЯ' : '';
    console.log(
      `      ${field.padEnd(width)}${fieldValue(keep, field).slice(0, 26).padEnd(28)}` +
        `${fieldValue(drop, field).slice(0, 26)}${mark}`,
    );
  }
  for (const field of EXCLUDED_ITEM_FIELDS) {
    console.log(
      `      ${`${field} (не сравн.)`.padEnd(width)}` +
        `${fieldValue(keep, field).slice(0, 26).padEnd(28)}${fieldValue(drop, field).slice(0, 26)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log('Запрос кандидатов (выполняется как есть):');
  console.log('─'.repeat(78));
  console.log(QUERY.trim());
  console.log('─'.repeat(78));
  console.log();

  const rows = (await sql.unsafe(QUERY)) as unknown as Row[];
  const byDelivery = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byDelivery.get(row.delivery_id) ?? [];
    list.push(row);
    byDelivery.set(row.delivery_id, list);
  }

  const toDelete: Array<{ id: string; delivery: number; name: string }> = [];
  const toReview: Array<{
    ids: [string, string];
    delivery: number;
    name: string;
    reasons: string[];
  }> = [];
  const affected = new Map<number, { status: string; version: number }>();

  for (const [, deliveryRows] of byDelivery) {
    const pairs = findDuplicatePairs(deliveryRows) as Array<{
      keep: Row;
      drop: Row;
      reasons: string[];
      deletable: boolean;
    }>;
    if (pairs.length === 0) continue;

    const first = deliveryRows[0]!;
    // Хранимой итоговой суммы у приёмки нет — она считается на лету в отчётах.
    // Поэтому «что изменится после» показываем тем же способом: Σ qty × price
    // по строкам приёмки сейчас и без строк-кандидатов. Это и есть число,
    // которое увидит человек, открыв приёмку после правки.
    const lineTotal = (rows: Row[]): number =>
      rows.reduce((acc, r) => acc + Number(r.qty_actual ?? 0) * Number(r.price ?? 0), 0);
    const droppedIds = new Set(pairs.filter((p) => p.deletable).map((p) => p.drop.id));
    const totalNow = lineTotal(deliveryRows);
    const totalAfter = lineTotal(deliveryRows.filter((r) => !droppedIds.has(r.id)));

    affected.set(first.delivery_display_id, {
      status: first.delivery_status,
      version: first.delivery_version,
    });
    console.log(
      `Приёмка #${first.delivery_display_id} · статус ${first.delivery_status} · ` +
        `версия ${first.delivery_version} · пар: ${pairs.length}`,
    );
    console.log(
      `  сумма по строкам: ${totalNow.toFixed(2)} → ${totalAfter.toFixed(2)} ` +
        `(снимается ${(totalNow - totalAfter).toFixed(2)})`,
    );
    // Финансовые поля ОСТАЮЩИХСЯ строк правка не трогает: удаляется дубль
    // целиком, цена и ставка выживших не пересчитываются.

    for (const { keep, drop, reasons, deletable } of pairs) {
      console.log(`  ${deletable ? 'К УДАЛЕНИЮ' : 'НА РУЧНОЙ РАЗБОР'}: «${keep.name_raw}»`);
      console.log(
        `    документы: ${keep.source_document_id} (${keep.doc_items} поз.) ` +
          `и ${drop.source_document_id} (${drop.doc_items} поз.), номер ${keep.doc_number}`,
      );
      console.log(`    поставщик остающейся: ${supplierLabel(keep)}`);
      if (keep.supplier_directory_id !== drop.supplier_directory_id) {
        console.log(`    поставщик кандидата:  ${supplierLabel(drop)}`);
      }
      printPair(keep, drop, reasons);
      if (deletable) {
        toDelete.push({ id: drop.id, delivery: keep.delivery_display_id, name: keep.name_raw });
      } else {
        toReview.push({
          ids: [keep.id, drop.id],
          delivery: keep.delivery_display_id,
          name: keep.name_raw,
          reasons,
        });
      }
      console.log();
    }
  }

  console.log('═'.repeat(78));
  console.log(`Приёмок затронуто: ${affected.size}`);
  for (const [displayId, info] of affected) {
    const note = info.status === 'confirmed_mol' ? ' — ПОДТВЕРЖДЕНА МОЛ, правка задним числом' : '';
    console.log(`  #${displayId} · ${info.status} · версия ${info.version}${note}`);
  }
  console.log();
  console.log(`Строк к удалению: ${toDelete.length}`);
  for (const row of toDelete) console.log(`  ${row.id}  -- #${row.delivery} «${row.name}»`);
  console.log();
  console.log(`На ручной разбор: ${toReview.length}`);
  for (const row of toReview) {
    console.log(
      `  ${row.ids[0]} / ${row.ids[1]}  -- #${row.delivery} «${row.name}», ` +
        `причины: ${row.reasons.join(', ')}`,
    );
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
