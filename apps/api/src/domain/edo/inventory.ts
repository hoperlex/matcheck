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
 */
import type { FastifyBaseLogger } from 'fastify';
import type { EdoInventoryReport } from '@matcheck/contracts';
import { classifyMessageEntities } from './diadoc.entities.js';
import type { DiadocClient } from './diadoc.client.js';
import { resolveEventTime } from './diadoc.types.js';

export type InventoryParams = {
  boxId: string;
  since: Date | null;
  /** Потолок обхода: разведка не должна превращаться в бесконечное чтение. */
  maxPages?: number;
  maxEvents?: number;
};

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_EVENTS = 2000;

type Bucket = {
  typeNamedId: string;
  function: string | null;
  version: string | null;
  formalized: boolean;
  count: number;
};

export async function inventoryBox(
  client: DiadocClient,
  params: InventoryParams,
  log: FastifyBaseLogger,
): Promise<EdoInventoryReport> {
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;

  const buckets = new Map<string, Bucket>();
  let cursor: string | null = null;
  let eventsSeen = 0;
  let entitiesSeen = 0;
  let truncated = false;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  // Сколько событий вообще имеют время и откуда оно взято. Без этого пустой
  // период в отчёте неотличим от «ящик пуст».
  let timedEvents = 0;
  let timeSource: 'event' | 'message' | null = null;

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
      if (classified.skipped) continue;

      for (const entity of classified.entities) {
        if (entity.route === 'ignored') continue;
        entitiesSeen += 1;
        const key = [
          entity.typeNamedId ?? 'unknown',
          entity.documentFunction ?? '',
          entity.documentVersion ?? '',
        ].join('|');
        const existing = buckets.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          buckets.set(key, {
            typeNamedId: entity.typeNamedId ?? 'unknown',
            function: entity.documentFunction,
            version: entity.documentVersion,
            formalized: entity.route === 'utd_xml',
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

  log.info(
    { boxId: params.boxId, eventsSeen, entitiesSeen, truncated },
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
  };
}
