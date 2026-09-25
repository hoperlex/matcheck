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
 * Отдельная ценность — сверка с метаданными. Диадок сообщает номер и дату
 * документа сам, до чтения содержимого; если они расходятся с тем, что вычитал
 * парсер, значит он читает не те поля. Это гораздо более ранний сигнал, чем
 * «суммы не сходятся».
 */
import type { FastifyBaseLogger } from 'fastify';
import type { EdoDryRunReport } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import type { edoAccounts } from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import { createDiadocAuth } from './diadoc.auth.js';
import { describeFailure, type CheckFailure } from './check-access.js';
import { acquireEdoLease, releaseEdoLease } from './poll-lease.js';
import { classifyMessageEntities, type ClassifiedEntity } from './diadoc.entities.js';
import { DiadocClient } from './diadoc.client.js';
import { decodeXmlBuffer } from './upd-xml-decode.js';
import { assessUpdParse, parseUpdXml } from './upd.parser.js';

export type DryRunParams = {
  boxId: string;
  since: Date | null;
  /** Сколько документов разобрать. Предел маленький намеренно: это проба. */
  limit?: number;
  maxPages?: number;
  maxEvents?: number;
};

const DEFAULT_LIMIT = 5;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_EVENTS = 500;
/** Позиций в отчёте по каждому документу: достаточно, чтобы увидеть форму. */
const SAMPLE_ITEMS = 3;

type Document = EdoDryRunReport['documents'][number];

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

export async function dryRunBox(
  client: DiadocClient,
  params: DryRunParams,
  log: FastifyBaseLogger,
): Promise<EdoDryRunReport> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const maxEvents = params.maxEvents ?? DEFAULT_MAX_EVENTS;

  const documents: Document[] = [];
  let cursor: string | null = null;
  let eventsSeen = 0;
  let candidates = 0;

  outer: for (let page = 0; page < maxPages; page++) {
    const { events } = await client.getNewEvents({
      boxId: params.boxId,
      afterIndexKey: cursor,
      fromTimestamp: params.since,
    });
    if (events.length === 0) break;

    for (const event of events) {
      eventsSeen += 1;
      if (!event.Message) continue;

      const classified = classifyMessageEntities(event.Message, params.boxId);
      if (classified.skipped) continue;

      for (const entity of classified.entities) {
        // Берём только формализованные УПД: неформализованные вложения этот
        // разбор не касается, для них свой маршрут распознавания.
        if (entity.route !== 'utd_xml') continue;
        candidates += 1;
        if (documents.length >= limit) continue;

        documents.push(await examine(client, params.boxId, event.Message.MessageId, entity));
      }

      if (eventsSeen >= maxEvents) break outer;
    }

    const lastIndexKey = events[events.length - 1]?.IndexKey ?? null;
    if (!lastIndexKey) break;
    cursor = lastIndexKey;
  }

  // В журнал — только счётчики: в отчёте лежат реквизиты и позиции документов.
  log.info(
    { boxId: params.boxId, eventsSeen, candidates, examined: documents.length },
    'edo dry-run finished',
  );

  return { eventsSeen, candidates, examined: documents.length, documents };
}

/** Скачивает один документ, разбирает его и складывает результат в отчёт. */
async function examine(
  client: DiadocClient,
  boxId: string,
  messageId: string,
  entity: ClassifiedEntity,
): Promise<Document> {
  const meta = {
    typeNamedId: entity.typeNamedId,
    function: entity.documentFunction,
    version: entity.documentVersion,
    documentNumber: entity.documentNumber,
    documentDate: entity.documentDate,
    fileName: entity.fileName,
    counteragentBoxId: entity.counteragentBoxId,
  };

  let buffer: Buffer;
  try {
    buffer = await client.getEntityContent(boxId, messageId, entity.entityId);
  } catch (err) {
    return {
      messageId,
      entityId: entity.entityId,
      meta,
      parsed: null,
      accepted: false,
      reasons: [`не удалось скачать: ${err instanceof Error ? err.message : String(err)}`],
      mismatches: [],
      sizeBytes: null,
    };
  }

  try {
    const parsed = parseUpdXml(decodeXmlBuffer(buffer));
    const assessment = assessUpdParse(parsed);
    return {
      messageId,
      entityId: entity.entityId,
      meta,
      parsed: {
        docNumber: parsed.docNumber,
        docDate: parsed.docDate,
        supplier: parsed.supplier,
        recipient: parsed.recipient,
        itemsCount: parsed.items.length,
        totalSum: parsed.totalSum,
        vatSum: parsed.vatSum,
        sampleItems: parsed.items.slice(0, SAMPLE_ITEMS).map((i) => ({
          lineNo: i.lineNo,
          name: i.nameRaw,
          qty: i.qty,
          unit: i.unit,
          price: i.price,
          sum: i.sum,
          vatRate: i.vatRate,
        })),
      },
      accepted: assessment.ok,
      reasons: assessment.ok ? [] : assessment.reasons,
      mismatches: findMismatches(entity, parsed),
      sizeBytes: buffer.length,
    };
  } catch (err) {
    // Разбор упал — это тоже результат пробы, и он важнее всего остального.
    return {
      messageId,
      entityId: entity.entityId,
      meta,
      parsed: null,
      accepted: false,
      reasons: [`разбор не удался: ${err instanceof Error ? err.message : String(err)}`],
      mismatches: [],
      sizeBytes: buffer.length,
    };
  }
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
  opts: { since?: Date | null; limit?: number } = {},
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
    const auth = createDiadocAuth({ db }, account);
    const client = new DiadocClient({ auth, environment: account.environment });
    const report = await dryRunBox(
      client,
      {
        boxId: account.boxId,
        since: opts.since ?? account.backfillSince ?? null,
        limit: opts.limit,
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
