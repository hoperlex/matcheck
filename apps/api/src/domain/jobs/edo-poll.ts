/**
 * Проход по ленте событий одной учётной записи ЭДО.
 *
 * Что здесь важно не перепутать.
 *
 * ПОРЯДОК. События обрабатываются строго в порядке ответа, а курсор двигается
 * только по непрерывному префиксу доведённых до конца. Соблазн поставить курсор
 * на последнее успешное событие оборачивается потерей: застрявшее в середине
 * никто больше не заберёт, и документа в портале просто не будет — без ошибки и
 * без следа.
 *
 * ЧЬЯ ОШИБКА. Отказ Диадока (ограничение частоты, недоступность, просроченный
 * токен) не имеет отношения к конкретному документу: проход прерывается,
 * израсходованная попытка возвращается, курсор остаётся на месте. Бюджет
 * попыток тратят только сбои самого документа.
 *
 * ЧЕЙ ЯЩИК. Всё идёт под лизом учётной записи, и курсор записывается только
 * своим токеном. Под тем же лизом обменивается refresh-токен — два
 * параллельных обмена оставили бы один из процессов с отозванным значением.
 */
import { eq, and, sql as drSql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { edoAccounts } from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import { createDiadocAuth, DiadocAuthConflict } from '../edo/diadoc.auth.js';
import { DiadocClient } from '../edo/diadoc.client.js';
import {
  DiadocAccessDenied,
  DiadocAuthExpired,
  DiadocRateLimited,
  DiadocSubscriptionExpired,
  DiadocTransient,
} from '../edo/diadoc.http.js';
import { classifyMessageEntities } from '../edo/diadoc.entities.js';
import { resolveEventTime } from '../edo/diadoc.types.js';
import {
  advanceCursor,
  isEventTerminal,
  terminalPrefixLength,
  type EventState,
  type ReceiptState,
} from '../edo/event-cursor.js';
import {
  claimEvent,
  claimReceipt,
  closeExhaustedReceipt,
  finishEvent,
  loadReceiptsForEvent,
  markReceiptFailed,
  markReceiptSkipped,
  releaseReceiptAttempt,
  type EdoReceiptRow,
} from '../edo/journal.js';
import {
  EdoImportDisabled,
  EdoStorageUnavailable,
  ingestEdoEntity,
} from '../edo/ingest-document.js';
import { acquireEdoLease, releaseEdoLease, renewEdoLease } from '../edo/poll-lease.js';
import type { putObject } from '../storage/s3.signer.js';

export type EdoPollDeps = {
  db: Db;
  log: FastifyBaseLogger;
  owner: string;
  /** Подменяется в тестах: настоящий клиент ходит в Диадок. */
  createClient?: (account: typeof edoAccounts.$inferSelect) => DiadocClient;
  /** Подменяется в тестах, чтобы не ходить в хранилище. */
  put?: typeof putObject;
};

export type EdoPollResult = {
  skipped?:
    | 'lease_taken'
    | 'no_box'
    | 'not_found'
    | 'rate_limited'
    | 'auth_failed'
    | 'upstream'
    | 'storage'
    | 'import_disabled';
  events: number;
  imported: number;
  duplicates: number;
  awaiting: number;
  unparsed: number;
  skippedEntities: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
};

/**
 * Отказ не по вине документа: проход прекращается, попытка возвращается.
 *
 * Сюда относятся и хранилище (оно не приняло файл — документ ни при чём), и
 * выключенный импорт. Всё, чего здесь нет, считается сбоем конкретного
 * документа и расходует его попытку.
 */
function isTransportFailure(err: unknown): boolean {
  return (
    err instanceof DiadocRateLimited ||
    err instanceof DiadocTransient ||
    err instanceof DiadocAuthExpired ||
    err instanceof DiadocAccessDenied ||
    err instanceof DiadocSubscriptionExpired ||
    err instanceof DiadocAuthConflict ||
    err instanceof EdoStorageUnavailable ||
    err instanceof EdoImportDisabled
  );
}

function failureKind(err: unknown): EdoPollResult['skipped'] {
  if (err instanceof EdoImportDisabled) return 'import_disabled';
  if (err instanceof EdoStorageUnavailable) return 'storage';
  if (err instanceof DiadocRateLimited) return 'rate_limited';
  if (err instanceof DiadocAccessDenied || err instanceof DiadocSubscriptionExpired) {
    return 'auth_failed';
  }
  if (err instanceof DiadocAuthExpired || err instanceof DiadocAuthConflict) return 'auth_failed';
  return 'upstream';
}

/**
 * Записывает курсор — только под своим токеном лиза.
 *
 * Ноль обновлённых строк означает, что лиз перехвачен: продолжать нельзя,
 * иначе два процесса начнут двигать курсор друг за другом.
 */
async function saveCursor(
  db: Db,
  accountId: string,
  leaseToken: string,
  indexKey: string,
  lastEventAt: Date | null,
): Promise<boolean> {
  const rows = await db
    .update(edoAccounts)
    .set({
      lastIndexKey: indexKey,
      lastEventAt: lastEventAt ?? undefined,
      lastOkAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(edoAccounts.id, accountId), drSql`${edoAccounts.pollLeaseToken}::text = ${leaseToken}`))
    .returning({ id: edoAccounts.id });
  return rows.length > 0;
}

function receiptState(r: EdoReceiptRow): ReceiptState {
  return { transportStatus: r.transportStatus, attempts: r.attempts };
}

export async function pollEdoAccount(
  deps: EdoPollDeps,
  accountId: string,
  options: { manual?: boolean } = {},
): Promise<EdoPollResult> {
  const env = loadEnv();
  const empty: EdoPollResult = {
    events: 0,
    imported: 0,
    duplicates: 0,
    awaiting: 0,
    unparsed: 0,
    skippedEntities: 0,
    cursorBefore: null,
    cursorAfter: null,
  };

  const [account] = await deps.db
    .select()
    .from(edoAccounts)
    .where(eq(edoAccounts.id, accountId))
    .limit(1);
  if (!account) return { ...empty, skipped: 'not_found' };
  if (!account.boxId) return { ...empty, skipped: 'no_box' };

  // Главный выключатель — здесь, в единственной точке, через которую идёт
  // любой проход: и кнопка, и автоопрос, и то, что добавят потом. До лиза и до
  // первого запроса: при выключенном импорте не трогаем ни ленту, ни курсор.
  if (!env.EDO_IMPORT_ENABLED) return { ...empty, skipped: 'import_disabled' };

  const lease = await acquireEdoLease(deps.db, {
    accountId,
    owner: deps.owner,
    ttlSeconds: env.EDO_POLL_LEASE_SEC,
    // Ручной запуск проверяет доступы до включения постоянного опроса.
    requirePollEnabled: options.manual ? false : true,
  });
  if (!lease) return { ...empty, skipped: 'lease_taken' };

  const result: EdoPollResult = { ...empty, cursorBefore: account.lastIndexKey };
  let cursor = account.lastIndexKey;

  try {
    const client = deps.createClient
      ? deps.createClient(account)
      : new DiadocClient({
          auth: createDiadocAuth({ db: deps.db }, account),
          environment: account.environment,
        });

    while (result.events < env.EDO_POLL_MAX_EVENTS) {
      const { events } = await client.getNewEvents({
        boxId: account.boxId,
        afterIndexKey: cursor,
        fromTimestamp: account.backfillSince,
      });
      if (events.length === 0) break;

      const states: EventState[] = [];
      let lastEventAt: Date | null = null;

      for (const event of events) {
        result.events += 1;
        const indexKey = event.IndexKey ?? event.EventId;
        // Событие ленты время не несёт — оно лежит в сообщении (проверено
        // разведкой боевого ящика). Берём первое доступное.
        const eventAt = resolveEventTime(event).at;
        if (eventAt) lastEventAt = eventAt;

        const row = await claimEvent(deps.db, {
          accountId,
          eventId: event.EventId,
          indexKey,
          kind: event.Message ? 'message' : 'patch',
          eventAt,
        });

        // Событие закрыто прошлым проходом. Для курсора всё равно берём его
        // вложения из журнала, а не пустой список: пустой список терминален по
        // определению, и курсор прошёл бы событие, даже если в нём что-то
        // осталось незакрытым.
        if (!row) {
          const closed = await loadReceiptsForEvent(deps.db, accountId, event.EventId);
          states.push({ eventId: event.EventId, indexKey, receipts: closed.map(receiptState) });
          continue;
        }

        if (!event.Message) {
          await finishEvent(deps.db, row.id, 'no_entities');
          states.push({ eventId: event.EventId, indexKey, receipts: [] });
          continue;
        }

        const classified = classifyMessageEntities(event.Message, account.boxId);
        if (classified.skipped) {
          await finishEvent(deps.db, row.id, 'no_entities', classified.skipped);
          states.push({ eventId: event.EventId, indexKey, receipts: [] });
          continue;
        }

        for (const entity of classified.entities) {
          // Подпись — не документ: записи о ней в журнале не нужно.
          if (entity.route === 'ignored') {
            result.skippedEntities += 1;
            continue;
          }

          const receipt = await claimReceipt(deps.db, {
            accountId,
            eventId: event.EventId,
            messageId: event.Message.MessageId,
            entityId: entity.entityId,
            documentType: entity.typeNamedId,
            documentFunction: entity.documentFunction,
            documentVersion: entity.documentVersion,
            documentNumber: entity.documentNumber,
            counteragentBoxId: entity.counteragentBoxId,
            // Время доставки документа, иначе сообщения, иначе события.
            receivedAt: entity.meta.receivedAt ?? eventAt,
          });
          // Вложение уже доведено до терминала либо исчерпало попытки. Во втором
          // случае оно может так и остаться в `fetching` (процесс падал раз за
          // разом) — закрываем его, иначе курсор встанет на нём навсегда.
          if (!receipt) {
            await closeExhaustedReceipt(deps.db, {
              accountId,
              messageId: event.Message.MessageId,
              entityId: entity.entityId,
            });
            continue;
          }

          // Документ, который не берём (счёт-фактура, акт, тестовый,
          // аннулированный…), не скачивается, но и не пропадает: квитанция с
          // причиной — это строка журнала, отвечающая «а где документ?».
          if (entity.route === 'skip') {
            await markReceiptSkipped(
              deps.db,
              receipt.id,
              entity.reason,
              entity.isEncrypted ? 'encrypted' : 'skipped',
            );
            result.skippedEntities += 1;
            continue;
          }

          try {
            const outcome = await ingestEdoEntity(
              {
                db: deps.db,
                client,
                log: deps.log,
                put: deps.put,
                xmlMaxBytes: env.EDO_XML_MAX_BYTES,
                fileMaxBytes: env.EDO_FILE_MAX_BYTES,
              },
              { account, receipt, entity, messageId: event.Message.MessageId },
            );
            if (outcome.outcome === 'imported') result.imported += 1;
            else if (outcome.outcome === 'duplicate') result.duplicates += 1;
            else if (outcome.outcome === 'awaiting') result.awaiting += 1;
            else if (outcome.outcome === 'unparsed') result.unparsed += 1;
            else result.skippedEntities += 1;
          } catch (err) {
            if (isTransportFailure(err)) {
              // Попытку возвращаем: документ не виноват в том, что Диадок
              // ограничил частоту, хранилище не ответило или импорт выключен.
              await releaseReceiptAttempt(deps.db, receipt.id);
              throw err;
            }
            // Сбой самого документа: он тратит свою попытку и видим в журнале.
            // Прежде квитанция оставалась в `fetching`, а ошибка уходила в
            // состояние учётки — одно битое вложение красило её «ошибкой», а
            // сам документ после первого же сбоя перешагивался курсором.
            const message = err instanceof Error ? err.message : 'сбой разбора';
            deps.log.warn({ err, receiptId: receipt.id }, 'edo: вложение не принято');
            await markReceiptFailed(deps.db, receipt.id, message);
          }
        }

        // Закрыто ли событие — по тем же правилам, что у курсора. Прежний
        // признак «нет `fetching`» считал закрытым и событие с `failed`
        // вложением, у которого ещё остались попытки, — и оно больше не
        // повторялось.
        const receipts = await loadReceiptsForEvent(deps.db, accountId, event.EventId);
        const state: EventState = {
          eventId: event.EventId,
          indexKey,
          receipts: receipts.map(receiptState),
        };
        await finishEvent(deps.db, row.id, isEventTerminal(state) ? 'processed' : 'failed');
        states.push(state);
      }

      const nextCursor = advanceCursor(cursor, states);
      if (nextCursor && nextCursor !== cursor) {
        const saved = await saveCursor(deps.db, accountId, lease.token, nextCursor, lastEventAt);
        if (!saved) {
          deps.log.warn({ accountId }, 'edo: лиз перехвачен, проход прекращён');
          break;
        }
        cursor = nextCursor;
        result.cursorAfter = cursor;
      }

      // Упёрлись в незакрытое событие — дальше идти бессмысленно: сперва нужно
      // добрать застрявшее, иначе курсор всё равно не сдвинется.
      if (terminalPrefixLength(states) < states.length) break;

      if (!(await renewEdoLease(deps.db, lease, env.EDO_POLL_LEASE_SEC))) {
        deps.log.warn({ accountId }, 'edo: лиз не продлён, проход прекращён');
        break;
      }
    }

    await deps.db
      .update(edoAccounts)
      .set({ lastSyncAt: new Date(), lastOkAt: new Date(), updatedAt: new Date() })
      .where(eq(edoAccounts.id, accountId));
    return result;
  } catch (err) {
    const kind = isTransportFailure(err) ? failureKind(err) : 'upstream';
    const message = err instanceof Error ? err.message : 'проход не удался';
    deps.log.warn({ err, accountId }, 'edo: проход прекращён');
    // Выключенный импорт — не неисправность учётной записи: красить её
    // «ошибкой» незачем, причина видна в интерфейсе отдельно.
    if (kind !== 'import_disabled') {
      await deps.db
        .update(edoAccounts)
        .set({ lastError: message.slice(0, 500), updatedAt: new Date() })
        .where(eq(edoAccounts.id, accountId));
    }
    return { ...result, skipped: kind };
  } finally {
    await releaseEdoLease(deps.db, lease).catch(() => {});
  }
}
