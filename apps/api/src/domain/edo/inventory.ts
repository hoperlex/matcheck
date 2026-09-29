/**
 * Разведка ящика: что в нём лежит, без единого импорта.
 *
 * Зачем это первым делом. Заранее неизвестно, шлют ли контрагенты нормальный
 * формализованный ЭДО или грузят в Диадок сканы. От ответа зависит, нужен ли
 * вообще маршрут распознавания и в каком объёме. Выяснять это импортом — значит
 * сперва наполнить портал карточками, а потом разбираться, правильные ли они.
 *
 * Операция ничего не пишет, кроме собственного отчёта: ни квитанций, ни
 * документов, ни курсора. Её можно безопасно запускать на боевом ящике.
 *
 * Отчёт отвечает и на вопрос «что из этого мы бы взяли»: каждому типу
 * документа — решение отбора по метаданным. С галочкой «Проверить содержимое»
 * осмотр скачивает до сотни УПД-кандидатов в память и показывает, какая доля
 * из них — материалы, а какая — работы и услуги.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { EdoInventoryReport } from '@matcheck/contracts';
import { DiadocAuthConflict } from './diadoc.auth.js';
import { classifyMessageEntities, isSignature } from './diadoc.entities.js';
import type { DiadocClient, DiadocDocumentTypeInfo } from './diadoc.client.js';
import {
  DiadocAccessDenied,
  DiadocAuthExpired,
  DiadocRateLimited,
  DiadocSubscriptionExpired,
  DiadocTransient,
} from './diadoc.http.js';
import { resolveEventTime, type EventTimeSource } from './diadoc.types.js';
import {
  CONTENT_CATEGORY_LABELS,
  META_CATEGORY_LABELS,
  classifyUtdContent,
  type EdoMetaCategory,
} from './document-kind.js';
import { buildFormalityLookup } from './document-types.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { parseUpdXml } from './upd.parser.js';

/** Проверка содержимого не может продолжаться: лиз учётной записи потерян. */
export class EdoLeaseLost extends Error {
  constructor() {
    super('лиз учётной записи потерян: осмотр остановлен, отчёт не сохранён');
    this.name = 'EdoLeaseLost';
  }
}

export type ContentCheckParams = {
  /** Сколько УПД-кандидатов скачать. */
  maxDownloads: number;
  /** Общий предел времени проверки содержимого. */
  deadlineMs: number;
  /** Продлевает лиз; `false` — лиз потерян, работу надо прекратить. */
  renewLease: () => Promise<boolean>;
  /** Каждые сколько скачиваний продлевать лиз. */
  renewEvery?: number;
};

export type InventoryParams = {
  boxId: string;
  since: Date | null;
  /** Потолок обхода: разведка не должна превращаться в бесконечное чтение. */
  maxPages?: number;
  maxEvents?: number;
  contentCheck?: ContentCheckParams;
};

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_EVENTS = 2000;
const DEFAULT_RENEW_EVERY = 10;

type Bucket = EdoInventoryReport['byType'][number];

/** Отказы связи и доступа: осмотр по ним останавливается, а не копит «не прочитано». */
function isTransportFailure(err: unknown): boolean {
  return (
    err instanceof DiadocRateLimited ||
    err instanceof DiadocTransient ||
    err instanceof DiadocAuthExpired ||
    err instanceof DiadocAccessDenied ||
    err instanceof DiadocSubscriptionExpired ||
    err instanceof DiadocAuthConflict
  );
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function countsToList(map: Map<string, number>, labels: Record<string, string>) {
  return [...map.entries()]
    .map(([category, count]) => ({ category, label: labels[category] ?? category, count }))
    .sort((a, b) => b.count - a.count);
}

export async function inventoryBox(
  client: DiadocClient,
  params: InventoryParams,
  log: FastifyBaseLogger,
): Promise<EdoInventoryReport> {
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;

  // Справочник типов — вспомогательный: без него «машиночитаемый» определяется
  // по версии формата, и осмотр от этого не падает.
  let types: DiadocDocumentTypeInfo[] | null = null;
  try {
    types = await client.getDocumentTypes(params.boxId);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'edo: справочник типов недоступен');
  }
  const formality = buildFormalityLookup(types);

  const buckets = new Map<string, Bucket>();
  const decisions = new Map<string, number>();
  const toCheck: { messageId: string; entityId: string }[] = [];
  let cursor: string | null = null;
  let eventsSeen = 0;
  let entitiesSeen = 0;
  let truncated = false;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  // Сколько событий вообще имеют время и откуда оно взято. Без этого пустой
  // период в отчёте неотличим от «ящик пуст».
  let timedEvents = 0;
  let timeSource: EventTimeSource | null = null;

  for (let page = 0; page < maxPages; page++) {
    const { events } = await client.getNewEvents({
      boxId: params.boxId,
      afterIndexKey: cursor,
      fromTimestamp: params.since,
    });
    if (events.length === 0) break;

    for (const event of events) {
      eventsSeen += 1;
      const time = resolveEventTime(event);
      if (time.at) {
        timedEvents += 1;
        timeSource = timeSource ?? time.source;
        if (!firstAt || time.at < firstAt) firstAt = time.at;
        if (!lastAt || time.at > lastAt) lastAt = time.at;
      }

      // Патчи без сообщения считаем как событие, но разбирать в них нечего.
      if (!event.Message) continue;

      const classified = classifyMessageEntities(event.Message, params.boxId);
      if (classified.skipped) {
        for (const e of event.Message.Entities) {
          if (isSignature(e)) continue;
          entitiesSeen += 1;
          bump(decisions, 'excluded');
        }
        continue;
      }

      for (const entity of classified.entities) {
        if (entity.route === 'ignored' || !entity.category) continue;
        entitiesSeen += 1;
        bump(decisions, entity.category);
        // Исключённые (тестовые, аннулированные…) в раскладку по типам не идут:
        // у типа одно решение, а исключение — свойство конкретного документа.
        if (entity.category === 'excluded') continue;

        if (
          entity.route === 'utd_xml' &&
          params.contentCheck &&
          toCheck.length < params.contentCheck.maxDownloads
        ) {
          toCheck.push({ messageId: event.Message.MessageId, entityId: entity.entityId });
        }

        const typeNamedId = entity.typeNamedId ?? 'unknown';
        const key = [typeNamedId, entity.documentFunction ?? '', entity.documentVersion ?? ''].join('|');
        const existing = buckets.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          const f = entity.typeNamedId
            ? formality(entity.typeNamedId, entity.documentFunction, entity.documentVersion)
            : { formalized: false, source: 'version' as const, title: null };
          buckets.set(key, {
            typeNamedId,
            title: f.title,
            function: entity.documentFunction,
            version: entity.documentVersion,
            formalized: f.formalized,
            formalizedSource: f.source,
            decision: entity.category,
            decisionLabel: META_CATEGORY_LABELS[entity.category],
            count: 1,
          });
        }
      }
    }

    const lastIndexKey = events[events.length - 1]?.IndexKey ?? null;
    if (!lastIndexKey) break;
    cursor = lastIndexKey;

    if (eventsSeen >= maxEvents) {
      truncated = true;
      break;
    }
    if (page === maxPages - 1) truncated = true;
  }

  const contentCheck = params.contentCheck
    ? await checkContent(client, params.boxId, toCheck, params.contentCheck, log)
    : null;

  log.info(
    {
      boxId: params.boxId,
      eventsSeen,
      entitiesSeen,
      truncated,
      checked: contentCheck?.checked ?? null,
    },
    'edo inventory finished',
  );

  return {
    from: firstAt?.toISOString() ?? null,
    to: lastAt?.toISOString() ?? null,
    eventsSeen,
    entitiesSeen,
    truncated,
    timedEvents,
    timeSource,
    byType: [...buckets.values()].sort((a, b) => b.count - a.count),
    decisions: countsToList(decisions, META_CATEGORY_LABELS as Record<EdoMetaCategory, string>),
    contentCheck,
  };
}

/**
 * Скачивает УПД-кандидатов в память по одному и считает, какие из них —
 * материалы. Ничего не сохраняет.
 *
 * Лиз продлевается по ходу: сотня скачиваний дольше, чем лиз живёт без
 * продления, а работа без лиза — это риск параллельного обмена refresh_token.
 * Не удалось продлить — прекращаем и сообщаем об этом исключением: отчёт по
 * такой проверке не должен сохраниться как успешный.
 */
async function checkContent(
  client: DiadocClient,
  boxId: string,
  toCheck: { messageId: string; entityId: string }[],
  params: ContentCheckParams,
  log: FastifyBaseLogger,
): Promise<NonNullable<EdoInventoryReport['contentCheck']>> {
  const renewEvery = params.renewEvery ?? DEFAULT_RENEW_EVERY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.deadlineMs);
  const signal = controller.signal;

  const byContent = new Map<string, number>();
  let checked = 0;
  let failed = 0;
  let interrupted: 'deadline' | null = null;

  try {
    for (let i = 0; i < toCheck.length; i++) {
      if (signal.aborted) {
        interrupted = 'deadline';
        break;
      }
      if (i > 0 && i % renewEvery === 0 && !(await params.renewLease())) {
        throw new EdoLeaseLost();
      }
      const { messageId, entityId } = toCheck[i]!;
      try {
        const buffer = await client.getEntityContent(boxId, messageId, entityId, undefined, { signal });
        const parsed = parseUpdXml(decodeXmlBuffer(buffer));
        bump(byContent, classifyUtdContent(parsed).category);
        checked += 1;
      } catch (err) {
        if (signal.aborted) {
          interrupted = 'deadline';
          break;
        }
        if (isTransportFailure(err)) throw err;
        // Сбой конкретного документа (исчез, не разобрался) — считаем и идём
        // дальше: одна битая выгрузка не должна обесценивать всю проверку.
        failed += 1;
        log.warn({ messageId, entityId, err: err instanceof Error ? err.message : String(err) }, 'edo: УПД не прочитан при осмотре');
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    limit: params.maxDownloads,
    checked,
    failed,
    byContent: countsToList(byContent, CONTENT_CATEGORY_LABELS),
    interrupted,
  };
}
