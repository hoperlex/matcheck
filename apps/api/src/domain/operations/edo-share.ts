/**
 * Одна УПД из ЭДО — несколько приёмок одного объекта: поставщик выписал одну
 * УПД, а материал везли несколько машин.
 *
 * Три вещи:
 *   - подсказка — к каким ещё приёмкам объекта, вероятно, относится УПД
 *     (`findShareCandidates`). Сверка та же, что у подбора к приёмке
 *     (edo-match.ts), только в обратную сторону: УПД против эталонов каждой
 *     приёмки. Связь не создаётся — выбор за менеджером;
 *   - групповая привязка одной транзакцией (`linkEdoDocumentToDeliveries`);
 *   - факт других приёмок с той же УПД — для строки «Факт по всем»
 *     (`sharedEdoFacts`). Строки УПД между машинами не делятся.
 *
 * Межобъектный запрет тот же, что у одиночной привязки (`foreign_site`).
 */
import { and, asc, eq, inArray, isNotNull, isNull, or, sql as drSql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import {
  counterparties,
  deliveries,
  deliveryEdoMatches,
  deliveryItems,
  deliverySources,
  edoExportDocuments,
  sourceDocuments,
  suppliers,
} from '../../db/schema.js';
import {
  edoDocGroup,
  edoGroupHasImported,
  edoGroupLinkedDeliveries,
  edoGroupLinks,
  lockEdoDocGroup,
  type EdoDocGroup,
} from '../edo/export-twins.js';
import { numberCoreSql, numberFullSql } from './edo-candidates.js';
import {
  compareMatches,
  documentNumberCore,
  normalizeDocumentNumber,
  rankEdoAgainstReferences,
  validInns,
  type MatchDocument,
  type MatchLevel,
} from './edo-match.js';
import { isoDate, loadReferencesForDeliveries, mskDate } from './edo-references.js';

type Exec = Pick<Db, 'execute' | 'select' | 'insert'>;

export type EdoDocRef = { source: 'import' | 'export'; id: string };

/** Приёмка для показа: id и номер. */
export type DeliveryRef = { deliveryId: string; displayId: number };

/** Сколько целей в одной групповой привязке. */
export const SHARE_MAX_TARGETS = 50;
/** Сколько строк подсказки отдаём; остальное — признаком `truncated`. */
export const SHARE_MAX_ROWS = 60;
/** Сколько приёмок «без документа» рядом по времени. */
const NO_DOCUMENT_LIMIT = 30;
/** Сколько приёмок ищет ручной поиск. */
const SEARCH_LIMIT = 30;
/** Сколько соседних приёмок показываем у одной общей УПД. */
export const SHARED_MAX_DELIVERIES = 50;

function uuidArray(values: readonly string[]): SQL {
  return values.length
    ? drSql`ARRAY[${drSql.join(
        values.map((v) => drSql`${v}`),
        drSql`, `,
      )}]::uuid[]`
    : drSql`ARRAY[]::uuid[]`;
}

function textArray(values: readonly string[]): SQL {
  return values.length
    ? drSql`ARRAY[${drSql.join(
        values.map((v) => drSql`${v}`),
        drSql`, `,
      )}]::text[]`
    : drSql`ARRAY[]::text[]`;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function groupStart(ref: EdoDocRef): { exportIds?: string[]; sourceIds?: string[] } {
  return ref.source === 'import' ? { sourceIds: [ref.id] } : { exportIds: [ref.id] };
}

/**
 * Документ приёмки должен быть связан с ней сейчас: в блок отвязанного
 * документа «+ Материал» тоже не добавляет. Вызывать под блокировкой строки
 * приёмки — её же берёт unlink-source до удаления связи.
 */
export async function sectionLinked(
  db: Pick<Db, 'select'>,
  deliveryId: string,
  sectionDocumentId: string,
): Promise<boolean> {
  const [link] = await db
    .select({ id: deliverySources.sourceDocumentId })
    .from(deliverySources)
    .where(
      and(
        eq(deliverySources.deliveryId, deliveryId),
        eq(deliverySources.sourceDocumentId, sectionDocumentId),
      ),
    )
    .limit(1);
  return !!link;
}

/**
 * Строка УПД, которую можно привязать, — под блокировкой. Импорт: разобранная
 * входящая карточка Диадока; реестр: сохранённый файл с материалами или
 * неопределённым содержимым. Общая проверка одиночной и групповой привязки.
 */
export async function lockLinkableEdoDocument(
  tx: Pick<Db, 'select'>,
  ref: EdoDocRef,
): Promise<boolean> {
  if (ref.source === 'import') {
    const [document] = await tx
      .select({ id: sourceDocuments.id })
      .from(sourceDocuments)
      .where(
        and(
          eq(sourceDocuments.id, ref.id),
          eq(sourceDocuments.kind, 'upd'),
          eq(sourceDocuments.direction, 'inbound'),
          eq(sourceDocuments.origin, 'edo_diadoc'),
          eq(sourceDocuments.status, 'parsed'),
          eq(sourceDocuments.isTechnical, false),
        ),
      )
      .for('update')
      .limit(1);
    return !!document;
  }
  const [document] = await tx
    .select({ id: edoExportDocuments.id })
    .from(edoExportDocuments)
    .where(
      and(
        eq(edoExportDocuments.id, ref.id),
        eq(edoExportDocuments.status, 'stored'),
        isNotNull(edoExportDocuments.s3Key),
        or(
          eq(edoExportDocuments.contentCategory, 'materials'),
          eq(edoExportDocuments.contentCategory, 'undetermined'),
          isNull(edoExportDocuments.contentCategory),
        ),
      ),
    )
    .for('update')
    .limit(1);
  return !!document;
}

// ---------------------------------------------------------------- подсказка

type EdoHeader = MatchDocument & { sellerInns: string[] };

/** Реквизиты УПД для сверки: те же поля, что у кандидата подбора. */
async function loadHeader(db: Db, ref: EdoDocRef): Promise<EdoHeader | null> {
  if (ref.source === 'export') {
    const [row] = await db
      .select({
        docNumber: edoExportDocuments.documentNumber,
        docDate: edoExportDocuments.documentDate,
        supplierInn: edoExportDocuments.supplierInn,
        sellerInns: edoExportDocuments.sellerInns,
        supplierName: edoExportDocuments.supplierName,
        totalSum: edoExportDocuments.totalSum,
      })
      .from(edoExportDocuments)
      .where(eq(edoExportDocuments.id, ref.id))
      .limit(1);
    if (!row) return null;
    const sellerInns = row.sellerInns ?? [];
    return { ...row, docDate: isoDate(row.docDate), sellerInns, supplierInns: sellerInns };
  }
  const directory = alias(suppliers, 'share_directory');
  const supplier = alias(counterparties, 'share_supplier');
  const [row] = await db
    .select({
      docNumber: sourceDocuments.docNumber,
      docDate: sourceDocuments.docDate,
      supplierName: drSql<string | null>`coalesce(${directory.name}, ${supplier.name})`,
      supplierInn: drSql<
        string | null
      >`coalesce(nullif(${sourceDocuments.supplierInnRaw}, ''), nullif(${directory.inn}, ''), nullif(${supplier.inn}, ''))`,
      totalSum: sourceDocuments.totalSum,
    })
    .from(sourceDocuments)
    .leftJoin(directory, eq(sourceDocuments.supplierDirectoryId, directory.id))
    .leftJoin(supplier, eq(sourceDocuments.supplierId, supplier.id))
    .where(and(eq(sourceDocuments.id, ref.id), eq(sourceDocuments.origin, 'edo_diadoc')))
    .limit(1);
  if (!row) return null;
  return { ...row, docDate: isoDate(row.docDate), sellerInns: [] };
}

export type ShareReason = 'match' | 'no_document' | 'selected' | 'search';

export type ShareCandidate = DeliveryRef & {
  arrivedAt: string | null;
  vehiclePlate: string | null;
  supplierName: string | null;
  /** Документы приёмки — варианты блока материалов. */
  documents: { id: string; kind: string; docNumber: string | null; docDate: string | null }[];
  /** Номера документов, распознанные на фото (без бумажной карточки). */
  photoNumbers: string[];
  /** Другие УПД из ЭДО, уже привязанные к этой приёмке. */
  otherEdo: { docNumber: string | null }[];
  /** 'linked' — УПД (любой её копией) уже стоит в этой приёмке. */
  state: 'linked' | 'available';
  reasons: ShareReason[];
  level: MatchLevel;
  score: number;
  matches: string[];
  conflicts: string[];
  otherSupplier: boolean;
  /** Документ приёмки с тем же полным номером, если он ровно один. Иначе — приёмка целиком. */
  defaultSectionId: string | null;
};

export type ShareCandidatesResult = {
  document: {
    docNumber: string | null;
    docDate: string | null;
    supplierName: string | null;
    supplierInn: string | null;
    totalSum: string | null;
  };
  siteId: string;
  items: ShareCandidate[];
  truncated: boolean;
};

/** Дата приезда по Москве; у приёмки без приезда — дата создания. */
const ARRIVED_DATE_SQL = drSql.raw(
  `(coalesce(d.arrived_at, d.created_at) at time zone 'Europe/Moscow')::date`,
);

/**
 * Приёмки объекта `anchorId`, к которым, вероятно, относится УПД.
 *
 * Отбор (объединение): тот же номер или поставщик — приезд в [дата УПД − 2;
 * +30]; без документа — [−1; +7], ближайшие ко времени якоря; отмеченные в
 * списке (`include`) и найденные поиском (`q`) — без окна; приёмки, где УПД уже
 * стоит, — всегда (серыми). Помеченные на удаление и созданные из отгрузки не
 * попадают никогда: к ним не привязывает и одиночная кнопка.
 */
export async function findShareCandidates(
  db: Db,
  anchorId: string,
  ref: EdoDocRef,
  opts: { q?: string; include?: readonly string[] } = {},
): Promise<ShareCandidatesResult | 'delivery_not_found' | 'document_not_found'> {
  const [anchor] = await db
    .select({
      siteId: deliveries.siteId,
      arrivedAt: deliveries.arrivedAt,
      createdAt: deliveries.createdAt,
    })
    .from(deliveries)
    .where(eq(deliveries.id, anchorId))
    .limit(1);
  if (!anchor) return 'delivery_not_found';
  const header = await loadHeader(db, ref);
  if (!header) return 'document_not_found';

  const group = await edoDocGroup(db, groupStart(ref));
  const linkedAll = await edoGroupLinkedDeliveries(db, group);
  const linked = new Set(linkedAll.map((link) => link.deliveryId));

  const anchorTime = (anchor.arrivedAt ?? anchor.createdAt).toISOString();
  const base = header.docDate ?? mskDate(anchor.arrivedAt) ?? mskDate(anchor.createdAt)!;
  const full = normalizeDocumentNumber(header.docNumber);
  const core = documentNumberCore(header.docNumber);
  const inns = validInns([header.supplierInn, ...header.sellerInns]).inns;
  const sameSite = drSql`d.site_id = ${anchor.siteId} and d.pending_deletion_at is null and d.source_shipment_id is null`;

  const numberHit = (column: SQL) =>
    drSql`(${full ? drSql`${numberFullSql(column)} = ${full}` : drSql`false`} or ${core ? drSql`${numberCoreSql(column)} = ${core}` : drSql`false`})`;
  const innList = textArray(inns);
  const matchRows =
    full || core || inns.length
      ? await db.execute<{ id: string }>(drSql`
          select d.id from deliveries d
           where ${sameSite}
             and ${ARRIVED_DATE_SQL} >= ${shiftDate(base, -2)}::date
             and ${ARRIVED_DATE_SQL} < ${shiftDate(base, 31)}::date
             and (
               exists (
                 select 1 from delivery_sources ds
                   join source_documents sd on sd.id = ds.source_document_id
                   left join suppliers sdir on sdir.id = sd.supplier_directory_id
                   left join counterparties scp on scp.id = sd.supplier_id
                  where ds.delivery_id = d.id
                    and (${numberHit(drSql.raw('sd.doc_number'))}
                      or sd.supplier_inn_raw = any(${innList}) or sdir.inn = any(${innList}) or scp.inn = any(${innList})))
               or exists (
                 select 1 from delivery_photos p
                   join photo_recognized_items pri on pri.delivery_photo_id = p.id
                  where p.delivery_id = d.id and pri.doc_number is not null
                    and ${numberHit(drSql.raw('pri.doc_number'))})
               or exists (select 1 from counterparties c where c.id = d.supplier_id and c.inn = any(${innList}))
             )
           limit 200`)
      : [];

  const noDocumentRows = await db.execute<{ id: string }>(drSql`
    select d.id from deliveries d
     where ${sameSite}
       and ${ARRIVED_DATE_SQL} >= ${shiftDate(base, -1)}::date
       and ${ARRIVED_DATE_SQL} < ${shiftDate(base, 8)}::date
       and not exists (select 1 from delivery_sources ds where ds.delivery_id = d.id)
       and not exists (
         select 1 from delivery_photos p join photo_recognized_items pri on pri.delivery_photo_id = p.id
          where p.delivery_id = d.id and pri.doc_number is not null)
     order by abs(extract(epoch from (coalesce(d.arrived_at, d.created_at) - ${anchorTime}::timestamptz)))
     limit ${NO_DOCUMENT_LIMIT}`);

  const include = [...new Set(opts.include ?? [])];
  const includeRows = include.length
    ? await db.execute<{ id: string }>(drSql`
        select d.id from deliveries d where d.id = any(${uuidArray(include)}) and ${sameSite}`)
    : [];

  const q = (opts.q ?? '').trim();
  let searchRows: { id: string }[] = [];
  if (q.length >= 2) {
    const plate = normalizeDocumentNumber(q);
    searchRows = await db.execute<{ id: string }>(drSql`
      select d.id from deliveries d
       where ${sameSite}
         and (${/^\d+$/.test(q) && q.length <= 12 ? drSql`d.display_id = ${Number(q)}` : drSql`false`}
           or ${plate ? drSql`${numberFullSql(drSql.raw('d.vehicle_plate'))} like ${`%${plate}%`}` : drSql`false`})
       order by d.display_id desc
       limit ${SEARCH_LIMIT}`);
  }

  const linkedHereRows = linkedAll
    .filter((link) => link.siteId === anchor.siteId)
    .map((link) => link.deliveryId);

  const reasons = new Map<string, Set<ShareReason>>();
  const mark = (ids: readonly string[], reason: ShareReason | null) => {
    for (const id of ids) {
      const set = reasons.get(id) ?? new Set<ShareReason>();
      if (reason) set.add(reason);
      reasons.set(id, set);
    }
  };
  mark(
    matchRows.map((r) => r.id),
    'match',
  );
  mark(
    noDocumentRows.map((r) => r.id),
    'no_document',
  );
  mark(
    includeRows.map((r) => r.id),
    'selected',
  );
  mark(
    searchRows.map((r) => r.id),
    'search',
  );
  mark(linkedHereRows, null);
  const ids = [...reasons.keys()];
  if (!ids.length) {
    return { document: headerView(header), siteId: anchor.siteId, items: [], truncated: false };
  }

  const references = await loadReferencesForDeliveries(db, ids);
  const details = await loadDetails(db, ids, group);

  const anchorMs = Date.parse(anchorTime);
  const rows: (ShareCandidate & { distance: number })[] = [];
  for (const id of ids) {
    const loaded = references.get(id);
    const detail = details.get(id);
    if (!loaded || !detail) continue;
    const match = rankEdoAgainstReferences(loaded.references, header);
    const why = [...(reasons.get(id) ?? [])];
    const state = linked.has(id) ? 'linked' : 'available';
    // Чужой поставщик, совпавший лишь цифрами номера, — как свёрнутый блок
    // окна подбора: без явного выбора человека в подсказке его нет.
    const stranger = match.otherSupplier && match.level === 'weak';
    if (stranger && state === 'available' && !why.includes('selected') && !why.includes('search'))
      continue;
    rows.push({
      ...detail,
      state,
      reasons: why,
      level: match.level,
      score: match.score,
      matches: match.matches,
      conflicts: match.conflicts,
      otherSupplier: match.otherSupplier,
      defaultSectionId: defaultSection(detail.documents, header.docNumber, ref),
      distance: Math.abs((detail.arrivedAt ? Date.parse(detail.arrivedAt) : anchorMs) - anchorMs),
    });
  }

  const rank = (row: (typeof rows)[number]) =>
    row.state === 'linked'
      ? 3
      : row.reasons.includes('match') || row.reasons.includes('selected')
        ? 0
        : row.reasons.includes('search')
          ? 1
          : 2;
  rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? compareMatches(a, b) : 0) ||
      a.distance - b.distance ||
      b.displayId - a.displayId,
  );
  return {
    document: headerView(header),
    siteId: anchor.siteId,
    items: rows.slice(0, SHARE_MAX_ROWS).map(({ distance: _distance, ...row }) => row),
    truncated: rows.length > SHARE_MAX_ROWS,
  };
}

function headerView(header: EdoHeader): ShareCandidatesResult['document'] {
  return {
    docNumber: header.docNumber,
    docDate: header.docDate,
    supplierName: header.supplierName,
    supplierInn: header.supplierInn,
    totalSum: header.totalSum,
  };
}

/** Блок по умолчанию: документ приёмки с тем же полным номером, ровно один. */
function defaultSection(
  documents: ShareCandidate['documents'],
  docNumber: string | null,
  ref: EdoDocRef,
): string | null {
  const full = normalizeDocumentNumber(docNumber);
  if (!full) return null;
  const same = documents.filter(
    (doc) =>
      normalizeDocumentNumber(doc.docNumber) === full &&
      !(ref.source === 'import' && doc.id === ref.id),
  );
  return same.length === 1 ? same[0]!.id : null;
}

type Detail = Omit<
  ShareCandidate,
  | 'state'
  | 'reasons'
  | 'level'
  | 'score'
  | 'matches'
  | 'conflicts'
  | 'otherSupplier'
  | 'defaultSectionId'
>;

/** Что показать о приёмке в строке подсказки. */
async function loadDetails(
  db: Db,
  ids: readonly string[],
  group: EdoDocGroup,
): Promise<Map<string, Detail>> {
  const supplier = alias(counterparties, 'share_delivery_supplier');
  const heads = await db
    .select({
      id: deliveries.id,
      displayId: deliveries.displayId,
      arrivedAt: deliveries.arrivedAt,
      vehiclePlate: deliveries.vehiclePlate,
      supplierName: supplier.name,
    })
    .from(deliveries)
    .leftJoin(supplier, eq(supplier.id, deliveries.supplierId))
    .where(inArray(deliveries.id, [...ids]));

  const directory = alias(suppliers, 'share_doc_directory');
  const docSupplier = alias(counterparties, 'share_doc_supplier');
  const documents = await db
    .select({
      deliveryId: deliverySources.deliveryId,
      id: sourceDocuments.id,
      kind: sourceDocuments.kind,
      docNumber: sourceDocuments.docNumber,
      docDate: sourceDocuments.docDate,
      supplierName: drSql<string | null>`coalesce(${directory.name}, ${docSupplier.name})`,
    })
    .from(deliverySources)
    .innerJoin(sourceDocuments, eq(sourceDocuments.id, deliverySources.sourceDocumentId))
    .leftJoin(directory, eq(directory.id, sourceDocuments.supplierDirectoryId))
    .leftJoin(docSupplier, eq(docSupplier.id, sourceDocuments.supplierId))
    .where(inArray(deliverySources.deliveryId, [...ids]))
    .orderBy(asc(sourceDocuments.docNumber));

  const photos = await db.execute<{ delivery_id: string; doc_number: string }>(drSql`
    select distinct p.delivery_id, pri.doc_number
      from delivery_photos p join photo_recognized_items pri on pri.delivery_photo_id = p.id
     where p.delivery_id = any(${uuidArray(ids)}) and pri.doc_number is not null
     order by pri.doc_number`);

  // Другие УПД этой приёмки — не копии той же (группа исключена).
  const otherEdo = await db.execute<{ delivery_id: string; doc_number: string | null }>(drSql`
    select dem.delivery_id, coalesce(e.document_number, sd.doc_number) as doc_number
      from delivery_edo_matches dem
      left join edo_export_documents e on e.id = dem.export_document_id
      left join source_documents sd on sd.id = dem.source_document_id
     where dem.delivery_id = any(${uuidArray(ids)})
       and not (dem.export_document_id = any(${uuidArray(group.exportIds)})
             or dem.source_document_id = any(${uuidArray(group.sourceIds)}))
     order by dem.linked_at`);

  const result = new Map<string, Detail>();
  for (const head of heads) {
    const own = documents.filter((doc) => doc.deliveryId === head.id);
    result.set(head.id, {
      deliveryId: head.id,
      displayId: head.displayId,
      arrivedAt: head.arrivedAt?.toISOString() ?? null,
      vehiclePlate: head.vehiclePlate,
      // Как в списке приёмок: поставщик приёмки, иначе — из её документа.
      supplierName: head.supplierName ?? own.find((doc) => doc.supplierName)?.supplierName ?? null,
      documents: own.map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        docNumber: doc.docNumber,
        docDate: isoDate(doc.docDate),
      })),
      photoNumbers: photos.filter((p) => p.delivery_id === head.id).map((p) => p.doc_number),
      otherEdo: otherEdo
        .filter((e) => e.delivery_id === head.id)
        .map((e) => ({ docNumber: e.doc_number })),
    });
  }
  return result;
}

// ------------------------------------------------------- групповая привязка

export type BatchTarget = { deliveryId: string; sectionDocumentId: string | null };

export type BatchLinkError =
  | 'not_found'
  | 'other_site'
  | 'pending_deletion'
  | 'from_shipment'
  | 'invalid_document'
  | 'foreign_site'
  | 'imported_available'
  | 'section_not_linked'
  | 'invalid_section';

export type BatchLinkResult =
  | { status: 'ok'; siteId: string; linked: DeliveryRef[]; alreadyLinked: DeliveryRef[] }
  | { status: BatchLinkError; deliveries: DeliveryRef[] };

/**
 * Одна УПД — к нескольким приёмкам объекта якоря. Всё или ничего: при любом
 * отказе не создаётся ни одной связи. Цель, где УПД уже стоит (любой копией),
 * — не отказ, а «уже была».
 *
 * Порядок блокировок тот же, что у одиночной привязки: приёмки → ключи
 * тождества УПД → строка документа. Приёмки — одним запросом по возрастанию id:
 * две пачки с пересекающимися целями не ждут друг друга по кругу, а одиночный
 * путь берёт одну приёмку и ключи только после неё. Вызывать внутри транзакции.
 */
export async function linkEdoDocumentToDeliveries(
  tx: Exec,
  input: {
    anchorId: string;
    ref: EdoDocRef;
    targets: readonly BatchTarget[];
    userId: string | null;
  },
): Promise<BatchLinkResult> {
  const { anchorId, ref, targets } = input;
  const ids = [...new Set([anchorId, ...targets.map((t) => t.deliveryId)])].sort();
  const rows = await tx
    .select({
      id: deliveries.id,
      displayId: deliveries.displayId,
      siteId: deliveries.siteId,
      pendingDeletionAt: deliveries.pendingDeletionAt,
      sourceShipmentId: deliveries.sourceShipmentId,
    })
    .from(deliveries)
    .where(inArray(deliveries.id, ids))
    .orderBy(asc(deliveries.id))
    .for('update');
  const byId = new Map(rows.map((row) => [row.id, row]));
  const anchor = byId.get(anchorId);
  if (!anchor || targets.some((t) => !byId.has(t.deliveryId)))
    return { status: 'not_found', deliveries: [] };
  const targetRows = targets.map((t) => byId.get(t.deliveryId)!);
  const refOf = (row: (typeof rows)[number]): DeliveryRef => ({
    deliveryId: row.id,
    displayId: row.displayId,
  });
  const failing = (predicate: (row: (typeof rows)[number]) => boolean) =>
    targetRows.filter(predicate).map(refOf);

  const otherSite = failing((row) => row.siteId !== anchor.siteId);
  if (otherSite.length) return { status: 'other_site', deliveries: otherSite };
  const pending = failing((row) => row.pendingDeletionAt !== null);
  if (pending.length) return { status: 'pending_deletion', deliveries: pending };
  const fromShipment = failing((row) => row.sourceShipmentId !== null);
  if (fromShipment.length) return { status: 'from_shipment', deliveries: fromShipment };

  const group = await lockEdoDocGroup(tx, groupStart(ref));
  if (!(await lockLinkableEdoDocument(tx, ref)))
    return { status: 'invalid_document', deliveries: [] };

  const links = await edoGroupLinks(tx, group, { id: null, siteId: anchor.siteId });
  const linkedAll = await edoGroupLinkedDeliveries(tx, group);
  if (links.foreignSite) {
    const elsewhere = linkedAll
      .filter((link) => link.siteId !== anchor.siteId)
      .map((link) => link.deliveryId);
    const shown = elsewhere.length
      ? await tx
          .select({ deliveryId: deliveries.id, displayId: deliveries.displayId })
          .from(deliveries)
          .where(inArray(deliveries.id, elsewhere))
          .orderBy(asc(deliveries.displayId))
      : [];
    return { status: 'foreign_site', deliveries: shown };
  }
  if (ref.source === 'export' && (await edoGroupHasImported(tx, group))) {
    return { status: 'imported_available', deliveries: [] };
  }

  const invalidSection: DeliveryRef[] = [];
  const sectionMissing: DeliveryRef[] = [];
  for (const target of targets) {
    if (!target.sectionDocumentId) continue;
    const row = byId.get(target.deliveryId)!;
    if (ref.source === 'import' && target.sectionDocumentId === ref.id)
      invalidSection.push(refOf(row));
    else if (!(await sectionLinked(tx, target.deliveryId, target.sectionDocumentId)))
      sectionMissing.push(refOf(row));
  }
  if (sectionMissing.length) return { status: 'section_not_linked', deliveries: sectionMissing };
  if (invalidSection.length) return { status: 'invalid_section', deliveries: invalidSection };

  const already = new Set(linkedAll.map((link) => link.deliveryId));
  const toInsert = targets.filter((t) => !already.has(t.deliveryId));
  const inserted = toInsert.length
    ? await tx
        .insert(deliveryEdoMatches)
        .values(
          toInsert.map((t) => ({
            deliveryId: t.deliveryId,
            sourceDocumentId: ref.source === 'import' ? ref.id : null,
            exportDocumentId: ref.source === 'import' ? null : ref.id,
            sectionDocumentId: t.sectionDocumentId,
            linkedByUserId: input.userId,
          })),
        )
        .onConflictDoNothing()
        .returning({ deliveryId: deliveryEdoMatches.deliveryId })
    : [];
  const insertedIds = new Set(inserted.map((row) => row.deliveryId));
  const byDisplay = (a: DeliveryRef, b: DeliveryRef) => a.displayId - b.displayId;
  return {
    status: 'ok',
    siteId: anchor.siteId,
    linked: targetRows
      .filter((row) => insertedIds.has(row.id))
      .map(refOf)
      .sort(byDisplay),
    alreadyLinked: targetRows
      .filter((row) => !insertedIds.has(row.id))
      .map(refOf)
      .sort(byDisplay),
  };
}

// ------------------------------------------------------- факт других приёмок

export type SharedFactRow = {
  qtyActual: string | null;
  qtyPlanned: string | null;
  price: string | null;
  vatRate: string | null;
  vatSum: string | null;
};

export type SharedEdoFacts = {
  matchId: string;
  /** Сколько других приёмок (без помеченных на удаление). */
  count: number;
  deliveries: (DeliveryRef & {
    arrivedAt: string | null;
    /** 'section' — позиции блока документа; 'delivery' — все позиции приёмки. */
    scope: 'section' | 'delivery';
    /** В той же области у соседа есть другая УПД из ЭДО — её факт в сумме тоже. */
    otherEdoInScope: boolean;
    rows: SharedFactRow[];
  })[];
};

/**
 * Для каждой привязки приёмки — та же УПД (любой копией) в других приёмках и
 * их факт по области связи: блок документа или вся приёмка. Привязки, которых
 * больше нигде нет, в ответ не попадают. Помеченные на удаление соседи не
 * считаются: их факт в «Факт по всем» вошёл бы как живой.
 */
export async function sharedEdoFacts(db: Db, deliveryId: string): Promise<SharedEdoFacts[]> {
  const matches = await db
    .select({
      id: deliveryEdoMatches.id,
      sourceDocumentId: deliveryEdoMatches.sourceDocumentId,
      exportDocumentId: deliveryEdoMatches.exportDocumentId,
    })
    .from(deliveryEdoMatches)
    .where(eq(deliveryEdoMatches.deliveryId, deliveryId))
    .orderBy(asc(deliveryEdoMatches.linkedAt));

  const result: SharedEdoFacts[] = [];
  for (const match of matches) {
    const group = await edoDocGroup(
      db,
      match.exportDocumentId
        ? { exportIds: [match.exportDocumentId] }
        : { sourceIds: [match.sourceDocumentId!] },
    );
    const exp = uuidArray(group.exportIds);
    const src = uuidArray(group.sourceIds);
    // Область связи: блок (или сама карточка как документ приёмки) — его id;
    // связь с приёмкой целиком — null. Две связи одной приёмки сводятся к
    // одной: блок точнее приёмки целиком.
    const links = await db.execute<{
      delivery_id: string;
      display_id: string | number;
      arrived_at: Date | string | null;
      scope_doc: string | null;
    }>(drSql`
      with links as (
        select dem.delivery_id, dem.section_document_id as scope_doc
          from delivery_edo_matches dem
         where dem.export_document_id = any(${exp}) or dem.source_document_id = any(${src})
        union
        select ds.delivery_id, ds.source_document_id
          from delivery_sources ds where ds.source_document_id = any(${src})
      )
      select distinct on (d.display_id) d.id as delivery_id, d.display_id, d.arrived_at, l.scope_doc
        from links l join deliveries d on d.id = l.delivery_id
       where d.id <> ${deliveryId} and d.pending_deletion_at is null
       order by d.display_id, l.scope_doc nulls last`);
    if (!links.length) continue;
    const shown = links.slice(0, SHARED_MAX_DELIVERIES);
    const ids = shown.map((link) => link.delivery_id);

    const items = await db
      .select({
        deliveryId: deliveryItems.deliveryId,
        sourceDocumentId: deliveryItems.sourceDocumentId,
        qtyActual: deliveryItems.qtyActual,
        qtyPlanned: deliveryItems.qtyPlanned,
        price: deliveryItems.price,
        vatRate: deliveryItems.vatRate,
        vatSum: deliveryItems.vatSum,
      })
      .from(deliveryItems)
      .where(inArray(deliveryItems.deliveryId, ids));

    // Другие УПД в той же области соседа, документ — не из этой группы. У блока
    // — привязанные к тому же блоку; у связи «целиком» — любые: её факт — все
    // позиции приёмки, в том числе блоков других УПД.
    const others = await db.execute<{
      delivery_id: string;
      section_document_id: string | null;
    }>(drSql`
      select dem.delivery_id, dem.section_document_id
        from delivery_edo_matches dem
       where dem.delivery_id = any(${uuidArray(ids)})
         and not (dem.export_document_id = any(${exp}) or dem.source_document_id = any(${src}))`);

    result.push({
      matchId: match.id,
      count: links.length,
      deliveries: shown.map((link) => {
        const scopeDoc = link.scope_doc;
        const own = items.filter(
          (item) =>
            item.deliveryId === link.delivery_id &&
            (scopeDoc === null || item.sourceDocumentId === scopeDoc),
        );
        return {
          deliveryId: link.delivery_id,
          displayId: Number(link.display_id),
          arrivedAt: link.arrived_at ? new Date(link.arrived_at).toISOString() : null,
          scope: scopeDoc === null ? ('delivery' as const) : ('section' as const),
          otherEdoInScope: others.some(
            (other) =>
              other.delivery_id === link.delivery_id &&
              (scopeDoc === null || other.section_document_id === scopeDoc),
          ),
          rows: own.map(({ deliveryId: _d, sourceDocumentId: _s, ...row }) => row),
        };
      }),
    });
  }
  return result;
}
