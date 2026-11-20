// Сводка машины для строки группы в списке «Документы»: сколько в поставке
// документов и отправок и в какие приёмки она попала.
//
// Считается по ВСЕЙ машине, а не по строкам страницы: при фильтре строка
// группы показывает «найдено M из N», и N обязано быть честным. Один запрос
// на страницу — головы всех машин на ней разом.

import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { machineRootRowsSql } from './document-group.js';

export type MachineSummary = {
  id: string;
  documentCount: number;
  uploadCount: number;
  deliveryNumbers: number[];
};

export async function machineSummaries(
  db: Db,
  headIds: string[],
): Promise<Map<string, MachineSummary>> {
  const unique = [...new Set(headIds)];
  if (unique.length === 0) return new Map();
  // Буквальное coalesce(mb.parent_bundle_id, mb.id) = mr.rid — индекс 0154.
  // display_id приводится к int: bigint postgres-js отдаёт строкой.
  const rows = await db.execute<{
    id: string;
    document_count: number;
    upload_count: number;
    delivery_numbers: number[] | null;
  }>(sql`
    select h.id,
           (
             select count(*)::int
               from ${machineRootRowsSql(sql.raw('h.id'))} mr
               join source_bundles mb on coalesce(mb.parent_bundle_id, mb.id) = mr.rid
               join source_documents d on d.bundle_id = mb.id
              where d.is_technical = false
           ) as document_count,
           (select count(*)::int from ${machineRootRowsSql(sql.raw('h.id'))} mr) as upload_count,
           (
             select array_agg(distinct dl.display_id::int order by dl.display_id::int)
               from ${machineRootRowsSql(sql.raw('h.id'))} mr
               join source_bundles mb on coalesce(mb.parent_bundle_id, mb.id) = mr.rid
               join source_documents d on d.bundle_id = mb.id
               join delivery_sources ds on ds.source_document_id = d.id
               join deliveries dl on dl.id = ds.delivery_id
              where dl.pending_deletion_at is null
           ) as delivery_numbers
      from unnest(array[${sql.join(
        unique.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]) as h(id)
  `);
  return new Map(
    [...rows].map((r) => [
      r.id,
      {
        id: r.id,
        documentCount: r.document_count,
        uploadCount: r.upload_count,
        deliveryNumbers: r.delivery_numbers ?? [],
      },
    ]),
  );
}

/** Полный состав машины — нетехнические документы всех её отправок, по id. */
export async function machineDocumentIdsOf(db: Db, headId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    select d.id
      from ${machineRootRowsSql(sql`${headId}::uuid`)} mr
      join source_bundles mb on coalesce(mb.parent_bundle_id, mb.id) = mr.rid
      join source_documents d on d.bundle_id = mb.id
     where d.is_technical = false
     order by d.id
  `);
  return [...rows].map((r) => r.id);
}
