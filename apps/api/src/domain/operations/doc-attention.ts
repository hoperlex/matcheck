/**
 * Признак «операции нужна проверка» — ЕДИНЫЙ источник для фильтра, значка,
 * колонки выгрузки и плашки.
 *
 * Зачем отдельный модуль. Признак сначала жил только в ветке фильтра
 * `doc_attention`, а значок в списке и колонка Excel считали своё: значок
 * смотрел лишь на сводки связанных документов, выгрузка — только на них же.
 * В итоге приёмка, у которой сигнал есть только в сверке фото, попадала в
 * отфильтрованную выдачу, но выглядела там чистой — без значка и с пустой
 * колонкой. Три места разошлись ровно потому, что условие было написано трижды.
 *
 * Теперь оно одно и живёт здесь.
 */

import { sql as drSql, type SQL } from 'drizzle-orm';

/**
 * Есть ли у документа непустая сверка: провалившаяся проверка (кроме
 * пропущенных) или подозрение.
 *
 * `jsonb_path_exists` вместо разворачивания массива: условие уходит в WHERE
 * подзапроса, и разворачивать там нечего.
 */
function validationHasSignal(alias: string): SQL {
  return drSql.raw(`(
      jsonb_path_exists(${alias}.validation, '$.checks[*] ? (@.ok == false && !exists(@.skipReason))')
      OR jsonb_array_length(COALESCE(${alias}.validation->'warnings', '[]'::jsonb)) > 0
    )`);
}

/** Как называются таблицы операции: у приёмок и отгрузок они симметричны. */
export type OperationTables = {
  /** `delivery_sources` / `shipment_sources` */
  sources: string;
  /** `delivery_items` / `shipment_items` */
  items: string;
  /** `delivery_photos` / `shipment_photos` */
  photos: string;
  /** `delivery_id` / `shipment_id` */
  fk: string;
  /** `delivery_photo_id` / `shipment_photo_id` в photo_recognized_items */
  photoFk: string;
};

export const DELIVERY_TABLES: OperationTables = {
  sources: 'delivery_sources',
  items: 'delivery_items',
  photos: 'delivery_photos',
  fk: 'delivery_id',
  photoFk: 'delivery_photo_id',
};

export const SHIPMENT_TABLES: OperationTables = {
  sources: 'shipment_sources',
  items: 'shipment_items',
  photos: 'shipment_photos',
  fk: 'shipment_id',
  photoFk: 'shipment_photo_id',
};

/**
 * Три источника сигнала, из которых складывается признак.
 *
 * Все три нужны, и вот почему:
 *  - СВЯЗАННЫЕ документы — основной случай;
 *  - документы в ПРОИСХОЖДЕНИИ позиций — отвязанный документ оставляет свои
 *    строки в операции, и карточка показывает их сводку;
 *  - сверка ФОТО — у 73 приёмок за месяц сигнал есть только здесь, документа к
 *    ним не привязано вовсе. Мониторинг этой сводкой уже пользуется: замечания
 *    по приёмкам 13318 и 13322 дословно повторяют её текст.
 *
 * @param idExpr SQL-выражение с id операции — `${deliveries.id}` или литерал.
 */
export function docAttentionExists(t: OperationTables, idExpr: SQL): SQL {
  return drSql`(
    EXISTS (
      SELECT 1 FROM ${drSql.raw(t.sources)} da_src
      JOIN source_documents da_sd ON da_sd.id = da_src.source_document_id
      WHERE da_src.${drSql.raw(t.fk)} = ${idExpr} AND ${validationHasSignal('da_sd')}
    )
    OR EXISTS (
      SELECT 1 FROM ${drSql.raw(t.items)} da_it
      JOIN source_documents da_sd2 ON da_sd2.id = da_it.source_document_id
      WHERE da_it.${drSql.raw(t.fk)} = ${idExpr} AND ${validationHasSignal('da_sd2')}
    )
    OR EXISTS (
      SELECT 1 FROM ${drSql.raw(t.photos)} da_ph
      JOIN photo_recognized_items da_pr ON da_pr.${drSql.raw(t.photoFk)} = da_ph.id
      WHERE da_ph.${drSql.raw(t.fk)} = ${idExpr} AND ${validationHasSignal('da_pr')}
    )
  )`;
}

/**
 * Операция закрыта — сигнал не показываем.
 *
 * Сигнал нужен там, где ошибку ещё можно исправить: от разбора документа до
 * «Подтвердить МОЛ» проходит в медиане 142 минуты, и это всё окно. У закрытой
 * операции правка невозможна, а пометка на ней превратила бы историю в стену
 * сигналов — на момент выката это 433 закрытые приёмки против 4 живых.
 */
export function operationIsClosed(statusIdExpr: SQL): SQL {
  return drSql`EXISTS (
    SELECT 1 FROM statuses da_st
    WHERE da_st.id = ${statusIdExpr} AND da_st.code = 'confirmed_mol'
  )`;
}

/** Готовое выражение для колонки DTO: признак с учётом закрытости операции. */
export function docAttentionColumn(t: OperationTables, idExpr: SQL, statusIdExpr: SQL): SQL<boolean> {
  return drSql<boolean>`(NOT ${operationIsClosed(statusIdExpr)} AND ${docAttentionExists(t, idExpr)})`;
}
