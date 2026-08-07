// Происхождение документа: пришёл ли он с публичной страницы /uploads.
//
// Живёт в domain, а не в routes, потому что нужен обоим процессам: HTTP-роут
// отдаёт признак в DTO (значок облачка в списке), а воркер решает по нему,
// включать ли автоподстановку подрядчика — она разрешена ТОЛЬКО на публичном
// канале. Импортировать routes из воркера нельзя: тот поднимает Fastify-плагины
// и тянет за собой половину приложения.

import { sql } from 'drizzle-orm';
import { ingestEvents, sourceBundles, sourceDocuments } from '../../db/schema.js';

/**
 * Пришёл ли документ с публичной страницы загрузки.
 *
 * EXISTS, а не JOIN: на пакете может быть несколько публичных отправок (тот же
 * комплект прислали повторно), и обычное соединение размножило бы строки
 * документа — поехали бы и пагинация, и total.
 *
 * COALESCE(parent_bundle_id, id): накладные router разворачивает в ДОЧЕРНИЙ
 * пакет, и реальный документ ТН/ОС-2 висит уже на нём — событие приёма лежит
 * на родителе.
 */
export const fromSupplierPortalSql = sql<boolean>`exists (
  select 1
    from ${ingestEvents} ie
    join ${sourceBundles} b on b.id = ${sourceDocuments.bundleId}
   where ie.bundle_id = coalesce(b.parent_bundle_id, b.id)
     and ie.channel = 'public'
)`;

/**
 * То же самое для одного документа по его id — форма, пригодная воркеру, где
 * запрос строится не вокруг таблицы source_documents.
 *
 * Отдельная функция, а не переиспользование константы выше: та ссылается на
 * колонку sourceDocuments.bundleId и работает только внутри выборки по этой
 * таблице.
 */
export function isPublicOriginSql(sourceDocumentId: string) {
  return sql<boolean>`exists (
    select 1
      from ${ingestEvents} ie
      join ${sourceBundles} b on b.id = (
        select sd.bundle_id from ${sourceDocuments} sd where sd.id = ${sourceDocumentId}
      )
     where ie.bundle_id = coalesce(b.parent_bundle_id, b.id)
       and ie.channel = 'public'
  )`;
}
