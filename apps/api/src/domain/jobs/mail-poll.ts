// Цикл опроса почтового ящика: связывает лиз, двухфазный забор, приём письма
// в карантин и сдвиг watermark.
//
// Инварианты, ради которых всё и разложено на отдельные модули:
//
//   * ящик обрабатывает ровно один воркер — по лизу с владельцем и токеном;
//   * тело письма скачивается только после проверки размера;
//   * каждая попытка забора фиксируется в journal ДО скачивания, поэтому сбой
//     на любом шаге не теряет письмо;
//   * watermark двигается по непрерывному префиксу терминальных записей, а не
//     по максимальному успешному UID;
//   * лиз освобождается в finally — упавший проход не запирает ящик до
//     истечения срока.
//
// Письмо с ЯВНО указанным объектом (`Объект: КОД`) сразу становится пакетом и
// уходит в распознавание — менеджер не участвует. Всё остальное — объект не
// указан, кодов несколько, тот же комплект уже лежит на другой площадке —
// остаётся в разборе. Ошибка создания пакета письмо не теряет: оно ждёт
// оператора, а транспортная часть уже завершена.

import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { mailAccounts, sites } from '../../db/schema.js';
import { ingestLetter, type IngestDeps } from '../mail/ingest-message.js';
import {
  acquirePollLease,
  releasePollLease,
  type LeaseHandle,
} from '../mail/poll-lease.js';
import {
  completeReceipt,
  failReceipt,
  loadReceiptsAfter,
  startReceipt,
} from '../mail/receipts.js';
import {
  decideFetch,
  fetchHeadlines,
  fetchHeadlinesFor,
  fetchSource,
  DEFAULT_FETCH_LIMITS,
  type FetchLimits,
  type ImapLike,
} from '../mail/imap.fetch.js';
import { clearReplayFlag, loadReplayTargets } from '../mail/replay.js';
import { resolveMailMessage, type CopyObject } from '../mail/resolve-message.js';
import { computeWatermark, needsWatermarkReset } from '../mail/watermark.js';
import type { SiteRef } from '../sourceDocuments/siteHint.js';

export type MailAccountRow = typeof mailAccounts.$inferSelect;

/** Открытая папка ящика: клиент плюс текущая нумерация. */
export type MailboxSession = {
  client: ImapLike;
  uidValidity: number;
  close: () => Promise<void>;
};

export type PollDeps = Pick<IngestDeps, 'db' | 'putObject' | 'parseMime'> & {
  /** Подключение к IMAP. Подменяется в тестах. */
  openMailbox: (account: MailAccountRow) => Promise<MailboxSession>;
  /** Копирование staging → постоянные ключи при создании пакета. */
  copyObject?: CopyObject;
  log?: { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };
};

export type PollOptions = {
  /** UUID экземпляра воркера — попадает в лиз. */
  owner: string;
  leaseTtlSeconds?: number;
  maxMessages?: number;
  fetchLimits?: FetchLimits;
  /**
   * Ручной запуск «проверить сейчас» из админки: работает и для ящика с
   * выключенным автоопросом — так проверяют доступы до включения.
   */
  manual?: boolean;
  /**
   * Автоматически превращать письмо в пакет, когда подрядчик указал объект
   * явно. Выключение оставляет все письма в разборе — на случай, если
   * потребуется временно вернуть ручное подтверждение.
   */
  autoResolve?: boolean;
  /** Сколько писем дозабирать за проход по запросу оператора. */
  maxReplay?: number;
};

export type PollResult = {
  /** Ящик занят другим воркером или опрос выключен. */
  skipped?: 'lease_taken';
  fetched: number;
  stored: number;
  duplicates: number;
  failed: number;
  /** Письма, ставшие пакетами без участия человека. */
  autoResolved: number;
  /** Письма, оставшиеся в разборе: объект неясен или конфликт. */
  quarantined: number;
  /** Письма, забранные повторно по запросу оператора. */
  replayed: number;
  watermarkBefore: number;
  watermarkAfter: number;
  uidValidityReset: boolean;
};

const EMPTY_RESULT: Omit<PollResult, 'watermarkBefore' | 'watermarkAfter'> = {
  fetched: 0,
  stored: 0,
  duplicates: 0,
  failed: 0,
  autoResolved: 0,
  quarantined: 0,
  replayed: 0,
  uidValidityReset: false,
};

/** Справочник объектов для матчера — активные, без технического TEST. */
async function loadSites(db: Db): Promise<SiteRef[]> {
  const rows = await db
    .select({
      id: sites.id,
      code: sites.code,
      name: sites.name,
      address: sites.address,
      isActive: sites.isActive,
    })
    .from(sites)
    .where(eq(sites.isActive, true));
  return rows;
}

/**
 * Один проход по ящику.
 *
 * Возвращает сводку прохода; ошибки отдельных писем не прерывают цикл — они
 * фиксируются в журнале и просто останавливают watermark на своём UID.
 */
export async function pollMailAccount(
  deps: PollDeps,
  account: MailAccountRow,
  options: PollOptions,
): Promise<PollResult> {
  const { db } = deps;
  const leaseTtl = options.leaseTtlSeconds ?? 15 * 60;
  const maxMessages = options.maxMessages ?? 50;
  const limits = options.fetchLimits ?? DEFAULT_FETCH_LIMITS;

  const lease: LeaseHandle | null = await acquirePollLease(db, {
    accountId: account.id,
    owner: options.owner,
    ttlSeconds: leaseTtl,
    requirePollEnabled: options.manual !== true,
  });
  if (!lease) {
    return {
      ...EMPTY_RESULT,
      skipped: 'lease_taken',
      watermarkBefore: account.lastUid ?? 0,
      watermarkAfter: account.lastUid ?? 0,
    };
  }

  let session: MailboxSession | null = null;
  try {
    session = await deps.openMailbox(account);
    const { client, uidValidity } = session;

    // Сервер перенумеровал ящик — прежние UID недействительны. Продолжать с
    // тем же watermark нельзя: либо пропустим письма, либо перечитаем чужие.
    const reset = needsWatermarkReset(account.uidValidity, uidValidity);
    const watermarkBefore = reset ? 0 : (account.lastUid ?? 0);
    if (reset || account.uidValidity !== uidValidity) {
      await db
        .update(mailAccounts)
        .set({ uidValidity, lastUid: reset ? 0 : account.lastUid, updatedAt: new Date() })
        .where(eq(mailAccounts.id, account.id));
    }

    const headlines = await fetchHeadlines(client, watermarkBefore + 1, maxMessages);
    // Письма, запрошенные оператором к повторному забору: лежат НИЖЕ границы,
    // обычный проход к ним не вернётся.
    const replayTargets = await loadReplayTargets(db, {
      accountId: account.id,
      uidValidity,
      limit: options.maxReplay ?? 20,
    });
    // Справочник нужен и дозабору: без него матчер не определит объект и
    // повторно забранное письмо ушло бы в разбор даже с явным маркером.
    const siteRefs =
      headlines.length > 0 || replayTargets.length > 0 ? await loadSites(db) : [];

    let stored = 0;
    let duplicates = 0;
    let failed = 0;
    let autoResolved = 0;
    let quarantined = 0;
    let replayed = 0;

    /**
     * Один письмо: транспорт, приём в карантин и, при явном объекте,
     * автосоздание пакета. Общая процедура для обычного прохода и для
     * повторного забора — иначе у дозабора появилась бы своя копия правил.
     */
    const processHeadline = async (headline: (typeof headlines)[number]): Promise<void> => {
      const receipt = await startReceipt(db, {
        accountId: account.id,
        uidValidity,
        uid: headline.uid,
        rfc822Size: headline.size,
      });

      try {
        const decision = decideFetch(headline, limits);
        if (!decision.fetch) {
          // Письмо целиком не скачиваем. Слишком большое — помечаем отдельно,
          // чтобы оператор мог поднять лимит и повторить; переписку без
          // вложений считаем обработанной: документов в ней нет.
          await completeReceipt(
            db,
            receipt.id,
            decision.reason === 'skipped_by_size' ? 'skipped_by_size' : 'parsed',
          );
          return;
        }

        const raw = await fetchSource(client, headline.uid);
        if (!raw) {
          // Письмо удалили или перенесли между фазами — штатная ситуация.
          await completeReceipt(db, receipt.id, 'vanished');
          return;
        }

        const outcome = await ingestLetter(
          { db, putObject: deps.putObject, parseMime: deps.parseMime },
          {
            accountId: account.id,
            uidValidity,
            uid: headline.uid,
            receiptId: receipt.id,
            raw,
            sites: siteRefs,
          },
        );

        if (outcome.outcome === 'duplicate') duplicates += 1;
        else stored += 1;
        await completeReceipt(
          db,
          receipt.id,
          'parsed',
          outcome.outcome === 'stored' ? outcome.rawS3Key : null,
        );

        // Письмо забрано и разобрано — транспортная часть закончена. Дальше
        // бизнес-шаг: если подрядчик указал объект ЯВНО, письмо сразу
        // становится пакетом и уходит в распознавание. Всё остальное
        // (объект не указан, несколько кодов, конфликт) ждёт оператора.
        if (
          outcome.outcome === 'stored' &&
          outcome.status === 'quarantined' &&
          options.autoResolve !== false
        ) {
          if (outcome.match.decision === 'explicit' && deps.copyObject) {
            try {
              const resolved = await resolveMailMessage(
                { db, copyObject: deps.copyObject, log: deps.log },
                {
                  messageId: outcome.messageId,
                  siteId: outcome.match.siteId,
                  expectedDate: outcome.expectedDate,
                  // Автопроход: подтвердившего человека нет.
                  actorUserId: null,
                },
              );
              if (resolved.outcome === 'ingested' || resolved.outcome === 'reused') {
                autoResolved += 1;
              } else {
                quarantined += 1;
              }
            } catch (err) {
              // Ошибка создания пакета письмо не теряет: оно остаётся в
              // разборе, и оператор доведёт его вручную.
              quarantined += 1;
              deps.log?.warn?.(
                { err, accountId: account.id, uid: headline.uid },
                'mail poll: автосоздание пакета не удалось, письмо ждёт в разборе',
              );
            }
          } else {
            quarantined += 1;
          }
        }
      } catch (err) {
        failed += 1;
        // Транспорт и разбор различаем по тому, дошли ли до тела письма:
        // от этого зависит, что именно повторять.
        await failReceipt(db, receipt.id, 'fetch_failed', err);
        deps.log?.warn?.(
          { err, accountId: account.id, uid: headline.uid },
          'mail poll: письмо не обработано',
        );
      }
    };

    // Дозабор идёт первым. Отметка снимается в любом случае — иначе письмо,
    // которое не забирается в принципе, дозабирали бы каждый проход, вытесняя
    // новые.
    if (replayTargets.length > 0) {
      const replayHeadlines = await fetchHeadlinesFor(
        client,
        replayTargets.map((t) => t.uid),
      );
      const byUid = new Map(replayHeadlines.map((h) => [h.uid, h]));
      for (const target of replayTargets) {
        const headline = byUid.get(target.uid);
        if (headline) {
          await processHeadline(headline);
          replayed += 1;
        } else {
          // Письма больше нет в ящике — повторять нечего.
          await completeReceipt(db, target.receiptId, 'vanished');
        }
        await clearReplayFlag(db, target.receiptId);
      }
    }

    for (const headline of headlines) {
      await processHeadline(headline);
    }

    // Границу считаем по журналу, а не по счётчикам цикла: в журнале уже учтены
    // и незавершённые попытки прошлых проходов.
    const states = await loadReceiptsAfter(db, {
      accountId: account.id,
      uidValidity,
      afterUid: watermarkBefore,
    });
    const watermarkAfter = computeWatermark(watermarkBefore, states);
    if (watermarkAfter !== (account.lastUid ?? 0) || reset) {
      await db
        .update(mailAccounts)
        .set({ lastUid: watermarkAfter, updatedAt: new Date() })
        .where(eq(mailAccounts.id, account.id));
    }

    return {
      fetched: headlines.length,
      stored,
      duplicates,
      failed,
      autoResolved,
      quarantined,
      replayed,
      watermarkBefore,
      watermarkAfter,
      uidValidityReset: reset,
    };
  } finally {
    // Лиз снимаем всегда: иначе упавший проход запер бы ящик до истечения TTL.
    await session?.close().catch(() => undefined);
    await releasePollLease(db, lease).catch(() => undefined);
  }
}
