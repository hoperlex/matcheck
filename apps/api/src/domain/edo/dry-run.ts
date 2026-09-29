/**
 * Пробный разбор: показать, что вычитается из настоящих документов ящика, не
 * создавая ни одной карточки.
 *
 * Зачем отдельный режим. До сих пор выбор был из двух крайностей: разведка,
 * которая считает только типы документов, и импорт, который сразу пишет в
 * `source_documents`. Между ними не было ничего, а разбор XML на боевых данных
 * не выполнялся ни разу — в базе за всю историю ноль документов с ручного
 * XML-маршрута. Пускать такой разбор прямо в рабочий список значит проверять
 * его на живых данных постфактум.
 *
 * Здесь НИЧЕГО не сохраняется: ни файлов в хранилище, ни квитанций, ни
 * документов, ни курсора. Содержимое скачивается в память, разбирается и
 * превращается в отчёт, который возвращается вызывающему и нигде не оседает.
 *
 * Отбор тот же, что у импорта: по метаданным отсеиваются счета, акты и сканы,
 * по содержимому — УПД на работы и услуги. Отчёт показывает и то, что взято,
 * и то, что отсеяно, с причиной у каждого документа.
 *
 * Пределы жёсткие, потому что запрос синхронный и человек ждёт ответа в
 * браузере: страницы ленты, скачивания, результаты и общее время. По истечении
 * времени новые скачивания не начинаются, активные запросы отменяются, а отчёт
 * возвращается с тем, что успели, и пометкой «прервано по времени».
 */
import { sql as drSql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { EdoDryRunDocument, EdoDryRunReport } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import type { edoAccounts } from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import { createDiadocAuth } from './diadoc.auth.js';
import { describeFailure, type CheckFailure } from './check-access.js';
import { acquireEdoLease, releaseEdoLease } from './poll-lease.js';
import {
  classifyMessageEntities,
  isSignature,
  type ClassifiedEntity,
} from './diadoc.entities.js';
import { DiadocClient } from './diadoc.client.js';
import type { DiadocMessage } from './diadoc.types.js';
import {
  CONTENT_CATEGORY_LABELS,
  META_CATEGORY_LABELS,
  classifyUtdContent,
  type EdoMetaCategory,
} from './document-kind.js';
import { flattenForDisplay } from './document-meta.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { assessUpdParse, parseUpdXml, xmlOutline, type UpdParsed } from './upd.parser.js';

export type SupplierHistory = { deliveries: number; lastAt: string | null };

export type DryRunParams = {
  boxId: string;
  since: Date | null;
  /** Сколько УПД с материалами показать. Предел маленький намеренно: это проба. */
  limit?: number;
  /** Сколько документов скачать всего: материалы и отсеянные по содержимому. */
  maxDownloads?: number;
  maxPages?: number;
  maxEvents?: number;
  /** Общий предел времени операции на сервере. */
  deadlineMs?: number;
  /** Сколько сканов без типа показать — только метаданными, без скачивания. */
  maxScans?: number;
  /** Подсказка из портала: возил ли поставщик материалы раньше. */
  supplierHistory?: (inn: string) => Promise<SupplierHistory | null>;
};

const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_DOWNLOADS = 10;
const DEFAULT_MAX_PAGES = 3;
const DEFAULT_MAX_EVENTS = 300;
/** Браузер ждёт 180 с; сервер укладывается в 150, чтобы ответ успел доехать. */
export const DRY_RUN_DEADLINE_MS = 150_000;
const DEFAULT_MAX_SCANS = 2;
/** Позиций в отчёте по каждому документу: достаточно, чтобы увидеть форму. */
const SAMPLE_ITEMS = 5;
const DIADOC_FIELDS_LIMIT = 150;
const XML_OUTLINE_LIMIT = 300;

type Document = EdoDryRunDocument;
type Meta = Document['meta'];

/**
 * Даты у сторон записаны по-разному: Диадок отдаёт `01.09.2026`, а парсер
 * приводит дату к `2026-09-01`. Без приведения к одному виду расхождением
 * оказался бы КАЖДЫЙ документ, и сигнал, ради которого сверка затевалась,
 * утонул бы в ложных срабатываниях.
 */
function normalizeDate(value: string): string {
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  return ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : value.trim();
}

/** Сравнивает то, что сообщил Диадок, с тем, что вычитано из содержимого. */
function findMismatches(meta: ClassifiedEntity, parsed: { docNumber: string; docDate: string }): string[] {
  const out: string[] = [];
  const metaNumber = meta.documentNumber?.trim();
  const metaDate = meta.documentDate?.trim();

  if (metaNumber && metaNumber !== parsed.docNumber.trim()) {
    out.push(`номер: у Диадока «${metaNumber}», в XML «${parsed.docNumber.trim()}»`);
  }
  if (metaDate && normalizeDate(metaDate) !== normalizeDate(parsed.docDate)) {
    out.push(`дата: у Диадока «${metaDate}», в XML «${parsed.docDate.trim()}»`);
  }
  return out;
}

function metaOf(entity: ClassifiedEntity): Meta {
  return {
    typeNamedId: entity.typeNamedId,
    function: entity.documentFunction,
    version: entity.documentVersion,
    documentNumber: entity.documentNumber,
    documentDate: entity.documentDate,
    numberSource: entity.meta.numberSource,
    totalSum: entity.meta.totalSum,
    fileName: entity.fileName,
    counteragentBoxId: entity.counteragentBoxId,
    receivedAt: entity.meta.receivedAt?.toISOString() ?? null,
    receivedAtSource: entity.meta.receivedAtSource,
    isTest: entity.meta.isTest,
    revocationStatus: entity.meta.revocationStatus,
    senderSignatureStatus: entity.meta.senderSignatureStatus,
  };
}

/** Сырые поля сообщения и сущности — «что сообщает Диадок». */
function diadocFieldsOf(message: DiadocMessage, entityId: string) {
  const { Entities, ...messageFields } = message;
  const entity = Entities.find((e) => e.EntityId === entityId);
  return flattenForDisplay({ Message: messageFields, Entity: entity }, DIADOC_FIELDS_LIMIT);
}

const MASS_OR_VOLUME = /^(т|тн|тонн[аы]?|кг|м3|м³)\.?$/i;

/**
 * Чего в УПД нет, а карточке нужно. Подсказка — откуда это можно взять.
 */
function missingForCard(parsed: UpdParsed): Document['missingForCard'] {
  const out: Document['missingForCard'] = [];
  const consignee = parsed.consignee;
  out.push({
    field: 'Объект',
    hint: consignee
      ? `в УПД объекта нет; грузополучатель: ${[consignee.name, consignee.address].filter(Boolean).join(', ')}`
      : 'в УПД объекта нет, грузополучатель не указан — объект выбирает мониторинг',
  });
  out.push({
    field: 'Ожидаемая дата',
    hint: parsed.transfer?.date
      ? `в УПД её нет; дата отгрузки — ${parsed.transfer.date}`
      : `в УПД её нет; дата документа — ${parsed.docDate || '—'}`,
  });
  const measured = parsed.items.filter((i) => MASS_OR_VOLUME.test(i.unit.trim())).length;
  out.push({
    field: 'Объём и масса',
    hint:
      measured === parsed.items.length && measured > 0
        ? 'все позиции уже в тоннах или кубометрах'
        : `в XML только количество и единица; досчитать для ${parsed.items.length - measured} из ${parsed.items.length} позиций`,
  });
  return out;
}

function parsedView(parsed: UpdParsed): NonNullable<Document['parsed']> {
  return {
    docNumber: parsed.docNumber,
    docDate: parsed.docDate,
    correction: parsed.correction,
    supplier: parsed.supplier,
    suppliers: parsed.suppliers,
    recipient: parsed.recipient,
    buyers: parsed.buyers,
    consignorSameAsSeller: parsed.consignorSameAsSeller,
    consignor: parsed.consignor,
    consignee: parsed.consignee,
    transfer: parsed.transfer,
    shippingDocs: parsed.shippingDocs,
    itemsCount: parsed.items.length,
    totalSum: parsed.totalSum,
    totalExVat: parsed.totalExVat,
    vatSum: parsed.vatSum,
    formatVersion: parsed.formatVersion,
    function: parsed.function,
    currencyCode: parsed.currencyCode,
    sampleItems: parsed.items.slice(0, SAMPLE_ITEMS).map((i) => ({
      lineNo: i.lineNo,
      name: i.nameRaw,
      qty: i.qty,
      unit: i.unit,
      price: i.price,
      sum: i.sum,
      sumExVat: i.sumExVat,
      vatRate: i.vatRate,
      kind: i.kind,
      productCode: i.productCode,
    })),
  };
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countsToList(map: Map<string, number>, labels: Record<string, string>) {
  return [...map.entries()]
    .map(([category, count]) => ({ category, label: labels[category] ?? category, count }))
    .sort((a, b) => b.count - a.count);
}

const UNREAD = 'unread';
const CONTENT_LABELS: Record<string, string> = {
  ...CONTENT_CATEGORY_LABELS,
  [UNREAD]: 'не удалось прочитать',
};

export async function dryRunBox(
  client: DiadocClient,
  params: DryRunParams,
  log: FastifyBaseLogger,
): Promise<EdoDryRunReport> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const maxDownloads = params.maxDownloads ?? DEFAULT_MAX_DOWNLOADS;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxScans = params.maxScans ?? DEFAULT_MAX_SCANS;

  // Один сигнал на всю операцию: он уходит в каждый запрос к Диадоку, и по
  // истечении времени отменяет и ожидание ленты, и скачивание.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.deadlineMs ?? DRY_RUN_DEADLINE_MS);
  const signal = controller.signal;

  const documents: Document[] = [];
  const scans: EdoDryRunReport['scans'] = [];
  const byMeta = new Map<string, number>();
  const byContent = new Map<string, number>();
  let cursor: string | null = null;
  let eventsSeen = 0;
  let candidates = 0;
  let materials = 0;
  let interrupted: 'deadline' | null = null;

  try {
    outer: for (let page = 0; page < maxPages; page++) {
      let events;
      try {
        ({ events } = await client.getNewEvents({
          boxId: params.boxId,
          afterIndexKey: cursor,
          fromTimestamp: params.since,
          signal,
        }));
      } catch (err) {
        if (signal.aborted) {
          interrupted = 'deadline';
          break;
        }
        throw err;
      }
      if (events.length === 0) break;

      for (const event of events) {
        eventsSeen += 1;
        const message = event.Message;
        if (!message) continue;

        const classified = classifyMessageEntities(message, params.boxId);
        if (classified.skipped) {
          // Сообщение пропущено целиком (исходящее, тестовое…): его документы
          // считаем исключёнными, чтобы итог отбора сходился с ящиком.
          for (const e of message.Entities) if (!isSignature(e)) bump(byMeta, 'excluded');
          continue;
        }

        for (const entity of classified.entities) {
          if (entity.route === 'ignored' || !entity.category) continue;
          bump(byMeta, entity.category);

          if (entity.category === 'scan' && scans.length < maxScans) {
            scans.push({
              messageId: message.MessageId,
              entityId: entity.entityId,
              meta: metaOf(entity),
              reason: entity.reason,
              diadocFields: diadocFieldsOf(message, entity.entityId),
            });
          }
          if (entity.route !== 'utd_xml') continue;

          candidates += 1;
          if (interrupted || materials >= limit || documents.length >= maxDownloads) continue;
          if (signal.aborted) {
            interrupted = 'deadline';
            continue;
          }

          const doc = await examine(client, params.boxId, message, entity, signal);
          if (signal.aborted) interrupted = 'deadline';
          documents.push(doc);
          bump(byContent, doc.content?.category ?? UNREAD);
          if (doc.content?.category === 'materials') materials += 1;
        }

        if (eventsSeen >= maxEvents) break outer;
      }

      if (interrupted) break;
      const lastIndexKey = events[events.length - 1]?.IndexKey ?? null;
      if (!lastIndexKey) break;
      cursor = lastIndexKey;
    }
  } finally {
    clearTimeout(timer);
  }

  // Подсказка из портала — отдельным шагом: это наша база, а не Диадок, и
  // ждать её под пределом времени ленты незачем.
  if (params.supplierHistory) {
    for (const doc of documents) {
      if (!doc.parsed) continue;
      doc.supplierHistory = await params.supplierHistory(doc.parsed.supplier.inn).catch(() => null);
    }
  }

  // В журнал — только счётчики: в отчёте лежат реквизиты и позиции документов.
  log.info(
    { boxId: params.boxId, eventsSeen, candidates, examined: documents.length, interrupted },
    'edo dry-run finished',
  );

  // Упёрлись в предел обхода — значит «не нашли» относится к просмотренному
  // отрезку, а не ко всему ящику. Без этого пустой отчёт неотличим от сбоя.
  return {
    eventsSeen,
    candidates,
    examined: documents.length,
    truncated: eventsSeen >= maxEvents,
    interrupted,
    selection: {
      byMeta: countsToList(byMeta, META_CATEGORY_LABELS as Record<EdoMetaCategory, string>),
      byContent: countsToList(byContent, CONTENT_LABELS),
    },
    documents,
    scans,
  };
}

/** Скачивает один документ, разбирает его и складывает результат в отчёт. */
async function examine(
  client: DiadocClient,
  boxId: string,
  message: DiadocMessage,
  entity: ClassifiedEntity,
  signal: AbortSignal,
): Promise<Document> {
  const base: Document = {
    messageId: message.MessageId,
    entityId: entity.entityId,
    meta: metaOf(entity),
    content: null,
    parsed: null,
    accepted: false,
    reasons: [],
    mismatches: [],
    sizeBytes: null,
    diadocFields: diadocFieldsOf(message, entity.entityId),
    xmlOutline: [],
    missingForCard: [],
    supplierHistory: null,
  };

  let buffer: Buffer;
  try {
    buffer = await client.getEntityContent(boxId, message.MessageId, entity.entityId, undefined, {
      signal,
    });
  } catch (err) {
    const reason = signal.aborted
      ? 'не скачан: истёк предел времени пробного разбора'
      : `не удалось скачать: ${err instanceof Error ? err.message : String(err)}`;
    return { ...base, reasons: [reason] };
  }

  const xml = decodeXmlBuffer(buffer);
  let outline: string[] = [];
  try {
    outline = xmlOutline(xml, XML_OUTLINE_LIMIT);
  } catch {
    // Не XML вовсе — это покажет разбор ниже.
  }

  try {
    const parsed = parseUpdXml(xml);
    const content = classifyUtdContent(parsed);
    const assessment = assessUpdParse(parsed);
    const reasons = assessment.ok ? [] : [...assessment.reasons];
    if (content.category !== 'materials') {
      reasons.unshift(`не материалы: ${CONTENT_CATEGORY_LABELS[content.category]}`);
    }
    return {
      ...base,
      content: {
        category: content.category,
        label: CONTENT_CATEGORY_LABELS[content.category],
        reason: content.reason,
        kinds: content.kinds,
      },
      parsed: parsedView(parsed),
      accepted: content.category === 'materials' && assessment.ok,
      reasons,
      mismatches: findMismatches(entity, parsed),
      sizeBytes: buffer.length,
      xmlOutline: outline,
      missingForCard: missingForCard(parsed),
    };
  } catch (err) {
    // Разбор упал — это тоже результат пробы, и он важнее всего остального.
    return {
      ...base,
      reasons: [`разбор не удался: ${err instanceof Error ? err.message : String(err)}`],
      sizeBytes: buffer.length,
      xmlOutline: outline,
    };
  }
}

/**
 * Возил ли поставщик материалы на объекты раньше: сколько приёмок привязано к
 * его документам и когда была последняя. Только подсказка к отбору — решение
 * по-прежнему принимают тип документа и его позиции.
 */
export async function supplierHistoryFromDb(db: Db, inn: string): Promise<SupplierHistory | null> {
  const rows = await db.execute<{ deliveries: number; last_at: Date | string | null }>(drSql`
    select count(distinct ds.delivery_id)::int as deliveries, max(d.arrived_at) as last_at
    from source_documents sd
    join delivery_sources ds on ds.source_document_id = sd.id
    join deliveries d on d.id = ds.delivery_id
    where sd.supplier_inn_raw = ${inn}
       or sd.supplier_directory_id in (select s.id from suppliers s where s.inn = ${inn})
  `);
  const row = rows[0];
  if (!row) return null;
  const lastAt = row.last_at ? new Date(row.last_at).toISOString() : null;
  return { deliveries: Number(row.deliveries) || 0, lastAt };
}

/**
 * Пробный разбор для учётной записи: лиз, авторизация, обход, отчёт.
 *
 * Лиз обязателен по той же причине, что и у проверки доступа: под работой
 * обменивается refresh_token, и два параллельных обмена оставили бы один из
 * проходов со значением, которое сервер уже считает отработанным.
 */
export async function runEdoDryRun(
  db: Db,
  account: typeof edoAccounts.$inferSelect,
  log: FastifyBaseLogger,
  opts: {
    since?: Date | null;
    limit?: number;
    /** Клиент Диадока — для тестов; по умолчанию настоящий. */
    createClient?: (account: typeof edoAccounts.$inferSelect) => DiadocClient;
  } = {},
): Promise<{ value: EdoDryRunReport } | CheckFailure> {
  if (!account.boxId) {
    return {
      error: 'box_not_selected',
      status: 409,
      message: 'Ящик не выбран: сначала выполните «Проверить доступ» и выберите ящик.',
    };
  }

  const env = loadEnv();
  const lease = await acquireEdoLease(db, {
    accountId: account.id,
    owner: crypto.randomUUID(),
    // Лиз переживает предел времени разбора с запасом, но не держит учётку
    // дольше, чем ждёт браузер.
    ttlSeconds: Math.min(env.EDO_POLL_LEASE_SEC, 180),
    requirePollEnabled: false,
  });
  if (!lease) {
    return {
      error: 'lease_taken',
      status: 409,
      message: 'Учётная запись сейчас занята другой работой. Повторите через минуту.',
    };
  }

  try {
    const client = opts.createClient
      ? opts.createClient(account)
      : new DiadocClient({ auth: createDiadocAuth({ db }, account), environment: account.environment });
    const report = await dryRunBox(
      client,
      {
        boxId: account.boxId,
        since: opts.since ?? account.backfillSince ?? null,
        limit: opts.limit,
        supplierHistory: (inn) => supplierHistoryFromDb(db, inn),
      },
      log,
    );
    return { value: report };
  } catch (err) {
    // Причину показываем тем же языком, что и у проверки доступа: коды сервиса
    // авторизации и отказы Диадока там уже переведены на человеческий.
    log.warn({ err, accountId: account.id }, 'edo dry-run failed');
    return describeFailure(err);
  } finally {
    await releaseEdoLease(db, lease).catch(() => {});
  }
}
