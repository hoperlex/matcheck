// Журнал попыток забора писем (`mail_receipts`) — только транспорт.
//
// Запись создаётся ДО скачивания тела, поэтому у падения на fetch, разборе MIME
// или загрузке в S3 есть куда записать попытку. Без этого письмо, на котором
// сорвался процесс, исчезало бы бесследно: в бизнес-таблицу оно ещё не попало,
// а watermark его уже прошёл.
//
// Бизнес-состояние письма (карантин, объект, вложения) живёт отдельно, в
// `mail_messages`: транспорт и бизнес разведены намеренно, иначе повтор
// скачивания смешивался бы с повтором обработки.

import { and, asc, eq, gt, sql as drSql } from 'drizzle-orm';
import type { MailReceiptStatus } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { mailReceipts } from '../../db/schema.js';
import type { ReceiptState } from './watermark.js';

export type ReceiptRow = typeof mailReceipts.$inferSelect;

/**
 * Заводит (или возвращает существующую) запись о попытке забора.
 *
 * Повторный проход по тому же UID не создаёт дубля: дедуп по
 * `(mail_account_id, uid_validity, uid)` на уровне БД, без предварительного
 * SELECT и без гонки.
 */
export async function startReceipt(
  db: Db,
  params: { accountId: string; uidValidity: number; uid: number; rfc822Size?: number | null },
): Promise<ReceiptRow> {
  const [inserted] = await db
    .insert(mailReceipts)
    .values({
      mailAccountId: params.accountId,
      uidValidity: params.uidValidity,
      uid: params.uid,
      rfc822Size: params.rfc822Size ?? null,
      status: 'fetching',
    })
    .onConflictDoNothing({
      target: [mailReceipts.mailAccountId, mailReceipts.uidValidity, mailReceipts.uid],
    })
    .returning();
  if (inserted) return inserted;

  // Конфликт — запись уже есть: возвращаем её, чтобы повтор продолжил ту же
  // попытку, а не начал новую.
  const [existing] = await db
    .select()
    .from(mailReceipts)
    .where(
      and(
        eq(mailReceipts.mailAccountId, params.accountId),
        eq(mailReceipts.uidValidity, params.uidValidity),
        eq(mailReceipts.uid, params.uid),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('mail_receipts: строка исчезла между insert и select');
  return existing;
}

/** Успешный исход: письмо забрано и разобрано (или осознанно пропущено). */
export async function completeReceipt(
  db: Db,
  receiptId: string,
  status: Extract<MailReceiptStatus, 'parsed' | 'skipped_by_size' | 'vanished'>,
  rawS3Key?: string | null,
): Promise<void> {
  await db
    .update(mailReceipts)
    .set({
      status,
      rawS3Key: rawS3Key ?? null,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(mailReceipts.id, receiptId));
}

/**
 * Неуспешный исход: попытка засчитана, ошибка сохранена.
 *
 * Статус остаётся нетерминальным, пока попытки не исчерпаны, — watermark такой
 * UID не перешагнёт (см. domain/mail/watermark.ts).
 */
export async function failReceipt(
  db: Db,
  receiptId: string,
  status: Extract<MailReceiptStatus, 'fetch_failed' | 'parse_failed'>,
  error: unknown,
): Promise<void> {
  await db
    .update(mailReceipts)
    .set({
      status,
      attempts: drSql`${mailReceipts.attempts} + 1`,
      lastError: error instanceof Error ? error.message : String(error),
      updatedAt: new Date(),
    })
    .where(eq(mailReceipts.id, receiptId));
}

/**
 * Записи выше watermark в текущей нумерации ящика — исходные данные для
 * пересчёта границы после прохода.
 */
export async function loadReceiptsAfter(
  db: Db,
  params: { accountId: string; uidValidity: number; afterUid: number },
): Promise<ReceiptState[]> {
  const rows = await db
    .select({
      uid: mailReceipts.uid,
      status: mailReceipts.status,
      attempts: mailReceipts.attempts,
    })
    .from(mailReceipts)
    .where(
      and(
        eq(mailReceipts.mailAccountId, params.accountId),
        eq(mailReceipts.uidValidity, params.uidValidity),
        gt(mailReceipts.uid, params.afterUid),
      ),
    )
    .orderBy(asc(mailReceipts.uid));

  return rows.map((r) => ({
    uid: r.uid,
    status: r.status as MailReceiptStatus,
    attempts: r.attempts,
  }));
}
