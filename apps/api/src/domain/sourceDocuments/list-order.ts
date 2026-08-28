import { type SQL, desc, sql as drSql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { sourceDocuments } from '../../db/schema.js';

/**
 * Порядок выдачи документов — ОДИН для списка и для выгрузки Excel.
 *
 * Условия отбора уже собраны в одном месте (см. list-filters.ts), а порядок
 * оставался в двух: список умел сортировать по колонке, выгрузка всегда шла по
 * `parsed_at desc`. Файл при этом обязан повторять экран — иначе менеджер
 * сортирует по сумме, скачивает и получает другой документ первым.
 *
 * Поля совпадают с колонками таблицы «Документы».
 */
export const SOURCE_DOCUMENT_SORT_FIELDS = [
  'kind',
  'status',
  'docNumber',
  'docDate',
  'expectedDate',
  'siteName',
  'contractorName',
  'buyerName',
  'consigneeName',
  'supplierName',
  'vatSum',
  'totalSum',
] as const;

export type SourceDocumentSortField = (typeof SOURCE_DOCUMENT_SORT_FIELDS)[number];

/**
 * Имена сторон живут в присоединённых таблицах, и алиасы у списка и выгрузки
 * свои. Поэтому сортировочные выражения строятся не от глобальных таблиц, а от
 * переданных колонок — по одному набору правил.
 */
export type SortAliasColumns = {
  siteName: PgColumn | SQL;
  supplierName: SQL;
  contractorName: PgColumn | SQL;
  buyerName: SQL;
  consigneeName: SQL;
};

/**
 * Приоритеты для «смысловых» колонок: по типу — УПД первыми, по статусу —
 * активные выше архива. Сортировать их по алфавиту значения бессмысленно.
 */
const kindPriority = drSql`case ${sourceDocuments.kind} when 'upd' then 0 when 'request' then 1 when 'transport_waybill' then 2 when 'os2_transfer' then 3 else 4 end`;
const statusPriority = drSql`case ${sourceDocuments.status} when 'processing' then 0 when 'queued' then 1 when 'needs_resolution' then 2 when 'parse_failed' then 3 when 'parsed' then 4 when 'archived' then 5 else 6 end`;

export function sourceDocumentSortExpr(
  sort: SourceDocumentSortField,
  aliases: SortAliasColumns,
): SQL {
  switch (sort) {
    case 'kind':
      return kindPriority;
    case 'status':
      return statusPriority;
    case 'docNumber':
      return drSql`${sourceDocuments.docNumber}`;
    case 'docDate':
      return drSql`${sourceDocuments.docDate}`;
    case 'expectedDate':
      return drSql`${sourceDocuments.expectedDate}`;
    case 'siteName':
      return drSql`${aliases.siteName}`;
    case 'contractorName':
      return drSql`${aliases.contractorName}`;
    case 'buyerName':
      return aliases.buyerName;
    case 'consigneeName':
      return aliases.consigneeName;
    case 'supplierName':
      return aliases.supplierName;
    case 'vatSum':
      return drSql`${sourceDocuments.vatSum}`;
    case 'totalSum':
      return drSql`${sourceDocuments.totalSum}`;
  }
}

/**
 * Готовый `orderBy`. Без `sort` — прежний порядок «сначала свежеразобранные».
 *
 * `nulls last` в обе стороны: документ без суммы не должен возглавлять список
 * ни при возрастании, ни при убывании. Хвостовой `id` — детерминизм: без него
 * строки с одинаковым значением меняются местами между страницами, и одна и та
 * же запись показывается дважды или пропадает.
 */
export function buildSourceDocumentOrderBy(
  sort: SourceDocumentSortField | undefined,
  order: 'asc' | 'desc' | undefined,
  aliases: SortAliasColumns,
): SQL[] {
  if (!sort) return [desc(sourceDocuments.parsedAt), desc(sourceDocuments.id)];
  const dirNulls = drSql.raw(order === 'asc' ? 'asc nulls last' : 'desc nulls last');
  return [drSql`${sourceDocumentSortExpr(sort, aliases)} ${dirNulls}`, desc(sourceDocuments.id)];
}
