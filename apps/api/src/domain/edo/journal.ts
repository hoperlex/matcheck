/**
 * Журналы приёма из Диадока: события ленты и вложения.
 *
 * Почему два журнала. Событие ленты и документ — разные сущности: событие может
 * нести сообщение либо патч к уже доставленному, патч может не содержать нового
 * документа, а одно вложение встречается в нескольких событиях. Считая курсор
 * по журналу вложений, мы бы либо застряли, либо перескочили событие — то есть
 * потеряли документ молча.
 *
 * Почему захват попытки, а не «вставил или выбрал». Пара INSERT/SELECT
 * возвращает обоим процессам одну и ту же запись `fetching`, и оба идут
 * скачивать и разбирать один документ. Здесь работа ЗАХВАТЫВАЕТСЯ условным
 * обновлением: запись достаётся тому, кто успел, а терминальная не достаётся
 * никому — повтор выходит сразу.
 */
import { and, eq, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { edoEvents, edoReceipts } from '../../db/schema.js';
import { EDO_RECEIPT_MAX_ATTEMPTS } from './event-cursor.js';

export type EdoEventRow = typeof edoEvents.$inferSelect;
export type EdoReceiptRow = typeof edoReceipts.$inferSelect;

/** Статусы транспорта, после которых к вложению не возвращаются. */
const TERMINAL_TRANSPORT = ['stored', 'skipped', 'too_large', 'encrypted', 'vanished'] as const;

/**
 * Заводит запись о событии ленты.
 *
 * Возвращает `null`, если событие уже доведено до терминала: повторный проход
 * по той же странице не должен перезабирать документы.
 */
export async function claimEvent(
  db: Db,
  params: {
    accountId: string;
    eventId: string;
    indexKey: string;
    kind: 'message' | 'patch';
    eventAt: Date | null;
  },
): Promise<EdoEventRow | null> {
  const [row] = await db
    .insert(edoEvents)
    .values({
      edoAccountId: params.accountId,
      eventId: params.eventId,
      indexKey: params.indexKey,
      kind: params.kind,
      eventAt: params.eventAt,
      status: 'pending',
    })
    .onConflictDoUpdate({
      target: [edoEvents.edoAccountId, edoEvents.eventId],
      // Берём в работу только то, что ещё не закрыто. Условие считает база,
      // поэтому двум процессам одно событие не достанется.
      set: { indexKey: params.indexKey, updatedAt: new Date() },
      setWhere: drSql`${edoEvents.status} = 'pending'`,
    })
    .returning();

  return row ?? null;
}

export async function finishEvent(
  db: Db,
  eventRowId: string,
  status: 'processed' | 'no_entities' | 'skipped_by_age' | 'failed',
  lastError?: string | null,
): Promise<void> {
  await db
    .update(edoEvents)
    .set({
      status,
      lastError: lastError ?? null,
      attempts: status === 'failed' ? drSql`${edoEvents.attempts} + 1` : edoEvents.attempts,
      updatedAt: new Date(),
    })
    .where(eq(edoEvents.id, eventRowId));
}

/**
 * Захватывает работу по вложению.
 *
 * `null` означает «заниматься нечем»: вложение уже доведено до терминала либо
 * исчерпало попытки. Именно поэтому терминальные статусы перечислены в условии,
 * а не проверяются в коде после выборки — иначе между проверкой и захватом
 * влезал бы второй процесс.
 */
export async function claimReceipt(
  db: Db,
  params: {
    accountId: string;
    eventId: string | null;
    messageId: string;
    entityId: string;
    documentType?: string | null;
    documentFunction?: string | null;
    documentVersion?: string | null;
    documentNumber?: string | null;
    counteragentBoxId?: string | null;
    receivedAt?: Date | null;
  },
  maxAttempts = EDO_RECEIPT_MAX_ATTEMPTS,
): Promise<EdoReceiptRow | null> {
  const [row] = await db
    .insert(edoReceipts)
    .values({
      edoAccountId: params.accountId,
      eventId: params.eventId,
      messageId: params.messageId,
      entityId: params.entityId,
      documentType: params.documentType ?? null,
      documentFunction: params.documentFunction ?? null,
      documentVersion: params.documentVersion ?? null,
      documentNumber: params.documentNumber ?? null,
      counteragentBoxId: params.counteragentBoxId ?? null,
      receivedAt: params.receivedAt ?? null,
      transportStatus: 'fetching',
      attempts: 1,
    })
    .onConflictDoUpdate({
      target: [edoReceipts.edoAccountId, edoReceipts.messageId, edoReceipts.entityId],
      set: {
        transportStatus: 'fetching',
        eventId: params.eventId,
        attempts: drSql`${edoReceipts.attempts} + 1`,
        updatedAt: new Date(),
      },
      setWhere: drSql`${edoReceipts.transportStatus} not in (${drSql.join(
        TERMINAL_TRANSPORT.map((s) => drSql`${s}`),
        drSql`, `,
      )}) and ${edoReceipts.attempts} < ${maxAttempts}`,
    })
    .returning();

  return row ?? null;
}

/** Файл забран и сохранён: для курсора вложение закрыто. */
export async function markReceiptStored(
  db: Db,
  receiptId: string,
  params: { rawS3Key: string; contentSha256: string; documentNumber?: string | null },
): Promise<void> {
  await db
    .update(edoReceipts)
    .set({
      transportStatus: 'stored',
      rawS3Key: params.rawS3Key,
      contentSha256: params.contentSha256,
      documentNumber: params.documentNumber ?? undefined,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(edoReceipts.id, receiptId));
}

/** Забирать нечего: не наш документ, служебное вложение, зашифрованное. */
export async function markReceiptSkipped(
  db: Db,
  receiptId: string,
  reason: string,
  status: 'skipped' | 'encrypted' | 'too_large' | 'vanished' = 'skipped',
): Promise<void> {
  await db
    .update(edoReceipts)
    .set({
      transportStatus: status,
      routeStatus: 'not_applicable',
      lastError: reason,
      updatedAt: new Date(),
    })
    .where(eq(edoReceipts.id, receiptId));
}

/**
 * Сбой по конкретному вложению.
 *
 * Счётчик попыток уже увеличен захватом, поэтому здесь только статус и причина.
 * Транспортные отказы (ограничение частоты, недоступность, просроченный токен)
 * сюда НЕ попадают: они не про этот документ, и тратить на них бюджет попыток
 * нельзя — иначе сутки чужих проблем навсегда похоронят очередь.
 */
export async function markReceiptFailed(
  db: Db,
  receiptId: string,
  error: string,
): Promise<void> {
  await db
    .update(edoReceipts)
    .set({ transportStatus: 'failed', lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(edoReceipts.id, receiptId));
}

/**
 * Возвращает попытку, израсходованную не по вине документа.
 *
 * Захват попытки увеличивает счётчик ДО обращения к сети — иначе два процесса
 * взяли бы одну работу. Но если проход оборвался ограничением частоты,
 * недоступностью Диадока или просроченным токеном, документ тут ни при чём:
 * оставив счётчик увеличенным, мы за сутки чужих неполадок сожгли бы бюджет
 * попыток всей очереди и перешагнули бы её навсегда.
 */
export async function releaseReceiptAttempt(db: Db, receiptId: string): Promise<void> {
  await db
    .update(edoReceipts)
    .set({
      attempts: drSql`greatest(${edoReceipts.attempts} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(and(eq(edoReceipts.id, receiptId), eq(edoReceipts.transportStatus, 'fetching')));
}

/** Что сделали с уже сохранённым файлом. */
export async function markReceiptRoute(
  db: Db,
  receiptId: string,
  routeStatus: 'imported' | 'awaiting' | 'routed' | 'duplicate' | 'not_applicable',
  params?: { sourceDocumentId?: string | null; parseSource?: 'local_xml' | 'diadoc_title' | null; error?: string | null },
): Promise<void> {
  await db
    .update(edoReceipts)
    .set({
      routeStatus,
      sourceDocumentId: params?.sourceDocumentId ?? undefined,
      parseSource: params?.parseSource ?? undefined,
      lastError: params?.error ?? null,
      updatedAt: new Date(),
    })
    .where(eq(edoReceipts.id, receiptId));
}

/** Вложения события — для расчёта его терминальности. */
export async function loadReceiptsForEvent(
  db: Db,
  accountId: string,
  eventId: string,
): Promise<EdoReceiptRow[]> {
  return db
    .select()
    .from(edoReceipts)
    .where(and(eq(edoReceipts.edoAccountId, accountId), eq(edoReceipts.eventId, eventId)));
}
