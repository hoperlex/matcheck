/**
 * Единицы измерения, потерянные на финализации 2 Этапа: ОТЧЁТ и починка.
 *
 * Откуда потери. Планшет собирает позиции без поля `unit`, и в запрос уезжает
 * «шт»: на бою за 30 дней так испорчено 2989 позиций из 3068, у которых в
 * документе стояла не «шт» — «84 м» кабеля превращались в «84 шт», «30 м³»
 * плит в «30 шт». Приёмки, не дошедшие до 2 Этапа, единицу сохраняют полностью.
 * Причина закрыта в рантайме (UNIT_FROM_DOCUMENT), но историю она не чинит.
 *
 * Отбираются ТОЛЬКО безопасные строки: привязанные к позиции документа, где в
 * приёмке «шт», а в документе иная непустая единица, и где строка документа
 * принадлежит именно тому документу, что записан в происхождении (в схеме это
 * два независимых внешних ключа).
 *
 * Почему `--apply` меняет не только позиции. Одиночный UPDATE строк не трогает
 * `deliveries.updated_at` и `version`: планшет не увидит исправленный снимок, а
 * его следующий upsert со старым OCC-значением снова запишет «шт». Поэтому одна
 * транзакция: строки + версия + время операции.
 *
 * Идемпотентность: повторный запуск не найдёт этих строк вовсе — после правки
 * единица в приёмке уже не «шт».
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/repair-item-units.ts --from 2026-08-11 --to 2026-09-10
 *   pnpm --filter @matcheck/api exec tsx scripts/repair-item-units.ts --from ... --to ... --apply
 */
import { sql } from '../src/db/client.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const FROM = arg('--from');
const TO = arg('--to');
const APPLY = process.argv.includes('--apply');

if (!FROM || !TO) {
  console.error(
    'Обязательны границы окна: --from YYYY-MM-DD --to YYYY-MM-DD\n' +
      '«Накопленное» и «за 30 дней» — разные объёмы, границы задаются явно.',
  );
  process.exit(1);
}

/**
 * Кандидаты. `sdi.source_document_id = di.source_document_id` — та же проверка,
 * что и в рантайме: связь строки с документом БД не гарантирует.
 */
const QUERY = `
SELECT
  d.id            AS delivery_id,
  d.display_id    AS delivery_display_id,
  st.code         AS delivery_status,
  d.version       AS delivery_version,
  di.id           AS item_id,
  di.name_raw,
  di.unit         AS delivery_unit,
  sdi.unit        AS document_unit,
  sd.doc_number
FROM deliveries d
JOIN statuses st ON st.id = d.status_id
JOIN delivery_items di ON di.delivery_id = d.id
JOIN source_document_items sdi
  ON sdi.id = di.source_document_item_id
 AND sdi.source_document_id = di.source_document_id
JOIN source_documents sd ON sd.id = di.source_document_id
WHERE d.arrived_at >= $1::date
  AND d.arrived_at < ($2::date + interval '1 day')
  AND lower(btrim(di.unit)) = 'шт'
  AND sdi.unit IS NOT NULL
  AND btrim(sdi.unit) <> ''
  AND lower(btrim(sdi.unit)) <> 'шт'
ORDER BY d.display_id, di.line_no`;

type Row = {
  delivery_id: string;
  delivery_display_id: number;
  delivery_status: string;
  delivery_version: number;
  item_id: string;
  name_raw: string;
  delivery_unit: string;
  document_unit: string;
  doc_number: string | null;
};

async function main(): Promise<void> {
  console.log(`Окно: ${FROM} … ${TO}. Режим: ${APPLY ? 'ПРИМЕНЕНИЕ' : 'только отчёт'}.`);
  console.log('Запрос кандидатов (выполняется как есть):');
  console.log('─'.repeat(78));
  console.log(QUERY.trim());
  console.log('─'.repeat(78));
  console.log();

  const rows = (await sql.unsafe(QUERY, [FROM, TO])) as unknown as Row[];
  const byDelivery = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byDelivery.get(row.delivery_id) ?? [];
    list.push(row);
    byDelivery.set(row.delivery_id, list);
  }

  for (const [, items] of byDelivery) {
    const head = items[0]!;
    console.log(
      `#${head.delivery_display_id} · ${head.delivery_status} · версия ${head.delivery_version} · строк ${items.length}`,
    );
    for (const r of items) {
      console.log(
        `   «${r.name_raw.slice(0, 48)}» · УПД ${r.doc_number ?? '—'} · ` +
          `${r.delivery_unit} → ${r.document_unit}`,
      );
    }
  }

  console.log('═'.repeat(78));
  console.log(`Операций затронуто: ${byDelivery.size}`);
  console.log(`Строк к исправлению: ${rows.length}`);

  if (!APPLY) {
    console.log();
    console.log('Ничего не изменено: запуск без --apply.');
    await sql.end({ timeout: 5 });
    return;
  }

  // Одна транзакция на всё: строки и версии операций должны меняться вместе,
  // иначе планшет получит исправленные позиции при старой версии.
  let updatedItems = 0;
  await sql.begin(async (tx) => {
    for (const [deliveryId, items] of byDelivery) {
      for (const r of items) {
        const res = await tx`
          UPDATE delivery_items SET unit = ${r.document_unit}
          WHERE id = ${r.item_id} AND lower(btrim(unit)) = 'шт'`;
        updatedItems += res.count;
      }
      await tx`
        UPDATE deliveries
        SET version = version + 1, updated_at = now()
        WHERE id = ${deliveryId}`;
    }
  });

  console.log();
  console.log(`Исправлено строк: ${updatedItems}, операций: ${byDelivery.size}.`);
  console.log('Версия и updated_at операций подняты — планшет получит свежий снимок.');
  await sql.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
