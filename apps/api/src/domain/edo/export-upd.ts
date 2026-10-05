/**
 * Выгрузка УПД из ящика Диадока в хранилище — без карточек в портале.
 *
 * Зачем отдельно от импорта. Импорт ведёт журнал приёма (edo_events,
 * edo_receipts) и курсор ленты учётной записи; документ, отмеченный там
 * «сохранённым», импорт больше никогда не возьмёт. Выгрузка не пишет ни туда,
 * ни в курсор: её курсор — локальная переменная, её память — свой реестр
 * edo_export_documents. Будущий импорт эти документы не потеряет.
 *
 * Почему качается всё, а сохраняется не всё. ИНН отправителя в ленте нет — у
 * документа есть только ящик контрагента. Продавца надёжно называет только сам
 * XML, поэтому скачивается каждый УПД периода, а в хранилище ложатся только те,
 * чей продавец есть в списке. Остальные — строка реестра `not_in_list` с
 * реквизитами из XML: видно, что пришло и почему не взято.
 *
 * Повтор идемпотентен. `stored` не качается никогда; `not_in_list` не качается,
 * пока ни один из его продавцов не попал в список. Ключ в хранилище
 * детерминирован, так что обрыв между записью файла и строкой реестра лечится
 * тем же повтором: файл перезапишется теми же байтами.
 *
 * Лиз продлевается перед КАЖДЫМ запросом к Диадоку, а не раз в несколько
 * скачиваний: под лизом обменивается refresh_token, а худший запрос с ретраями
 * длится минуты — несколько таких подряд пережили бы лиз.
 */
import { and, eq, inArray, sql as drSql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { edoExportDocuments } from '../../db/schema.js';
import { buildEdoExportKey } from '../storage/s3.path.js';
import { fileHashOf } from '../sourceDocuments/bundle-key.js';
import type { DiadocClient } from './diadoc.client.js';
import { classifyMessageEntities, type ClassifiedEntity } from './diadoc.entities.js';
import { DiadocGone, DiadocPayloadTooLarge, DiadocRequestNotAllowed } from './diadoc.http.js';
import { resolveEventTime } from './diadoc.types.js';
import { classifyUtdContent } from './document-kind.js';
import { detectEdoFile } from './edo-file-kind.js';
import { EdoLeaseLost, isTransportFailure } from './inventory.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { parseUpdXml, type UpdParsed } from './upd.parser.js';

/** Типы документов, которые выгружаются: УПД любой функции и его исправление. */
export const EXPORT_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'UniversalTransferDocument',
  'UniversalTransferDocumentRevision',
]);

const DEFAULT_MAX_EVENTS = 100_000;

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
  /** Обход остановлен предохранителем — лента прочитана не до конца. */
  truncated: boolean;
};

export type ExportParams = {
  accountId: string;
  boxId: string;
  since: Date;
  /** Нормализованный ИНН → название из списка. */
  suppliers: ReadonlyMap<string, string>;
  /** Продлевает лиз; `false` — лиз потерян, работу надо прекратить. */
  renewLease: () => Promise<boolean>;
  maxEvents?: number;
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

/**
 * Продавцы документа и первый из них, кто есть в списке.
 *
 * Сравниваются цифры ИНН: формат допускает несколько продавцов, и взять
 * документ надо, если в списке хоть один.
 */
export function matchSupplier(
  parsed: Pick<UpdParsed, 'suppliers'>,
  list: ReadonlyMap<string, string>,
): { sellerInns: string[]; listed: { inn: string; name: string } | null } {
  const sellerInns = [
    ...new Set(parsed.suppliers.map((s) => s.inn.replace(/\D/g, '')).filter((inn) => inn.length > 0)),
  ];
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

function money(value: number | null): string | null {
  return value === null || !Number.isFinite(value) ? null : value.toFixed(2);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Row = typeof edoExportDocuments.$inferInsert;
type Existing = { status: string; sellerInns: string[] };

const rowKey = (messageId: string, entityId: string) => `${messageId}\u0000${entityId}`;

/** Строка реестра из метаданных — основа и для сбоя, и для разобранного XML. */
function baseRow(accountId: string, messageId: string, entity: ClassifiedEntity): Row {
  const metaDate = toIsoDate(entity.documentDate);
  return {
    edoAccountId: accountId,
    messageId,
    entityId: entity.entityId,
    counteragentBoxId: entity.counteragentBoxId,
    documentType: entity.typeNamedId ?? 'unknown',
    documentFunction: entity.documentFunction,
    documentNumber: entity.documentNumber,
    documentDate: metaDate ? new Date(`${metaDate}T00:00:00Z`) : null,
    correctionNumber: null,
    sellerInns: [],
    supplierInn: null,
    supplierName: null,
    totalSum: null,
    vatSum: null,
    itemsCount: null,
    contentCategory: null,
    receivedAt: entity.meta.receivedAt,
    status: 'failed',
    lastError: null,
    s3Key: null,
    contentSha256: null,
    sizeBytes: null,
  };
}

/**
 * Запись строки реестра. Строку `stored` не перезаписывает ничто: файл уже в
 * хранилище, и поздний сбой того же документа не должен её испортить.
 */
async function saveRow(db: Db, row: Row): Promise<void> {
  const { edoAccountId: _a, messageId: _m, entityId: _e, ...rest } = row;
  await db
    .insert(edoExportDocuments)
    .values(row)
    .onConflictDoUpdate({
      target: [edoExportDocuments.edoAccountId, edoExportDocuments.messageId, edoExportDocuments.entityId],
      set: { ...rest, updatedAt: new Date() },
      setWhere: drSql`${edoExportDocuments.status} <> 'stored'`,
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

type EntityOutcome = 'stored' | 'not_in_list' | 'failed';

/** Один документ: скачать, опознать продавца, сохранить или отметить. */
async function exportEntity(
  deps: ExportDeps,
  params: ExportParams,
  messageId: string,
  entity: ClassifiedEntity,
): Promise<EntityOutcome> {
  const row = baseRow(params.accountId, messageId, entity);
  const fail = async (reason: string): Promise<EntityOutcome> => {
    await saveRow(deps.db, { ...row, status: 'failed', lastError: reason });
    deps.log.warn({ messageId, entityId: entity.entityId, reason }, 'edo export: документ не выгружен');
    return 'failed';
  };

  let buffer: Buffer;
  try {
    buffer = await deps.client.getEntityContent(params.boxId, messageId, entity.entityId, deps.xmlMaxBytes);
  } catch (err) {
    // Связь, доступ, лимиты — не про этот документ: обход стоп, повтор продолжит.
    // Запрет пути — дефект кода, им испорчен был бы каждый следующий документ.
    if (isTransportFailure(err) || err instanceof DiadocRequestNotAllowed) throw err;
    if (err instanceof DiadocGone) return fail('документ исчез из Диадока');
    if (err instanceof DiadocPayloadTooLarge) {
      return fail(`файл больше ${Math.round(deps.xmlMaxBytes / 1024 / 1024)} МБ`);
    }
    return fail(`скачивание: ${errorText(err)}`);
  }

  const kind = detectEdoFile(buffer, entity.fileName);
  if (kind.ext !== 'xml') return fail(`вложение не XML (${kind.mimeType})`);

  let parsed: UpdParsed;
  try {
    parsed = parseUpdXml(decodeXmlBuffer(buffer));
  } catch (err) {
    return fail(`разбор: ${errorText(err)}`);
  }

  const { sellerInns, listed } = matchSupplier(parsed, params.suppliers);
  const supplierInn = listed?.inn ?? sellerInns[0] ?? null;
  const seller =
    parsed.suppliers.find((s) => s.inn.replace(/\D/g, '') === supplierInn) ?? parsed.supplier;
  const docDate = toIsoDate(parsed.docDate);
  const docNumber = parsed.docNumber.trim() || entity.documentNumber;

  const parsedRow: Row = {
    ...row,
    documentFunction: parsed.function ?? entity.documentFunction,
    documentNumber: docNumber,
    documentDate: docDate ? new Date(`${docDate}T00:00:00Z`) : row.documentDate,
    correctionNumber: parsed.correction?.number ?? null,
    sellerInns,
    supplierInn,
    supplierName: seller.name || null,
    totalSum: money(parsed.totalSum),
    vatSum: money(parsed.vatSum),
    itemsCount: parsed.items.length,
    contentCategory: classifyUtdContent(parsed).category,
  };

  if (!listed) {
    await saveRow(deps.db, { ...parsedRow, status: 'not_in_list' });
    return 'not_in_list';
  }

  const key = buildEdoExportKey({
    inn: listed.inn,
    docDate: docDate ?? toIsoDate(entity.documentDate),
    docNumber,
    entityId: entity.entityId,
  });
  const sha256 = fileHashOf(buffer);
  // Байты как пришли, в исходной кодировке: это подписанный оригинал.
  try {
    await deps.put(key, buffer, 'application/xml', { sha256 });
  } catch (err) {
    throw new EdoExportStorageFailed(key, err);
  }
  await saveRow(deps.db, {
    ...parsedRow,
    status: 'stored',
    s3Key: key,
    contentSha256: sha256,
    sizeBytes: buffer.length,
  });
  return 'stored';
}

export async function exportUpdFromBox(deps: ExportDeps, params: ExportParams): Promise<ExportSummary> {
  const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
  const summary: ExportSummary = {
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
    truncated: false,
  };

  const ensureLease = async () => {
    if (!(await params.renewLease())) throw new EdoLeaseLost();
  };

  let cursor: string | null = null;
  try {
    for (;;) {
      await ensureLease();
      const { events } = await deps.client.getNewEvents({
        boxId: params.boxId,
        afterIndexKey: cursor,
        fromTimestamp: params.since,
      });
      if (events.length === 0) break;
      const lastIndexKey = events[events.length - 1]?.IndexKey ?? null;
      if (cursor !== null && lastIndexKey === cursor) throw new EdoFeedStuck(cursor);

      const existing = await loadExisting(
        deps.db,
        params.accountId,
        events.flatMap((e) => (e.Message ? [e.Message.MessageId] : [])),
      );

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

        for (const entity of classified.entities) {
          if (!selectForExport(entity)) continue;
          summary.candidates += 1;
          const messageId = event.Message.MessageId;
          const known = existing.get(rowKey(messageId, entity.entityId));
          if (known?.status === 'stored') {
            summary.alreadyStored += 1;
            continue;
          }
          if (
            known?.status === 'not_in_list' &&
            known.sellerInns.length > 0 &&
            !known.sellerInns.some((inn) => params.suppliers.has(inn))
          ) {
            summary.notInListKnown += 1;
            continue;
          }

          await ensureLease();
          const outcome = await exportEntity(deps, params, messageId, entity);
          if (outcome === 'stored') summary.stored += 1;
          else if (outcome === 'not_in_list') summary.notInList += 1;
          else summary.failed += 1;
        }
      }

      summary.pages += 1;
      params.onPage?.(summary);

      // Страница без ключа: продолжить с неё нельзя, а начать заново — значит
      // ходить по кругу. Честнее остановиться и сказать, что прочитано не всё.
      if (!lastIndexKey) {
        summary.truncated = true;
        break;
      }
      cursor = lastIndexKey;
      if (summary.eventsSeen >= maxEvents) {
        summary.truncated = true;
        break;
      }
    }
  } catch (err) {
    throw new EdoExportStopped(err, { ...summary });
  }

  deps.log.info({ boxId: params.boxId, ...summary }, 'edo export finished');
  return summary;
}
