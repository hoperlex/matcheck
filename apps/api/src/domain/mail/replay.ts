// Повторный забор письма, которое не удалось скачать.
//
// Зачем. Письмо, сорвавшееся на скачивании (слишком большое, обрыв связи,
// битый MIME), после исчерпания попыток становится терминальным — и watermark
// его перешагивает. Обычный проход идёт от границы вверх и к такому UID больше
// не возвращается: письмо потеряно, хотя оно есть в ящике.
//
// Откатывать границу назад нельзя: она общая для ящика, и откат заставил бы
// перечитать все письма после проблемного. Поэтому оператор помечает нужную
// запись, а поллер делает точечный дозабор именно этих UID — до основного
// цикла и независимо от границы.
//
// Повторный забор безопасен: дедуп писем идёт по sha256 сырого .eml, поэтому
// успешно принятое ранее письмо второй раз документа не создаст.

import { and, asc, eq, isNotNull, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { mailReceipts } from '../../db/schema.js';

/** Статусы, для которых повтор осмыслен. Успешные и исчезнувшие письма не трогаем. */
export const REPLAYABLE_STATUSES = [
  'skipped_by_size',
  'fetch_failed',
  'parse_failed',
] as const;

export type ReplayTarget = {
  receiptId: string;
  uid: number;
  uidValidity: number;
};

export type RequestReplayResult =
  | { ok: true; uid: number }
  | { ok: false; reason: 'not_found' | 'not_replayable' };

/**
 * Помечает запись к повторному забору.
 *
 * Счётчик попыток обнуляется: иначе дозабор сразу упёрся бы в тот же предел,
 * из-за которого письмо и стало терминальным.
 */
export async function requestReplay(db: Db, receiptId: string): Promise<RequestReplayResult> {
  const [row] = await db
    .select({ id: mailReceipts.id, status: mailReceipts.status, uid: mailReceipts.uid })
    .from(mailReceipts)
    .where(eq(mailReceipts.id, receiptId))
    .limit(1);
  if (!row) return { ok: false, reason: 'not_found' };
  if (!(REPLAYABLE_STATUSES as readonly string[]).includes(row.status)) {
    return { ok: false, reason: 'not_replayable' };
  }

  await db
    .update(mailReceipts)
    .set({
      replayRequestedAt: drSql`now()`,
      attempts: 0,
      lastError: null,
      updatedAt: drSql`now()`,
    })
    .where(eq(mailReceipts.id, receiptId));
  return { ok: true, uid: row.uid };
}

/**
 * UID, запрошенные к дозабору для текущей нумерации ящика.
 *
 * Записи чужой нумерации (`uidValidity` сменился — сервер перенумеровал ящик)
 * не отдаём: их UID указывают на другие письма, и дозабор притащил бы не то.
 */
export async function loadReplayTargets(
  db: Db,
  params: { accountId: string; uidValidity: number; limit?: number },
): Promise<ReplayTarget[]> {
  const rows = await db
    .select({
      receiptId: mailReceipts.id,
      uid: mailReceipts.uid,
      uidValidity: mailReceipts.uidValidity,
    })
    .from(mailReceipts)
    .where(
      and(
        eq(mailReceipts.mailAccountId, params.accountId),
        eq(mailReceipts.uidValidity, params.uidValidity),
        isNotNull(mailReceipts.replayRequestedAt),
      ),
    )
    .orderBy(asc(mailReceipts.uid))
    .limit(params.limit ?? 20);
  return rows;
}

/**
 * Снимает отметку после попытки дозабора — независимо от исхода.
 *
 * Иначе письмо, которое не удаётся забрать в принципе (например, сервер каждый
 * раз рвёт соединение), дозабирали бы каждый проход, вытесняя новые письма.
 * Оператор увидит новый исход в списке и решит, повторять ли снова.
 */
export async function clearReplayFlag(db: Db, receiptId: string): Promise<void> {
  await db
    .update(mailReceipts)
    .set({ replayRequestedAt: null, updatedAt: drSql`now()` })
    .where(eq(mailReceipts.id, receiptId));
}
