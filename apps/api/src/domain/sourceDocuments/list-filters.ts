import type { FastifyInstance } from 'fastify';
import { type SQL, eq, ilike, inArray, sql as drSql } from 'drizzle-orm';
import { deliverySources, shipmentSources, sourceDocuments } from '../../db/schema.js';
import {
  expandCustomerCounterpartyToOpIds,
  expandSupplierToOpIds,
  resolveContractorOpIds,
  sourceDocumentContractorPredicate,
} from '../../lib/contractor-scope.js';
import { escapeLike } from '../../lib/like.js';
import { parseUuidCsv } from '../../lib/uuid-csv.js';
import type { AuthUser } from '../../plugins/auth.js';
import { notStubDocumentSql } from './stub-documents.js';

/**
 * Условия выборки документов — ОДИН набор для списка и для выгрузки Excel.
 *
 * Раньше их было два, и они разошлись: выгрузка не убирала технические записи
 * и заглушки, не знала про `kind` и «требуют внимания», а `q` искала только по
 * номеру. Пользователь ставил фильтр, видел на экране двенадцать строк и
 * получал файл с одной шапкой — либо, наоборот, лишние заявки и заглушки.
 *
 * Идентификаторы подрядчика и поставщика — это id СПРАВОЧНИКОВ заказчика
 * (`customer_counterparties`, `suppliers`), то есть ровно то, что человек видит
 * в выпадающем списке и во вкладках «Справочники». В операционные FK они
 * разворачиваются здесь, по нормализованному ИНН — тем же способом, что в
 * «Операциях» и «Отгрузке». До этого список документов сравнивал их напрямую с
 * `source_documents.supplier_id`, который у всех современных УПД пустой
 * (поставщик живёт в `supplier_directory_id`), и фильтр «Поставщик» не находил
 * ничего вообще.
 */
type DocumentKind = (typeof sourceDocuments.kind)['_']['data'];

export interface SourceDocumentFilterQuery {
  kind?: readonly DocumentKind[] | undefined;
  direction?: 'inbound' | 'outbound' | undefined;
  q?: string | undefined;
  unaccepted?: boolean | undefined;
  contractorIds?: string | undefined;
  supplierIds?: string | undefined;
  siteIds?: string | undefined;
  docDateFrom?: string | undefined;
  docDateTo?: string | undefined;
  expectedDateFrom?: string | undefined;
  expectedDateTo?: string | undefined;
  needsAttention?: boolean | undefined;
  mismatch?: boolean | undefined;
}

export async function buildSourceDocumentFilters(
  app: FastifyInstance,
  query: SourceDocumentFilterQuery,
  user: AuthUser | undefined,
): Promise<SQL[]> {
  const {
    kind,
    direction,
    q,
    unaccepted,
    contractorIds,
    supplierIds,
    siteIds,
    docDateFrom,
    docDateTo,
    expectedDateFrom,
    expectedDateTo,
    needsAttention,
    mismatch,
  } = query;

  // Техническая запись пакета — служебная: она живёт от загрузки до разбора и
  // документом не является. Ни в списке, ни в выгрузке ей делать нечего.
  const conditions: SQL[] = [eq(sourceDocuments.isTechnical, false)];

  if (needsAttention) {
    // Непустой массив warnings. jsonb_array_length по отсутствующему ключу
    // падает, поэтому сначала проверяем сам ключ и его тип.
    conditions.push(
      drSql`${sourceDocuments.validation} -> 'warnings' is not null
            and jsonb_typeof(${sourceDocuments.validation} -> 'warnings') = 'array'
            and jsonb_array_length(${sourceDocuments.validation} -> 'warnings') > 0`,
    );
  }

  // Расхождение в документе: арифметика УПД не сошлась при разборе. На это
  // число ведёт плашка «Требует внимания» в «Статистике», и без фильтра ссылка
  // открывала весь список документов подряд.
  if (mismatch) {
    conditions.push(eq(sourceDocuments.parseErrorCode, 'validation_mismatch'));
  }

  if (kind && kind.length > 0) {
    const first = kind[0];
    if (kind.length === 1 && first) conditions.push(eq(sourceDocuments.kind, first));
    else conditions.push(inArray(sourceDocuments.kind, kind));
  }

  if (direction) conditions.push(eq(sourceDocuments.direction, direction));

  // Поиск и по имени файла: у заглушки номера нет вовсе, и поиск только по
  // doc_number прятал бы её при любом непустом запросе — то есть ровно те
  // документы, которые менеджер и ищет глазами по названию файла.
  //
  // escapeLike — чтобы «100%» искалось как «100%», а не как «100<что угодно>».
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      drSql`(${ilike(sourceDocuments.docNumber, like)}
             or ${ilike(sourceDocuments.originalFilename, like)})`,
    );
  }

  // Скоуп роли. inspector_kpp видит только свой объект, contractor — только
  // документы своего подрядчика; без привязки — пустая выдача.
  if (user?.role === 'inspector_kpp') {
    if (!user.siteId) {
      conditions.push(drSql`false`);
    } else {
      conditions.push(eq(sourceDocuments.siteId, user.siteId));
    }
  } else if (user?.role === 'contractor') {
    const opIds = await resolveContractorOpIds(app, user);
    if (!opIds || opIds.length === 0) {
      conditions.push(drSql`false`);
    } else {
      conditions.push(sourceDocumentContractorPredicate(opIds));
    }
  }

  if (unaccepted) {
    if (direction !== 'outbound') {
      const linkedToDelivery = app.db
        .select({ id: deliverySources.sourceDocumentId })
        .from(deliverySources);
      conditions.push(drSql`${sourceDocuments.id} not in ${linkedToDelivery}`);
    }
    if (direction !== 'inbound') {
      const linkedToShipment = app.db
        .select({ id: shipmentSources.sourceDocumentId })
        .from(shipmentSources);
      conditions.push(drSql`${sourceDocuments.id} not in ${linkedToShipment}`);
    }
    // «Ожидаемые» — очередь на приёмку. Заглушке ручного разбора там не место:
    // документа по ней не будет, а висеть в ожидании она может вечно.
    conditions.push(notStubDocumentSql());
  }

  const contractorDirIds = parseUuidCsv(contractorIds);
  if (contractorDirIds.length > 0) {
    const opIds = await expandCustomerCounterpartyToOpIds(app, contractorDirIds);
    // Ни один id справочника не имеет операционной пары по ИНН — значит
    // документов такого подрядчика нет; пустой фильтр вместо «показать всё».
    if (opIds.length === 0) conditions.push(drSql`false`);
    else conditions.push(inArray(sourceDocuments.contractorId, opIds));
  }

  const supplierDirIds = parseUuidCsv(supplierIds);
  if (supplierDirIds.length > 0) {
    // Два пути: современные УПД ссылаются на справочник напрямую
    // (supplier_directory_id), исторические — на операционного контрагента.
    const opIds = await expandSupplierToOpIds(app, supplierDirIds);
    conditions.push(
      opIds.length > 0
        ? drSql`(${sourceDocuments.supplierDirectoryId} in ${supplierDirIds}
                 or ${sourceDocuments.supplierId} in ${opIds})`
        : drSql`${sourceDocuments.supplierDirectoryId} in ${supplierDirIds}`,
    );
  }

  const siteIdsArr = parseUuidCsv(siteIds);
  if (siteIdsArr.length > 0) conditions.push(inArray(sourceDocuments.siteId, siteIdsArr));

  // Диапазоны дат (docDate/expectedDate — timestamp без TZ, mode:date).
  // Включительно по дню: >= from и < to+1день.
  if (docDateFrom) conditions.push(drSql`${sourceDocuments.docDate} >= ${docDateFrom}::date`);
  if (docDateTo)
    conditions.push(drSql`${sourceDocuments.docDate} < (${docDateTo}::date + interval '1 day')`);
  if (expectedDateFrom)
    conditions.push(drSql`${sourceDocuments.expectedDate} >= ${expectedDateFrom}::date`);
  if (expectedDateTo)
    conditions.push(
      drSql`${sourceDocuments.expectedDate} < (${expectedDateTo}::date + interval '1 day')`,
    );

  return conditions;
}
