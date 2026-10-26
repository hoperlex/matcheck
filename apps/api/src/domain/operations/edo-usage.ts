/**
 * В каких ещё приёмках уже стоит УПД из ЭДО.
 *
 * Одна и та же УПД бывает в двух представлениях: строка реестра выгрузки
 * (`edo_export_documents`) и импортированная карточка (`source_documents`,
 * origin `edo_diadoc`). Это один документ, если совпали учётка, сообщение и
 * сущность Диадока — так же их отождествляет привязка (`already_linked`,
 * `foreign_site` в delivery-edo.ts). Счёт по каждому представлению отдельно
 * не увидел бы приёмку, к которой УПД привязали из реестра до импорта.
 *
 * Путей связи три: сверка из реестра, сверка импортом и обычная привязка
 * импортированной УПД как документа приёмки. Приёмка считается один раз,
 * сколькими бы путями она ни была связана.
 *
 * Копия той же УПД у другого оператора (Диадок ↔ СБИС) — тоже этот документ:
 * правило двойника общее с привязкой (domain/edo/export-twins.ts).
 */
import { sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { twinCondition } from '../edo/export-twins.js';

export type EdoDocumentRef = { source: 'import' | 'export'; id: string };

export type EdoUsage = {
  /** Число разных приёмок, кроме исключённой. */
  count: number;
  /** Первые из них по номеру — для показа менеджеру. */
  deliveries: { deliveryId: string; displayId: number }[];
};

/** Сколько номеров приёмок показывать; остальные — «и ещё N». */
export const USAGE_SHOWN = 10;

export function edoUsageKey(ref: EdoDocumentRef): string {
  return `${ref.source}:${ref.id}`;
}

function uuidArray(values: readonly string[]) {
  return drSql`ARRAY[${drSql.join(
    values.map((value) => drSql`${value}`),
    drSql`, `,
  )}]::uuid[]`;
}

/**
 * Использование документов по ключу `edoUsageKey`. Документа без других
 * приёмок в ответе нет.
 */
export async function edoDocumentUsage(
  db: Db,
  docs: readonly EdoDocumentRef[],
  excludeDeliveryId: string,
): Promise<Map<string, EdoUsage>> {
  const usage = new Map<string, EdoUsage>();
  const exportIds = [...new Set(docs.filter((d) => d.source === 'export').map((d) => d.id))];
  const importIds = [...new Set(docs.filter((d) => d.source === 'import').map((d) => d.id))];
  if (!exportIds.length && !importIds.length) return usage;

  // Идентичность берём только у документа с учёткой и сообщением — как
  // привязка. У импорта без них остаётся связь по самому id.
  const rows = await db.execute<{
    source: 'import' | 'export';
    id: string;
    delivery_id: string;
    display_id: string | number;
  }>(drSql`
    with requested as (
      select 'export'::text as source, e.id, e.edo_account_id as account, e.message_id as message, e.entity_id as entity
        from edo_export_documents e
       where e.id = any(${uuidArray(exportIds)})
      union all
      select 'import', s.id, s.edo_account_id, s.provider_message_id, s.provider_entity_id
        from source_documents s
       where s.id = any(${uuidArray(importIds)})
    ),
    own as (
      select r.source, r.id, 'export'::text as kind, r.id as doc_id
        from requested r where r.source = 'export'
      union
      select r.source, r.id, 'export', e.id
        from requested r
        join edo_export_documents e
          on e.edo_account_id = r.account and e.message_id = r.message and e.entity_id = r.entity
       where r.account is not null and r.message is not null
      union
      select r.source, r.id, 'import', r.id
        from requested r where r.source = 'import'
      union
      select r.source, r.id, 'import', s.id
        from requested r
        join source_documents s
          on s.edo_account_id = r.account and s.provider_message_id = r.message and s.provider_entity_id = r.entity
       where r.account is not null and r.message is not null and s.origin = 'edo_diadoc'
    ),
    -- Копия той же УПД у другого оператора и её карточка (export-twins.ts).
    cross_export as (
      select o.source, o.id, 'export'::text as kind, tw.id as doc_id
        from own o
        join edo_export_documents s on s.id = o.doc_id
        join edo_accounts sa on sa.id = s.edo_account_id
        join edo_export_documents tw
          on tw.content_sha256 = s.content_sha256 or tw.file_id = s.file_id or tw.content_key = s.content_key
        join edo_accounts ta on ta.id = tw.edo_account_id
       where o.kind = 'export' and ${twinCondition('tw', 'ta', 's', 'sa')}
    ),
    twins as (
      select * from own
      union
      select * from cross_export
      union
      select c.source, c.id, 'import', sd.id
        from cross_export c
        join edo_export_documents e on e.id = c.doc_id
        join source_documents sd
          on sd.edo_account_id = e.edo_account_id and sd.provider_message_id = e.message_id
         and sd.provider_entity_id = e.entity_id
       where sd.origin = 'edo_diadoc'
    ),
    links as (
      select t.source, t.id, dem.delivery_id
        from twins t join delivery_edo_matches dem on dem.export_document_id = t.doc_id
       where t.kind = 'export'
      union
      select t.source, t.id, dem.delivery_id
        from twins t join delivery_edo_matches dem on dem.source_document_id = t.doc_id
       where t.kind = 'import'
      union
      select t.source, t.id, ds.delivery_id
        from twins t join delivery_sources ds on ds.source_document_id = t.doc_id
       where t.kind = 'import'
    )
    select l.source, l.id, d.id as delivery_id, d.display_id
      from links l
      join deliveries d on d.id = l.delivery_id
     where l.delivery_id <> ${excludeDeliveryId}
     order by l.source, l.id, d.display_id
  `);

  for (const row of rows) {
    const key = edoUsageKey({ source: row.source, id: row.id });
    const entry = usage.get(key) ?? { count: 0, deliveries: [] };
    entry.count += 1;
    if (entry.deliveries.length < USAGE_SHOWN) {
      entry.deliveries.push({ deliveryId: row.delivery_id, displayId: Number(row.display_id) });
    }
    usage.set(key, entry);
  }
  return usage;
}
