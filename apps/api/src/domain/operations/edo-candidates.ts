/**
 * Подбор УПД из ЭДО к приёмке. Только чтение: связь создаёт менеджер.
 *
 * Эталоны — бумажные УПД приёмки и распознанные фото её документов. Поиск
 * идёт отдельными запросами по сильным ключам (номер, ИНН, название), у
 * каждого своя квота и признак усечения: общий `LIMIT` по окну дат отсекал
 * нужную УПД, когда в окне оказывалось больше документов, чем влезало в лимит.
 * Ручной поиск идёт без окна дат и без этих квот.
 *
 * Один и тот же код зовут маршрут, интеграционный тест и бэктест.
 */
import {
  and,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql as drSql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import {
  counterparties,
  deliveries,
  deliveryPhotos,
  deliverySources,
  edoAccounts,
  edoExportDocuments,
  photoRecognizedItems,
  sourceDocuments,
  suppliers,
} from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import { escapeLike } from '../../lib/like.js';
import { edoDocumentUsage, edoUsageKey, type EdoUsage } from './edo-usage.js';
import {
  censusForSupplier,
  exportRegistryStatus,
  type CensusMatch,
  type RegistryAccountState,
} from '../jobs/edo-export-runner.js';
import {
  compareMatches,
  daysBetween,
  documentNumberCore,
  normalizeDocumentNumber,
  normalizeSupplierName,
  rankEdoAgainstReferences,
  supplierNameTokens,
  validInns,
  type DocumentMatch,
  type MatchLevel,
  type MatchReference,
  type ReferenceOrigin,
} from './edo-match.js';

export type CandidateSource = 'import' | 'export';
/** Каким запросом найден кандидат — для отчёта бэктеста и для отладки. */
export type FoundBy = 'number' | 'inn' | 'name' | 'date' | 'search';

export type EdoCandidate = {
  id: string;
  source: CandidateSource;
  contentCategory: string | null;
  docNumber: string | null;
  docDate: string | null;
  supplierName: string | null;
  supplierInn: string | null;
  totalSum: string | null;
  siteId: string | null;
  /** В скольких других приёмках уже стоит эта УПД (любым представлением). */
  usedElsewhere: number;
  /** Номера этих приёмок, первые `USAGE_SHOWN`. */
  usedIn: EdoUsage['deliveries'];
  foundBy: FoundBy[];
  reference: { origin: ReferenceOrigin; label: string | null };
  score: number;
  level: MatchLevel;
  matches: string[];
  conflicts: string[];
  missing: string[];
  otherSupplier: DocumentMatch['otherSupplier'];
  supplierCheck: DocumentMatch['supplierCheck'];
};

export type EdoCandidatesResult = {
  items: EdoCandidate[];
  /** Чего не хватает у самой приёмки для точной сверки. */
  referenceMissing: string[];
  /** Какие запросы упёрлись в квоту: показаны не все найденные. */
  truncated: FoundBy[];
  diagnostics: {
    /** Самое позднее время получения УПД, сохранённой в реестре. Не дата завершённого обхода. */
    registryReceivedUntil: string | null;
    /**
     * На какой момент реестр полон: последняя полная проверка ленты (по худшей
     * из учёток), а пока проверок не было — время последней полученной УПД.
     */
    registryAsOf: { at: string; basis: 'checked' | 'received' } | null;
    /**
     * Эталоны, датированные позже дня `registryAsOf` (по Москве). Их УПД,
     * скорее всего, ещё не выгружена — но не наверняка: дата эталона могла быть
     * прочитана с ошибкой, а УПД — прийти раньше своей даты.
     */
    referencesAfterRegistry: { label: string | null; date: string }[];
    /** Состояние автообновления по каждой активной учётке. */
    registry: RegistryAccountState[];
    /** Сканы, счета-фактуры и накладные поставщика из переписи — их выгрузка не берёт. */
    census: CensusMatch | null;
    /** Проверенные ИНН эталонов, по которым в реестре нет ни одной УПД. */
    innsAbsentInRegistry: string[];
    /** ИНН у документов приёмки есть, но ни один не прошёл проверку. */
    innUnreadable: boolean;
    contractorDelivery: boolean;
    /** Ни номера, ни поставщика — кандидаты только по дате приезда. */
    dateOnly: boolean;
    /** Сильные ключи ничего не нашли — показаны УПД рядом с датой приёмки. */
    dateFallback: boolean;
  };
};

export const QUOTA = { number: 50, inn: 100, name: 100, date: 50, search: 200 } as const;
/** Сколько строк забрать по слову названия, прежде чем сравнить названия целиком. */
const NAME_PREFILTER = 300;

const MSK_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' });

function mskDate(value: Date | null): string | null {
  return value ? MSK_DATE.format(value) : null;
}

function isoDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Номер целиком на стороне PostgreSQL — то же, что `normalizeDocumentNumber`. */
function numberFullSql(column: SQL): SQL {
  return drSql`regexp_replace(translate(upper(coalesce(${column}, '')), 'АВЕКМНОРСТУХ', 'ABEKMHOPCTYX'), '[^A-Z0-9А-ЯЁ]', '', 'g')`;
}

/** Цифровое ядро номера на стороне PostgreSQL — то же, что `documentNumberCore`. */
function numberCoreSql(column: SQL): SQL {
  return drSql`ltrim(regexp_replace(coalesce(${column}, ''), '[^0-9]', '', 'g'), '0')`;
}

function textArray(values: readonly string[]): SQL {
  return drSql`ARRAY[${drSql.join(
    values.map((value) => drSql`${value}`),
    drSql`, `,
  )}]::text[]`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Omit<
  EdoCandidate,
  | 'usedElsewhere'
  | 'usedIn'
  | 'foundBy'
  | 'reference'
  | 'score'
  | 'level'
  | 'matches'
  | 'conflicts'
  | 'missing'
  | 'otherSupplier'
  | 'supplierCheck'
> & {
  /** Ранг ручного поиска (0 — точное попадание); у остальных запросов 0. */
  rank: number;
  /** Все продавцы из XML реестра; у импортированных — пусто. Только для сверки. */
  sellerInns: string[];
};

/** Колонки источника, над которыми строятся условия поиска. */
type Columns = {
  number: SQL;
  date: SQL;
  name: SQL;
  innIn: (inns: readonly string[]) => SQL;
  /** Имя поставщика и имя файла, без технического пути хранения. */
  searchableText: SQL[];
  /** Короткий номер УПД не должен совпадать с частью чужого ИНН. */
  searchableInns: SQL[];
  /** Точное совпадение идентификатора: id записи, сообщения или документа. */
  exactId: (q: string) => SQL;
};

type Plan = { where: SQL; orderBy: SQL[]; limit: number; rank?: SQL };

type Context = { deliveryId: string; siteId: string };

async function queryExport(db: Db, ctx: Context, build: (c: Columns) => Plan): Promise<Row[]> {
  const t = edoExportDocuments;
  const plan = build({
    number: drSql`${t.documentNumber}`,
    date: drSql`${t.documentDate}`,
    name: drSql`${t.supplierName}`,
    innIn: (inns) => drSql`(${inArray(t.supplierInn, [...inns])} or ${t.sellerInns} && ${textArray(inns)})`,
    searchableText: [drSql`${t.supplierName}`],
    searchableInns: [drSql`${t.supplierInn}`],
    exactId: (q) =>
      drSql`(${t.messageId} = ${q} or ${t.entityId} = ${q}${UUID_RE.test(q) ? drSql` or ${t.id} = ${q}::uuid` : drSql``})`,
  });
  const rows = await db
    .select({
      id: t.id,
      docNumber: t.documentNumber,
      docDate: t.documentDate,
      supplierName: t.supplierName,
      supplierInn: t.supplierInn,
      sellerInns: t.sellerInns,
      totalSum: t.totalSum,
      contentCategory: t.contentCategory,
      rank: drSql<number>`${plan.rank ?? drSql`0`}`.mapWith(Number),
    })
    .from(t)
    .where(
      and(
        eq(t.status, 'stored'),
        isNotNull(t.s3Key),
        or(
          eq(t.contentCategory, 'materials'),
          eq(t.contentCategory, 'undetermined'),
          isNull(t.contentCategory),
        ),
        drSql`not exists (select 1 from delivery_edo_matches dem where dem.delivery_id = ${ctx.deliveryId} and dem.export_document_id = ${t.id})`,
        drSql`not exists (
          select 1 from delivery_edo_matches dem join deliveries other_delivery on other_delivery.id = dem.delivery_id
          where dem.export_document_id = ${t.id} and other_delivery.site_id <> ${ctx.siteId}
        )`,
        // Уже импортированная копия того же документа ищется как import.
        drSql`not exists (
          select 1 from source_documents imported
          where imported.edo_account_id = ${t.edoAccountId}
            and imported.provider_message_id = ${t.messageId}
            and imported.provider_entity_id = ${t.entityId}
            and imported.origin = 'edo_diadoc' and imported.status = 'parsed'
            and imported.is_technical = false
        )`,
        plan.where,
      ),
    )
    .orderBy(...plan.orderBy)
    .limit(plan.limit);
  return rows.map((row) => ({
    ...row,
    source: 'export' as const,
    siteId: null,
    docDate: isoDate(row.docDate),
  }));
}

async function queryImport(db: Db, ctx: Context, build: (c: Columns) => Plan): Promise<Row[]> {
  const t = sourceDocuments;
  const directory = alias(suppliers, 'candidate_directory');
  const supplier = alias(counterparties, 'candidate_supplier');
  const plan = build({
    number: drSql`${t.docNumber}`,
    date: drSql`${t.docDate}`,
    name: drSql`coalesce(${directory.name}, ${supplier.name})`,
    innIn: (inns) =>
      drSql`(${inArray(t.supplierInnRaw, [...inns])} or ${inArray(directory.inn, [...inns])} or ${inArray(supplier.inn, [...inns])})`,
    searchableText: [
      drSql`${directory.name}`,
      drSql`${supplier.name}`,
      drSql`${t.originalFilename}`,
    ],
    searchableInns: [
      drSql`${directory.inn}`,
      drSql`${supplier.inn}`,
      drSql`${t.supplierInnRaw}`,
    ],
    exactId: (q) =>
      drSql`(${t.providerMessageId} = ${q} or ${t.providerEntityId} = ${q}${UUID_RE.test(q) ? drSql` or ${t.id} = ${q}::uuid` : drSql``})`,
  });
  const rows = await db
    .select({
      id: t.id,
      docNumber: t.docNumber,
      docDate: t.docDate,
      supplierName: drSql<string | null>`coalesce(${directory.name}, ${supplier.name})`,
      // Для показа — первый ИНН, прошедший бы проверку, решает сверка; здесь
      // порядок «сырой → справочник → контрагент», как у карточки документа.
      supplierInn: drSql<
        string | null
      >`coalesce(nullif(${t.supplierInnRaw}, ''), nullif(${directory.inn}, ''), nullif(${supplier.inn}, ''))`,
      totalSum: t.totalSum,
      siteId: t.siteId,
      rank: drSql<number>`${plan.rank ?? drSql`0`}`.mapWith(Number),
    })
    .from(t)
    .leftJoin(directory, eq(t.supplierDirectoryId, directory.id))
    .leftJoin(supplier, eq(t.supplierId, supplier.id))
    .where(
      and(
        eq(t.kind, 'upd'),
        eq(t.direction, 'inbound'),
        eq(t.origin, 'edo_diadoc'),
        eq(t.status, 'parsed'),
        eq(t.isTechnical, false),
        or(eq(t.siteId, ctx.siteId), isNull(t.siteId)),
        drSql`not exists (select 1 from delivery_edo_matches dem where dem.delivery_id = ${ctx.deliveryId} and dem.source_document_id = ${t.id})`,
        drSql`not exists (
          select 1 from delivery_edo_matches dem join edo_export_documents exported on exported.id = dem.export_document_id
          where dem.delivery_id = ${ctx.deliveryId}
            and exported.edo_account_id = ${t.edoAccountId}
            and exported.message_id = ${t.providerMessageId}
            and exported.entity_id = ${t.providerEntityId}
        )`,
        drSql`not exists (
          select 1 from delivery_edo_matches dem
          join edo_export_documents exported on exported.id = dem.export_document_id
          join deliveries other_delivery on other_delivery.id = dem.delivery_id
          where exported.edo_account_id = ${t.edoAccountId}
            and exported.message_id = ${t.providerMessageId}
            and exported.entity_id = ${t.providerEntityId}
            and other_delivery.site_id <> ${ctx.siteId}
        )`,
        drSql`not exists (select 1 from delivery_sources ds where ds.delivery_id = ${ctx.deliveryId} and ds.source_document_id = ${t.id})`,
        drSql`not exists (
          select 1 from delivery_edo_matches dem join deliveries other_delivery on other_delivery.id = dem.delivery_id
          where dem.source_document_id = ${t.id} and other_delivery.site_id <> ${ctx.siteId}
        )`,
        drSql`not exists (
          select 1 from delivery_sources ds join deliveries other_delivery on other_delivery.id = ds.delivery_id
          where ds.source_document_id = ${t.id} and other_delivery.site_id <> ${ctx.siteId}
        )`,
        plan.where,
      ),
    )
    .orderBy(...plan.orderBy)
    .limit(plan.limit);
  return rows.map((row) => ({
    ...row,
    source: 'import' as const,
    contentCategory: null,
    sellerInns: [],
    docDate: isoDate(row.docDate),
  }));
}

/** Запрос по обоим источникам; `limit + 1` строк — чтобы знать, упёрлись ли в квоту. */
async function queryBoth(
  db: Db,
  ctx: Context,
  quota: number,
  build: (c: Columns) => Omit<Plan, 'limit'>,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const withLimit = (c: Columns): Plan => ({ ...build(c), limit: quota + 1 });
  const [imported, exported] = await Promise.all([
    queryImport(db, ctx, withLimit),
    queryExport(db, ctx, withLimit),
  ]);
  return {
    rows: [...imported.slice(0, quota), ...exported.slice(0, quota)],
    truncated: imported.length > quota || exported.length > quota,
  };
}

function distanceSql(c: Columns, anchor: string): SQL {
  return drSql`abs(${c.date}::date - ${anchor}::date) asc nulls last`;
}

function windowSql(c: Columns, lower: string, upperExclusive: string): SQL {
  return drSql`${c.date} >= ${lower}::date and ${c.date} < ${upperExclusive}::date`;
}

type LoadedReferences = {
  delivery: {
    siteId: string;
    arrivedDate: string | null;
    createdDate: string;
    contractorId: string | null;
  };
  references: MatchReference[];
};

/**
 * Эталоны подбора. С `sectionDocumentId` — только документ этого блока
 * материалов, любого вида (накладная тоже), без фото: номера с фото относятся
 * к другим документам приёмки. Что документ связан с приёмкой, проверяет маршрут.
 */
async function loadReferences(
  db: Db,
  deliveryId: string,
  sectionDocumentId?: string,
): Promise<LoadedReferences | null> {
  const [delivery] = await db
    .select({
      siteId: deliveries.siteId,
      arrivedAt: deliveries.arrivedAt,
      createdAt: deliveries.createdAt,
      supplierId: deliveries.supplierId,
      contractorId: deliveries.contractorId,
    })
    .from(deliveries)
    .where(eq(deliveries.id, deliveryId))
    .limit(1);
  if (!delivery) return null;

  const [ownSupplier] = delivery.supplierId
    ? await db
        .select({ name: counterparties.name, inn: counterparties.inn })
        .from(counterparties)
        .where(eq(counterparties.id, delivery.supplierId))
        .limit(1)
    : [];

  const paperDirectory = alias(suppliers, 'paper_directory');
  const paperSupplier = alias(counterparties, 'paper_supplier');
  const paperRows = await db
    .select({
      docNumber: sourceDocuments.docNumber,
      docDate: sourceDocuments.docDate,
      totalSum: sourceDocuments.totalSum,
      innRaw: sourceDocuments.supplierInnRaw,
      directoryInn: paperDirectory.inn,
      directoryName: paperDirectory.name,
      supplierInn: paperSupplier.inn,
      supplierName: paperSupplier.name,
    })
    .from(deliverySources)
    .innerJoin(sourceDocuments, eq(deliverySources.sourceDocumentId, sourceDocuments.id))
    .leftJoin(paperDirectory, eq(sourceDocuments.supplierDirectoryId, paperDirectory.id))
    .leftJoin(paperSupplier, eq(sourceDocuments.supplierId, paperSupplier.id))
    .where(
      sectionDocumentId
        ? and(eq(deliverySources.deliveryId, deliveryId), eq(sourceDocuments.id, sectionDocumentId))
        : and(
            eq(deliverySources.deliveryId, deliveryId),
            eq(sourceDocuments.kind, 'upd'),
            ne(sourceDocuments.origin, 'edo_diadoc'),
          ),
    );

  const photoRows = sectionDocumentId
    ? []
    : await db
        .select({
          docNumber: photoRecognizedItems.docNumber,
          docDate: photoRecognizedItems.docDate,
          totalSum: photoRecognizedItems.totalSum,
        })
        .from(deliveryPhotos)
        .innerJoin(
          photoRecognizedItems,
          eq(photoRecognizedItems.deliveryPhotoId, deliveryPhotos.id),
        )
        .where(
          and(eq(deliveryPhotos.deliveryId, deliveryId), isNotNull(photoRecognizedItems.docNumber)),
        );

  // ИНН самой организации (владельца ящика ЭДО) в графе поставщика — это
  // распознанный ИНН покупателя. Эталоном он сделал бы правильную УПД «чужой».
  const orgRows = await db.select({ inn: edoAccounts.orgInn }).from(edoAccounts);
  const orgInns = new Set(validInns(orgRows.map((row) => row.inn)).inns);
  const supplierInnsOf = (values: readonly (string | null | undefined)[]) => {
    const checked = validInns(values);
    const inns = checked.inns.filter((inn) => !orgInns.has(inn));
    return { inns, unreadable: checked.unreadable || (checked.inns.length > 0 && !inns.length) };
  };

  const arrivedDate = mskDate(delivery.arrivedAt);
  const own = supplierInnsOf([ownSupplier?.inn]);
  const ownNames = ownSupplier?.name ? [ownSupplier.name] : [];

  const references: MatchReference[] = paperRows.map((paper) => {
    // Каждый ИНН проверяется отдельно: битый `supplier_inn_raw` не должен
    // перекрывать верный ИНН справочника, как это делал coalesce.
    const checked = supplierInnsOf([
      paper.innRaw,
      paper.directoryInn,
      paper.supplierInn,
      ownSupplier?.inn,
    ]);
    return {
      origin: 'paper',
      label: paper.docNumber,
      numbers: paper.docNumber ? [paper.docNumber] : [],
      date: isoDate(paper.docDate),
      inns: checked.inns,
      innUnreadable: checked.unreadable,
      names: [paper.directoryName, paper.supplierName, ...ownNames].filter(
        (name): name is string => !!name,
      ),
      sums: paper.totalSum ? [paper.totalSum] : [],
      arrivedDate,
    };
  });

  // Страницы одной УПД на разных фото — один эталон. Склеиваем только по
  // полному номеру и той же дате: по одним цифрам номера склеились бы
  // разные документы.
  const paperKeys = new Set(references.map((ref) => `${normalizeDocumentNumber(ref.label)}|${ref.date ?? ''}`));
  const photoGroups = new Map<string, MatchReference>();
  for (const photo of photoRows) {
    const full = normalizeDocumentNumber(photo.docNumber);
    if (!full) continue;
    const date = isoDate(photo.docDate);
    const key = `${full}|${date ?? ''}`;
    if (paperKeys.has(key)) continue;
    const group = photoGroups.get(key);
    if (group) {
      if (photo.totalSum) group.sums.push(photo.totalSum);
      continue;
    }
    photoGroups.set(key, {
      origin: 'photo',
      label: photo.docNumber,
      numbers: [photo.docNumber!],
      date,
      inns: own.inns,
      innUnreadable: own.unreadable,
      names: ownNames,
      sums: photo.totalSum ? [photo.totalSum] : [],
      arrivedDate,
    });
  }
  references.push(...photoGroups.values());

  if (!references.length) {
    references.push({
      origin: 'delivery',
      label: null,
      numbers: [],
      date: null,
      inns: own.inns,
      innUnreadable: own.unreadable,
      names: ownNames,
      sums: [],
      arrivedDate,
    });
  }

  return {
    delivery: {
      siteId: delivery.siteId,
      arrivedDate,
      createdDate: mskDate(delivery.createdAt)!,
      contractorId: delivery.contractorId,
    },
    references,
  };
}

export async function findEdoCandidates(
  db: Db,
  deliveryId: string,
  opts: { q?: string; sectionDocumentId?: string } = {},
): Promise<EdoCandidatesResult | null> {
  const loaded = await loadReferences(db, deliveryId, opts.sectionDocumentId);
  if (!loaded) return null;
  const { delivery, references } = loaded;
  const ctx: Context = { deliveryId, siteId: delivery.siteId };

  const refDates = references.map((ref) => ref.date).filter((d): d is string => !!d);
  const anchor = refDates[0] ?? delivery.arrivedDate ?? delivery.createdDate;
  const fulls = [...new Set(references.flatMap((ref) => ref.numbers.map(normalizeDocumentNumber)).filter(Boolean))];
  const cores = [...new Set(references.flatMap((ref) => ref.numbers.map(documentNumberCore)).filter(Boolean))];
  const inns = [...new Set(references.flatMap((ref) => ref.inns))];
  const innUnreadable = !inns.length && references.some((ref) => ref.innUnreadable);
  const names = [...new Set(references.flatMap((ref) => ref.names.map(normalizeSupplierName)).filter(Boolean))];
  const rawNames = references.flatMap((ref) => ref.names);

  const found = new Map<string, { row: Row; foundBy: Set<FoundBy> }>();
  const truncated = new Set<FoundBy>();
  const add = (rows: Row[], by: FoundBy) => {
    for (const row of rows) {
      const key = `${row.source}:${row.id}`;
      const entry = found.get(key);
      if (entry) entry.foundBy.add(by);
      else found.set(key, { row, foundBy: new Set([by]) });
    }
  };

  const q = (opts.q ?? '').trim();
  let dateOnly = false;
  let dateFallback = false;
  if (q.length >= 2) {
    const like = `%${escapeLike(q)}%`;
    const shortNumber = /^\d+$/.test(q) && q.length < 10;
    const normalizedQ = normalizeDocumentNumber(q);
    const qCore = documentNumberCore(q);
    // Для короткого номера «233» нужен именно документ № 233 (в том числе
    // «УТ-233»), а не сотни чужих УПД с этими цифрами в ИНН, пути или серии.
    const exactNumberSearch = shortNumber && qCore.length > 0;
    const searchRankSql = (c: Columns): SQL => drSql`case
          when ${normalizedQ ? drSql`${numberFullSql(c.number)} = ${normalizedQ}` : drSql`false`} or ${c.exactId(q)} then 0
          when ${qCore ? drSql`${numberCoreSql(c.number)} = ${qCore}` : drSql`false`} then 1
          when ${inns.length ? c.innIn(inns) : drSql`false`} then 2
          else 3 end`;
    const result = await queryBoth(db, ctx, QUOTA.search, (c) => ({
      where: exactNumberSearch
        ? or(drSql`${numberFullSql(c.number)} = ${normalizedQ}`, drSql`${numberCoreSql(c.number)} = ${qCore}`)!
        : or(
            ilike(c.number, like),
            normalizedQ.length >= 3 ? drSql`${numberFullSql(c.number)} like ${`%${normalizedQ}%`}` : undefined,
            qCore ? drSql`${numberCoreSql(c.number)} = ${qCore}` : undefined,
            ...c.searchableText.map((column) => ilike(column, like)),
            ...(shortNumber ? [] : c.searchableInns.map((column) => ilike(column, like))),
            c.exactId(q),
          )!,
      // Точное попадание не должно потеряться за двумястами близкими по дате.
      rank: searchRankSql(c),
      orderBy: [searchRankSql(c), distanceSql(c, anchor)],
    }));
    add(result.rows, 'search');
    if (result.truncated) truncated.add('search');
  } else {
    const tasks: Promise<void>[] = [];
    if (fulls.length || cores.length) {
      const dates = [...refDates, delivery.arrivedDate ?? anchor].sort();
      const lower = shiftDate(dates[0]!, -60);
      const upper = shiftDate(dates[dates.length - 1]!, 61);
      tasks.push(
        queryBoth(db, ctx, QUOTA.number, (c) => ({
          where: and(
            or(
              fulls.length ? inArray(numberFullSql(c.number), fulls) : undefined,
              cores.length ? inArray(numberCoreSql(c.number), cores) : undefined,
            ),
            windowSql(c, lower, upper),
          )!,
          orderBy: [
            fulls.length
              ? drSql`case when ${inArray(numberFullSql(c.number), fulls)} then 0 else 1 end`
              : drSql`1`,
            distanceSql(c, anchor),
          ],
        })).then((result) => {
          add(result.rows, 'number');
          if (result.truncated) truncated.add('number');
        }),
      );
    }
    const lower = shiftDate(anchor, -30);
    const upper = shiftDate(anchor, 31);
    if (inns.length) {
      tasks.push(
        queryBoth(db, ctx, QUOTA.inn, (c) => ({
          where: and(c.innIn(inns), windowSql(c, lower, upper))!,
          orderBy: [distanceSql(c, anchor)],
        })).then((result) => {
          add(result.rows, 'inn');
          if (result.truncated) truncated.add('inn');
        }),
      );
    }
    if (names.length) {
      // Название проверяем и при наличии ИНН: в бумажной УПД он может быть
      // ошибочным. SQL берёт длинное слово, полное имя сверяем уже здесь.
      const words = [
        ...new Set(rawNames.flatMap(supplierNameTokens).filter((word) => word.length >= 3)),
      ].sort((a, b) => b.length - a.length);
      const word = words[0];
      if (word) {
        tasks.push(
          queryBoth(db, ctx, NAME_PREFILTER, (c) => ({
            where: and(ilike(c.name, `%${escapeLike(word)}%`), windowSql(c, lower, upper))!,
            orderBy: [distanceSql(c, anchor)],
          })).then((result) => {
            const same = result.rows.filter((row) =>
              names.includes(normalizeSupplierName(row.supplierName)),
            );
            add(same.slice(0, QUOTA.name), 'name');
            if (same.length > QUOTA.name || result.truncated) truncated.add('name');
          }),
        );
      }
    }
    if (!fulls.length && !cores.length && !inns.length && !names.length) {
      dateOnly = true;
      const arrived = delivery.arrivedDate ?? anchor;
      tasks.push(
        queryBoth(db, ctx, QUOTA.date, (c) => ({
          where: windowSql(c, shiftDate(arrived, -7), shiftDate(arrived, 2)),
          orderBy: [distanceSql(c, arrived)],
        })).then((result) => {
          add(result.rows, 'date');
          if (result.truncated) truncated.add('date');
        }),
      );
    }
    await Promise.all(tasks);

    // Если реквизиты приёмки не дали ни одного кандидата, человек всё равно
    // должен получить список УПД рядом с датой документа для ручной сверки.
    // Это запасной список, а не совпадение поставщика: UI показывает его целиком
    // с явным предупреждением о расхождениях.
    if (found.size === 0 && !dateOnly) {
      const result = await queryBoth(db, ctx, QUOTA.date, (c) => ({
        where: windowSql(c, shiftDate(anchor, -7), shiftDate(anchor, 8)),
        orderBy: [distanceSql(c, anchor)],
      }));
      add(result.rows, 'date');
      dateFallback = result.rows.length > 0;
      if (result.truncated) truncated.add('date');
    }
  }

  const entries = [...found.values()];
  // Кандидат уже связанный с этой приёмкой в список не попадает, так что
  // исключение текущей приёмки — страховка, а не фильтр.
  const usage = await edoDocumentUsage(
    db,
    entries.map((e) => ({ source: e.row.source, id: e.row.id })),
    deliveryId,
  );

  const distance = (item: { docDate: string | null }) =>
    Math.abs(item.docDate ? daysBetween(anchor, item.docDate) : 1e6);
  // Ручной поиск упорядочен запросом человека: точный номер — первым, даже
  // если с приёмкой он сходится хуже соседей. Остальные — сверкой.
  if (q.length >= 2) entries.sort((a, b) => a.row.rank - b.row.rank || distance(a.row) - distance(b.row));
  const items: EdoCandidate[] = entries.map(({ row: { rank: _rank, sellerInns, ...row }, foundBy }) => {
    const {
      innConflict: _innConflict,
      matchedInn: _matchedInn,
      ...match
    } = rankEdoAgainstReferences(references, { ...row, supplierInns: sellerInns });
    return {
      ...row,
      usedElsewhere: usage.get(edoUsageKey(row))?.count ?? 0,
      usedIn: usage.get(edoUsageKey(row))?.deliveries ?? [],
      foundBy: [...foundBy],
      ...match,
      missing:
        row.source === 'export' && row.contentCategory !== 'materials'
          ? [...match.missing, 'тип содержимого УПД']
          : match.missing,
    };
  });
  if (q.length < 2) items.sort((a, b) => compareMatches(a, b) || distance(a) - distance(b));

  const referenceMissing = [
    !fulls.length && 'номер УПД',
    !refDates.length && 'дата УПД',
    !inns.length && !names.length && 'поставщик',
    innUnreadable && 'ИНН поставщика (не проходит проверку)',
    references.every((ref) => !ref.sums.length) && 'сумма УПД',
  ].filter((value): value is string => typeof value === 'string');

  const receivedUntil = await registryReceivedUntil(db);
  const registry = await exportRegistryStatus(db, { intervalSec: loadEnv().EDO_EXPORT_INTERVAL_SEC });
  // Полнота — по худшей учётке: если хоть одна ни разу не дочитала ленту,
  // опираться можно только на последнюю полученную УПД.
  const checked = registry.map((account) => account.checkedAt);
  const registryAsOf: EdoCandidatesResult['diagnostics']['registryAsOf'] =
    checked.length && checked.every((at): at is string => !!at)
      ? { at: checked.sort()[0]!, basis: 'checked' }
      : receivedUntil
        ? { at: receivedUntil, basis: 'received' }
        : null;
  // Сравнение по дню: УПД, датированная днём проверки, могла успеть в реестр,
  // поэтому «позже» — только строго следующий день и дальше.
  const asOfDay = registryAsOf ? mskDate(new Date(registryAsOf.at)) : null;
  const referencesAfterRegistry = asOfDay
    ? references
        .filter((ref): ref is MatchReference & { date: string } => !!ref.date && ref.date > asOfDay)
        .map((ref) => ({ label: ref.label, date: ref.date }))
    : [];
  const census = await censusForSupplier(db, {
    inns,
    names: rawNames,
    from: shiftDate(anchor, -30),
    to: shiftDate(anchor, 30),
  });

  return {
    items,
    referenceMissing,
    truncated: [...truncated],
    diagnostics: {
      registryReceivedUntil: receivedUntil,
      registryAsOf,
      referencesAfterRegistry,
      registry,
      census,
      innsAbsentInRegistry: await innsAbsentInRegistry(db, inns),
      innUnreadable,
      contractorDelivery: delivery.contractorId !== null,
      dateOnly,
      dateFallback,
    },
  };
}

async function registryReceivedUntil(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ at: drSql<Date | string | null>`max(${edoExportDocuments.receivedAt})` })
    .from(edoExportDocuments)
    .where(eq(edoExportDocuments.status, 'stored'));
  if (!row?.at) return null;
  return row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString();
}

/** ИНН, под которыми в реестре нет ни одной строки — ни выгруженной, ни отсеянной списком. */
async function innsAbsentInRegistry(db: Db, inns: readonly string[]): Promise<string[]> {
  if (!inns.length) return [];
  // Существование по каждому ИНН, а не выборка строк: у крупного поставщика
  // строк сотни, и любой лимит выборки ложно пометил бы остальные ИНН.
  const rows = await db.execute<{ inn: string }>(drSql`
    select requested.inn
      from unnest(${textArray(inns)}) as requested(inn)
     where not exists (
       select 1 from ${edoExportDocuments} e
        where e.supplier_inn = requested.inn or requested.inn = any(e.seller_inns)
     )
  `);
  return rows.map((row) => row.inn);
}
