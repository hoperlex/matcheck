/**
 * Выгрузка УПД из ящика Диадока в хранилище — без карточек в портале.
 *
 * Зачем отдельно от импорта. Импорт ведёт журнал приёма (edo_events,
 * edo_receipts) и курсор ленты учётной записи; документ, отмеченный там
 * «сохранённым», импорт больше никогда не возьмёт. Выгрузка не пишет ни туда,
 * ни в курсор импорта: её память — свой реестр edo_export_documents, а курсор
 * автопрохода — своя таблица edo_export_cursors (ведёт edo-export-runner.ts).
 * Будущий импорт эти документы не потеряет.
 *
 * Почему качается всё, а сохраняется не всё. ИНН отправителя в ленте нет — у
 * документа есть только ящик контрагента. Продавца надёжно называет только сам
 * XML, поэтому скачивается каждый УПД периода. В режиме списка в хранилище
 * ложатся только те, чей продавец есть в списке, остальные — строка `not_in_list`
 * с реквизитами из XML. В режиме «все УПД» (`suppliers: null`) сохраняется всё.
 *
 * Повтор идемпотентен. `stored` не качается никогда; известный `failed` лента
 * тоже не перекачивает — для него есть проход повторов со своим расписанием,
 * иначе каждое перечитывание страницы сжигало бы попытку. Ключ в хранилище
 * детерминирован, так что обрыв между записью файла и строкой реестра лечится
 * тем же повтором: файл перезапишется теми же байтами.
 *
 * Лиз продлевается перед КАЖДЫМ запросом к Диадоку, а не раз в несколько
 * скачиваний: под лизом обменивается refresh_token, а худший запрос с ретраями
 * длится минуты — несколько таких подряд пережили бы лиз.
 */
import { and, asc, eq, inArray, isNotNull, lte, sql as drSql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { edoExportCensus, edoExportDocuments, type EdoCensusCategory } from '../../db/schema.js';
import { buildEdoExportKey } from '../storage/s3.path.js';
import { fileHashOf } from '../sourceDocuments/bundle-key.js';
import type { DiadocClient } from './diadoc.client.js';
import { classifyMessageEntities, type ClassifiedEntity } from './diadoc.entities.js';
import {
  DiadocAborted,
  DiadocAuthRejected,
  DiadocGone,
  DiadocPayloadTooLarge,
  DiadocRequestNotAllowed,
} from './diadoc.http.js';
import { resolveEventTime, type DiadocMessage } from './diadoc.types.js';
import { classifyUtdContent, type EdoMetaCategory } from './document-kind.js';
import { detectEdoFile } from './edo-file-kind.js';
import { EdoLeaseLost, isTransportFailure } from './inventory.js';
import { contentKeyOf, fileIdOf } from './export-identity.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { parseUpdXml, type UpdParsed } from './upd.parser.js';

/** Типы документов, которые выгружаются: УПД любой функции и его исправление. */
export const EXPORT_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'UniversalTransferDocument',
  'UniversalTransferDocumentRevision',
]);

/** Что переписывается без скачивания: документы, которые могут прийти вместо УПД. */
const CENSUS_CATEGORIES: ReadonlySet<EdoMetaCategory> = new Set(['scan', 'invoice', 'waybill']);

const DEFAULT_MAX_EVENTS = 100_000;

/**
 * Расписание повторов неудачной выгрузки: через сколько часов после n-й
 * неудачи пробовать снова. После последней — окончательно (сбросить можно
 * только явно, флагом скрипта).
 */
export const RETRY_DELAYS_HOURS = [1, 6, 24, 72] as const;
export const MAX_EXPORT_ATTEMPTS = RETRY_DELAYS_HOURS.length + 1;

export function retryDelayHours(attempt: number): number | null {
  return RETRY_DELAYS_HOURS[attempt - 1] ?? null;
}

/** То же расписание в SQL: `NULL` после последней попытки (make_interval строгая). */
function nextRetrySql(attempt: SQL): SQL {
  return drSql`now() + make_interval(hours => (ARRAY[${drSql.raw(RETRY_DELAYS_HOURS.join(','))}]::int[])[${attempt}])`;
}

/** Запись в хранилище — та же сигнатура, что у putObject. */
export type ExportPut = (
  key: string,
  body: Buffer,
  contentType: string,
  metadata?: Record<string, string>,
) => Promise<void>;

export type ExportDeps = {
  db: Db;
  client: DiadocClient;
  log: FastifyBaseLogger;
  put: ExportPut;
  xmlMaxBytes: number;
};

export type ExportSummary = {
  pages: number;
  eventsSeen: number;
  /** Время первого и последнего события ленты, ISO. */
  from: string | null;
  to: string | null;
  /** УПД и исправления, прошедшие отбор по метаданным. */
  candidates: number;
  /** Выгружено в этом запуске. */
  stored: number;
  /** Уже лежали в хранилище — не качались. */
  alreadyStored: number;
  /** Скачаны и не взяты: продавца нет в списке. */
  notInList: number;
  /** Не качались: известно по реестру, что продавца нет в списке. */
  notInListKnown: number;
  failed: number;
  /** Не качались: сбой уже записан, повторяет только проход повторов. */
  failedKnown: number;
  /** Обращений за содержимым документа. */
  downloads: number;
  /** Новых строк переписи. */
  census: number;
  /** Обход остановлен предохранителем — лента прочитана не до конца. */
  truncated: boolean;
  truncateReason: 'limit' | 'no_index_key' | null;
  /** Лента дошла до пустой страницы: всё, что в ней было, прочитано. */
  feedCompleted: boolean;
  /** Ключ последней полностью обработанной страницы (или стартовый). */
  lastIndexKey: string | null;
};

export type ExportParams = {
  accountId: string;
  boxId: string;
  since: Date;
  /** Нормализованный ИНН → название из списка; `null` — все УПД ящика. */
  suppliers: ReadonlyMap<string, string> | null;
  /** Продлевает лиз; `false` — лиз потерян, работу надо прекратить. */
  renewLease: () => Promise<boolean>;
  /** Продолжить ленту после этого ключа (постоянный курсор автопрохода). */
  afterIndexKey?: string | null;
  /**
   * Страница обработана целиком: у каждого документа есть строка реестра,
   * перепись записана. Ошибка колбэка останавливает обход.
   */
  onPageDone?: (indexKey: string) => Promise<void>;
  maxEvents?: number;
  /** Предел скачиваний; как и `maxEvents`, проверяется только на границе страницы. */
  maxDownloads?: number;
  signal?: AbortSignal;
  /** Переписывать сканы, счета-фактуры и накладные — без скачивания. */
  census?: boolean;
  /** `false` — только перепись: УПД не качаются и в реестр не пишутся. */
  downloads?: boolean;
  onPage?: (summary: Readonly<ExportSummary>) => void;
};

/** Лента вернула ту же страницу: дальше идти некуда, а повторять бессмысленно. */
export class EdoFeedStuck extends Error {
  constructor(cursor: string) {
    super(`лента Диадока не сдвинулась после ${cursor}: обход остановлен`);
    this.name = 'EdoFeedStuck';
  }
}

/** Хранилище не приняло файл. Документ не отмечается — повтор запишет его снова. */
export class EdoExportStorageFailed extends Error {
  constructor(key: string, cause: unknown) {
    super(`хранилище не приняло ${key}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'EdoExportStorageFailed';
  }
}

/**
 * Обход прерван. Несёт сводку на момент остановки — всё, что уже сделано,
 * лежит в реестре, и человеку нужно видеть, сколько успело выгрузиться.
 */
export class EdoExportStopped extends Error {
  constructor(
    readonly reason: unknown,
    readonly summary: Readonly<ExportSummary>,
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
    this.name = 'EdoExportStopped';
  }
}

/** Брать ли сущность: УПД или исправление, не подпись и не исключённое. */
export function selectForExport(entity: ClassifiedEntity): boolean {
  return (
    entity.route !== 'ignored' &&
    entity.category !== null &&
    entity.category !== 'excluded' &&
    entity.typeNamedId !== null &&
    EXPORT_DOCUMENT_TYPES.has(entity.typeNamedId)
  );
}

/** Переписать ли сущность: скан, счёт-фактура или накладная, которые выгрузка не берёт. */
export function selectForCensus(entity: ClassifiedEntity): boolean {
  return (
    entity.route !== 'ignored' &&
    entity.category !== null &&
    CENSUS_CATEGORIES.has(entity.category) &&
    !selectForExport(entity)
  );
}

/** ИНН, который помещается в реестр: 10 или 12 цифр. Остальное — только в `seller_inns`. */
function fitsInn(inn: string): boolean {
  return /^(\d{10}|\d{12})$/.test(inn);
}

/**
 * Продавцы документа и первый из них, кто есть в списке.
 *
 * Сравниваются цифры ИНН: формат допускает несколько продавцов, и взять
 * документ надо, если в списке хоть один. Без списка (`null`) берётся первый
 * продавец с ИНН, который помещается в реестр.
 */
export function matchSupplier(
  parsed: Pick<UpdParsed, 'suppliers'>,
  list: ReadonlyMap<string, string> | null,
): { sellerInns: string[]; listed: { inn: string; name: string } | null } {
  const sellerInns = [
    ...new Set(parsed.suppliers.map((s) => s.inn.replace(/\D/g, '')).filter((inn) => inn.length > 0)),
  ];
  if (list === null) {
    const inn = sellerInns.find(fitsInn);
    const seller = inn ? parsed.suppliers.find((s) => s.inn.replace(/\D/g, '') === inn) : undefined;
    return { sellerInns, listed: inn ? { inn, name: seller?.name ?? '' } : null };
  }
  const inn = sellerInns.find((candidate) => list.has(candidate));
  return { sellerInns, listed: inn ? { inn, name: list.get(inn)! } : null };
}

/** Дата документа к ISO: XML даёт yyyy-mm-dd, метаданные Диадока — dd.mm.yyyy. */
export function toIsoDate(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : null;
}

/**
 * Дата, которую можно записать в базу: существующий день 2000–2100. «31.02» и
 * «0026» из метаданных иначе остановили бы запись строки — а с ней и страницу.
 */
export function storableDate(raw: string | null | undefined): string | null {
  const iso = toIsoDate(raw);
  if (!iso) return null;
  const year = Number(iso.slice(0, 4));
  const date = new Date(`${iso}T00:00:00Z`);
  if (year < 2000 || year > 2100 || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Предел numeric(18, 2): 16 знаков до запятой. */
const MONEY_LIMIT = 1e16;

function money(value: number | null): string | null {
  return value === null || !Number.isFinite(value) || Math.abs(value) >= MONEY_LIMIT
    ? null
    : value.toFixed(2);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SQLSTATE ошибки PostgreSQL — у самой ошибки или у обёртки drizzle в `cause`. */
function pgCode(err: unknown): string | null {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Данные документа не помещаются в реестр (класс 22: длина, диапазон, формат).
 * Нарушения целостности (класс 23: уникальность, ключи, CHECK) сюда не входят —
 * это дефект кода или схемы, и проход на нём должен остановиться.
 */
function isDataError(err: unknown): boolean {
  return pgCode(err)?.startsWith('22') ?? false;
}

type Row = typeof edoExportDocuments.$inferInsert;
type Existing = { status: string; sellerInns: string[] };

const rowKey = (messageId: string, entityId: string) => `${messageId}\u0000${entityId}`;

/**
 * Что запись реестра знает о документе до разбора XML — из метаданных оператора.
 *
 * Описание нейтрально к оператору: Диадок строит его из сущности ленты
 * (`exportRefFromDiadoc`), СБИС — из вложения ленты. Дальше — общий путь
 * `storeExportXml`: разбор, продавец, строка реестра, файл в хранилище.
 */
export type ExportRef = {
  accountId: string;
  messageId: string;
  entityId: string;
  /** Тип документа у оператора ('UniversalTransferDocument', 'УпдСчфДоп' …). */
  documentType: string;
  documentFunction: string | null;
  /** Номер и дата из метаданных — запасные, если XML их не дал. */
  documentNumber: string | null;
  documentDate: string | null;
  fileName: string | null;
  /** Ящик отправителя (только Диадок: по нему перепись узнаёт поставщика). */
  counteragentBoxId: string | null;
  receivedAt: Date | null;
  /** Редакция документа у оператора (СБИС) — по ней повторяется скачивание. */
  providerRevisionId: string | null;
};

export function exportRefFromDiadoc(accountId: string, messageId: string, entity: ClassifiedEntity): ExportRef {
  return {
    accountId,
    messageId,
    entityId: entity.entityId,
    documentType: entity.typeNamedId ?? 'unknown',
    documentFunction: entity.documentFunction,
    documentNumber: entity.documentNumber,
    documentDate: entity.documentDate,
    fileName: entity.fileName,
    counteragentBoxId: entity.counteragentBoxId,
    receivedAt: entity.meta.receivedAt,
    providerRevisionId: null,
  };
}

/** Строка реестра из метаданных — основа и для сбоя, и для разобранного XML. */
function baseRow(ref: ExportRef): Row {
  const metaDate = storableDate(ref.documentDate);
  return {
    edoAccountId: ref.accountId,
    messageId: ref.messageId,
    entityId: ref.entityId,
    counteragentBoxId: ref.counteragentBoxId,
    documentType: ref.documentType,
    documentFunction: ref.documentFunction,
    documentNumber: ref.documentNumber,
    documentDate: metaDate ? new Date(`${metaDate}T00:00:00Z`) : null,
    correctionNumber: null,
    sellerInns: [],
    supplierInn: null,
    supplierName: null,
    totalSum: null,
    vatSum: null,
    itemsCount: null,
    contentCategory: null,
    receivedAt: ref.receivedAt,
    status: 'failed',
    lastError: null,
    s3Key: null,
    contentSha256: null,
    sizeBytes: null,
    providerRevisionId: ref.providerRevisionId,
    fileId: null,
    contentKey: null,
  };
}

/**
 * Запись строки реестра. Строку `stored` не перезаписывает ничто: файл уже в
 * хранилище, и поздний сбой того же документа не должен её испортить.
 *
 * Сбой увеличивает счётчик попыток; `retryable` назначает следующую попытку по
 * расписанию, иначе сбой окончательный (`next_retry_at = null`).
 */
async function saveRow(db: Db, row: Row, opts: { retryable?: boolean } = {}): Promise<void> {
  const t = edoExportDocuments;
  const { edoAccountId: _a, messageId: _m, entityId: _e, ...rest } = row;
  const failed = row.status === 'failed';
  const retry = failed && opts.retryable === true;
  await db
    .insert(t)
    .values({ ...row, attempts: failed ? 1 : 0, nextRetryAt: retry ? nextRetrySql(drSql`1`) : null })
    .onConflictDoUpdate({
      target: [t.edoAccountId, t.messageId, t.entityId],
      set: {
        ...rest,
        attempts: failed ? drSql`${t.attempts} + 1` : drSql`${t.attempts}`,
        nextRetryAt: retry ? nextRetrySql(drSql`${t.attempts} + 1`) : null,
        updatedAt: new Date(),
      },
      setWhere: drSql`${t.status} <> 'stored'`,
    });
}

async function loadExisting(
  db: Db,
  accountId: string,
  messageIds: string[],
): Promise<Map<string, Existing>> {
  const out = new Map<string, Existing>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select({
      messageId: edoExportDocuments.messageId,
      entityId: edoExportDocuments.entityId,
      status: edoExportDocuments.status,
      sellerInns: edoExportDocuments.sellerInns,
    })
    .from(edoExportDocuments)
    .where(
      and(
        eq(edoExportDocuments.edoAccountId, accountId),
        inArray(edoExportDocuments.messageId, [...new Set(messageIds)]),
      ),
    );
  for (const r of rows) out.set(rowKey(r.messageId, r.entityId), { status: r.status, sellerInns: r.sellerInns });
  return out;
}

export type EntityOutcome = 'stored' | 'not_in_list' | 'failed';

type ExportEntityParams = Pick<ExportParams, 'accountId' | 'boxId' | 'suppliers' | 'signal'>;

/** Зависимости общей записи — без клиента оператора. */
export type StoreDeps = Pick<ExportDeps, 'db' | 'log' | 'put'>;

/**
 * Отметить документ невыгруженным. `retryable` — повтор по расписанию
 * (временная причина: скачивание), иначе сбой окончательный.
 */
export async function recordExportFailure(
  deps: Pick<StoreDeps, 'db' | 'log'>,
  ref: ExportRef,
  reason: string,
  retryable = false,
): Promise<EntityOutcome> {
  await saveRow(deps.db, { ...baseRow(ref), status: 'failed', lastError: reason }, { retryable });
  deps.log.warn({ messageId: ref.messageId, entityId: ref.entityId, reason }, 'edo export: документ не выгружен');
  return 'failed';
}

/** Один документ Диадока: скачать, опознать продавца, сохранить или отметить. */
async function exportEntity(
  deps: ExportDeps,
  params: ExportEntityParams,
  messageId: string,
  entity: ClassifiedEntity,
): Promise<EntityOutcome> {
  const ref = exportRefFromDiadoc(params.accountId, messageId, entity);
  const fail = (reason: string, retryable = false) => recordExportFailure(deps, ref, reason, retryable);

  let buffer: Buffer;
  try {
    buffer = await deps.client.getEntityContent(
      params.boxId,
      messageId,
      entity.entityId,
      deps.xmlMaxBytes,
      { signal: params.signal },
    );
  } catch (err) {
    // Связь, доступ, лимиты, отказ обмена токена, остановка процесса — не про
    // этот документ: обход стоп, повтор продолжит. Запрет пути — дефект кода,
    // им испорчен был бы каждый следующий документ.
    if (
      isTransportFailure(err) ||
      err instanceof DiadocRequestNotAllowed ||
      err instanceof DiadocAuthRejected ||
      err instanceof DiadocAborted
    ) {
      throw err;
    }
    if (err instanceof DiadocGone) return fail('документ исчез из Диадока');
    if (err instanceof DiadocPayloadTooLarge) {
      return fail(`файл больше ${Math.round(deps.xmlMaxBytes / 1024 / 1024)} МБ`);
    }
    return fail(`скачивание: ${errorText(err)}`, true);
  }

  return storeExportXml(deps, ref, buffer, params.suppliers);
}

/**
 * Общая часть выгрузки для любого оператора: байты XML → разбор → продавец →
 * строка реестра → файл в хранилище.
 *
 * Правила ошибок: не XML и неразбираемый XML — окончательный сбой документа;
 * данные, которые реестр не принял (класс 22), — тоже; нарушение целостности
 * (класс 23) и отказ хранилища останавливают проход — они не про документ.
 */
export async function storeExportXml(
  deps: StoreDeps,
  ref: ExportRef,
  buffer: Buffer,
  suppliers: ReadonlyMap<string, string> | null,
): Promise<EntityOutcome> {
  const row = baseRow(ref);
  const fail = (reason: string, retryable = false) => recordExportFailure(deps, ref, reason, retryable);
  /** Запись разобранной строки; данные, которые реестр не принял, — сбой без повтора. */
  const write = async (parsedRow: Row): Promise<EntityOutcome | null> => {
    try {
      await saveRow(deps.db, parsedRow);
      return null;
    } catch (err) {
      if (!isDataError(err)) throw err;
      return fail(`запись в реестр: ${errorText(err)}`);
    }
  };

  const kind = detectEdoFile(buffer, ref.fileName);
  if (kind.ext !== 'xml') return fail(`вложение не XML (${kind.mimeType})`);

  let parsed: UpdParsed;
  try {
    parsed = parseUpdXml(decodeXmlBuffer(buffer));
  } catch (err) {
    return fail(`разбор: ${errorText(err)}`);
  }

  const { sellerInns, listed } = matchSupplier(parsed, suppliers);
  const supplierInn = listed?.inn ?? sellerInns.find(fitsInn) ?? null;
  const seller =
    parsed.suppliers.find((s) => s.inn.replace(/\D/g, '') === supplierInn) ?? parsed.supplier;
  const docDate = storableDate(parsed.docDate);
  const docNumber = parsed.docNumber.trim() || ref.documentNumber;
  const totalSum = money(parsed.totalSum);
  const vatSum = money(parsed.vatSum);
  // Что не поместилось в реестр, хранится пустым — с пометкой, а не молча.
  const dropped = [
    parsed.docDate && !docDate && 'дата',
    parsed.totalSum !== null && !totalSum && 'сумма',
    parsed.vatSum !== null && !vatSum && 'НДС',
  ].filter((v): v is string => typeof v === 'string');

  const parsedRow: Row = {
    ...row,
    documentFunction: parsed.function ?? ref.documentFunction,
    documentNumber: docNumber,
    documentDate: docDate ? new Date(`${docDate}T00:00:00Z`) : row.documentDate,
    correctionNumber: parsed.correction?.number ?? null,
    sellerInns,
    supplierInn,
    supplierName: seller.name || null,
    totalSum,
    vatSum,
    itemsCount: parsed.items.length,
    contentCategory: classifyUtdContent(parsed).category,
    fileId: fileIdOf(parsed),
    contentKey: contentKeyOf(parsed),
    lastError: dropped.length ? `не записано (вне диапазона реестра): ${dropped.join(', ')}` : null,
  };

  // Без списка берётся всё, в том числе УПД без пригодного ИНН продавца (ключ `unknown`).
  if (suppliers !== null && !listed) {
    return (await write({ ...parsedRow, status: 'not_in_list' })) ?? 'not_in_list';
  }

  const key = buildEdoExportKey({
    inn: supplierInn,
    docDate: docDate ?? storableDate(ref.documentDate),
    docNumber,
    accountId: ref.accountId,
    messageId: ref.messageId,
    entityId: ref.entityId,
  });
  const sha256 = fileHashOf(buffer);
  // Байты как пришли, в исходной кодировке: это подписанный оригинал.
  try {
    await deps.put(key, buffer, 'application/xml', { sha256 });
  } catch (err) {
    throw new EdoExportStorageFailed(key, err);
  }
  return (
    (await write({
      ...parsedRow,
      status: 'stored',
      s3Key: key,
      contentSha256: sha256,
      sizeBytes: buffer.length,
    })) ?? 'stored'
  );
}

type CensusRow = typeof edoExportCensus.$inferInsert;

function censusRow(
  accountId: string,
  message: DiadocMessage,
  entity: ClassifiedEntity,
  messageHasUtd: boolean,
): CensusRow {
  return {
    edoAccountId: accountId,
    messageId: message.MessageId,
    entityId: entity.entityId,
    documentType: entity.typeNamedId,
    category: entity.category as EdoCensusCategory,
    documentNumber: entity.documentNumber,
    documentDate: storableDate(entity.documentDate),
    numberSource: entity.meta.numberSource,
    fileName: entity.fileName ?? entity.meta.metadata.FileName ?? null,
    contentSize: entity.contentSize,
    counteragentBoxId: entity.counteragentBoxId ?? message.FromBoxId ?? null,
    fromTitle: typeof message.FromTitle === 'string' && message.FromTitle.trim() ? message.FromTitle : null,
    totalSum: entity.meta.totalSum,
    messageHasUtd,
    receivedAt: entity.meta.receivedAt,
  };
}

function emptySummary(lastIndexKey: string | null): ExportSummary {
  return {
    pages: 0,
    eventsSeen: 0,
    from: null,
    to: null,
    candidates: 0,
    stored: 0,
    alreadyStored: 0,
    notInList: 0,
    notInListKnown: 0,
    failed: 0,
    failedKnown: 0,
    downloads: 0,
    census: 0,
    truncated: false,
    truncateReason: null,
    feedCompleted: false,
    lastIndexKey,
  };
}

export async function exportUpdFromBox(deps: ExportDeps, params: ExportParams): Promise<ExportSummary> {
  const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
  const downloads = params.downloads !== false;
  const summary = emptySummary(params.afterIndexKey ?? null);

  const ensureLease = async () => {
    if (params.signal?.aborted) throw new DiadocAborted();
    if (!(await params.renewLease())) throw new EdoLeaseLost();
  };

  let cursor: string | null = params.afterIndexKey ?? null;
  // Один документ — одно скачивание за обход, даже если сообщение повторилось.
  const handled = new Set<string>();
  try {
    for (;;) {
      await ensureLease();
      const { events } = await deps.client.getNewEvents({
        boxId: params.boxId,
        afterIndexKey: cursor,
        fromTimestamp: params.since,
        signal: params.signal,
      });
      if (events.length === 0) {
        summary.feedCompleted = true;
        break;
      }
      const lastIndexKey = events[events.length - 1]?.IndexKey ?? null;
      if (cursor !== null && lastIndexKey === cursor) throw new EdoFeedStuck(cursor);

      const existing = downloads
        ? await loadExisting(
            deps.db,
            params.accountId,
            events.flatMap((e) => (e.Message ? [e.Message.MessageId] : [])),
          )
        : new Map<string, Existing>();
      const census: CensusRow[] = [];

      for (const event of events) {
        summary.eventsSeen += 1;
        const time = resolveEventTime(event).at?.toISOString() ?? null;
        if (time) {
          if (!summary.from || time < summary.from) summary.from = time;
          if (!summary.to || time > summary.to) summary.to = time;
        }
        if (!event.Message) continue;
        const classified = classifyMessageEntities(event.Message, params.boxId);
        if (classified.skipped) continue;

        if (params.census) {
          const messageHasUtd = classified.entities.some(selectForExport);
          for (const entity of classified.entities) {
            if (selectForCensus(entity)) {
              census.push(censusRow(params.accountId, event.Message, entity, messageHasUtd));
            }
          }
        }
        if (!downloads) continue;

        for (const entity of classified.entities) {
          if (!selectForExport(entity)) continue;
          summary.candidates += 1;
          const messageId = event.Message.MessageId;
          const key = rowKey(messageId, entity.entityId);
          if (handled.has(key)) continue;
          handled.add(key);
          const known = existing.get(key);
          if (known?.status === 'stored') {
            summary.alreadyStored += 1;
            continue;
          }
          if (known?.status === 'failed') {
            summary.failedKnown += 1;
            continue;
          }
          if (
            params.suppliers !== null &&
            known?.status === 'not_in_list' &&
            known.sellerInns.length > 0 &&
            !known.sellerInns.some((inn) => params.suppliers!.has(inn))
          ) {
            summary.notInListKnown += 1;
            continue;
          }

          await ensureLease();
          summary.downloads += 1;
          const outcome = await exportEntity(deps, params, messageId, entity);
          if (outcome === 'stored') summary.stored += 1;
          else if (outcome === 'not_in_list') summary.notInList += 1;
          else summary.failed += 1;
        }
      }

      if (census.length) {
        const inserted = await deps.db
          .insert(edoExportCensus)
          .values(census)
          .onConflictDoNothing({
            target: [edoExportCensus.edoAccountId, edoExportCensus.messageId, edoExportCensus.entityId],
          })
          .returning({ id: edoExportCensus.id });
        summary.census += inserted.length;
      }

      summary.pages += 1;
      params.onPage?.(summary);

      // Страница без ключа: продолжить с неё нельзя, а начать заново — значит
      // ходить по кругу. Честнее остановиться и сказать, что прочитано не всё.
      if (!lastIndexKey) {
        summary.truncated = true;
        summary.truncateReason = 'no_index_key';
        break;
      }
      await params.onPageDone?.(lastIndexKey);
      cursor = lastIndexKey;
      summary.lastIndexKey = lastIndexKey;
      if (
        summary.eventsSeen >= maxEvents ||
        (params.maxDownloads !== undefined && summary.downloads >= params.maxDownloads)
      ) {
        summary.truncated = true;
        summary.truncateReason = 'limit';
        break;
      }
    }
  } catch (err) {
    throw new EdoExportStopped(err, { ...summary });
  }

  deps.log.info({ boxId: params.boxId, ...summary }, 'edo export finished');
  return summary;
}

export type RetrySummary = {
  /** Взято на повтор. */
  picked: number;
  stored: number;
  notInList: number;
  failed: number;
  /** Закрыты окончательно: документа больше нет или он уже не УПД к выгрузке. */
  closed: number;
};

/** Сколько документов повторять за один проход: повтор не должен вытеснять ленту. */
export const RETRY_BATCH = 50;

/**
 * Проход повторов: документы со сбоем, чей срок подошёл, — по одному, через
 * карточку сообщения. Отдельно от ленты, потому что лента их уже прошла и
 * курсор назад не вернётся.
 *
 * Сбой связи останавливает проход (бросается наружу): повторы дождутся
 * следующего раза, ленту это не задерживает — она идёт раньше.
 */
export async function retryFailedExports(
  deps: ExportDeps,
  params: Pick<ExportParams, 'accountId' | 'boxId' | 'suppliers' | 'renewLease' | 'signal'> & {
    limit?: number;
  },
): Promise<RetrySummary> {
  const summary: RetrySummary = { picked: 0, stored: 0, notInList: 0, failed: 0, closed: 0 };
  const t = edoExportDocuments;
  const due = await deps.db
    .select({ id: t.id, messageId: t.messageId, entityId: t.entityId })
    .from(t)
    .where(
      and(
        eq(t.edoAccountId, params.accountId),
        eq(t.status, 'failed'),
        isNotNull(t.nextRetryAt),
        lte(t.nextRetryAt, drSql`now()`),
      ),
    )
    .orderBy(asc(t.nextRetryAt))
    .limit(params.limit ?? RETRY_BATCH);

  const close = async (id: string, reason: string) => {
    await deps.db
      .update(t)
      .set({ nextRetryAt: null, lastError: reason, updatedAt: new Date() })
      .where(and(eq(t.id, id), eq(t.status, 'failed')));
    summary.closed += 1;
  };

  for (const row of due) {
    if (params.signal?.aborted) throw new DiadocAborted();
    if (!(await params.renewLease())) throw new EdoLeaseLost();
    summary.picked += 1;

    let message: DiadocMessage;
    try {
      message = await deps.client.getMessage(params.boxId, row.messageId);
    } catch (err) {
      if (err instanceof DiadocGone) {
        await close(row.id, 'повтор: сообщение исчезло из Диадока');
        continue;
      }
      throw err;
    }
    const classified = classifyMessageEntities(message, params.boxId);
    const entity = classified.entities.find((e) => e.entityId === row.entityId);
    if (classified.skipped || !entity || !selectForExport(entity)) {
      const why = classified.skipped ?? (entity ? entity.reason : 'документа нет в сообщении');
      await close(row.id, `повтор: больше не УПД к выгрузке (${why})`);
      continue;
    }

    if (!(await params.renewLease())) throw new EdoLeaseLost();
    const outcome = await exportEntity(deps, params, row.messageId, entity);
    if (outcome === 'stored') summary.stored += 1;
    else if (outcome === 'not_in_list') summary.notInList += 1;
    else summary.failed += 1;
  }
  return summary;
}
