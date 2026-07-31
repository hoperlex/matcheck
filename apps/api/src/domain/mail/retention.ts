// Срок хранения почты.
//
// Зачем. Каждое письмо оставляет в хранилище сырой .eml и по объекту на каждое
// вложение. Без уборки они копятся вечно: ящик подрядчиков — это десятки писем
// в день, а сами документы уже лежат отдельно, в постоянных ключах пакета.
//
// Что удаляется: только письма, с которыми УЖЕ разобрались, — принятые,
// отклонённые, без вложений, проигнорированные. Карантинные не трогаются
// никогда, сколько бы ни висели: они ждут человека, и удалить их — значит
// потерять документы, которые никто не завёл.
//
// Файлы удаляются не напрямую, а через s3_cleanup_outbox: хранилище не
// участвует в транзакции БД, и прямое удаление оставило бы мусор при сбое
// между двумя операциями. Записи в очередь и удаление строк идут одной
// транзакцией, а до хранилища доходит отдельный consumer с ретраями.

import { and, inArray, lt, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { mailAttachments, mailMessages, mailReceipts, s3CleanupOutbox } from '../../db/schema.js';

/** Исходы, после которых письмо больше не нужно. Карантин сюда не входит. */
export const PURGEABLE_STATUSES = [
  'ingested',
  'rejected',
  'no_attachments',
  'ignored',
  'rejected_sender',
] as const;

/** Максимум писем за прогон: уборка не должна занимать соединение надолго. */
export const PURGE_BATCH = 200;

export type PurgeDeps = {
  db: Db;
  retentionDays: number;
  log?: { info?: (o: unknown, m?: string) => void; warn?: (o: unknown, m?: string) => void };
};

export type PurgeResult = {
  messages: number;
  /** Сколько объектов хранилища поставлено в очередь на удаление. */
  objects: number;
};

/**
 * Удаляет письма старше срока хранения вместе с их файлами.
 *
 * Идемпотентна: повторный вызов на тех же данных ничего не находит.
 */
export async function purgeOldMail(deps: PurgeDeps): Promise<PurgeResult> {
  const { db } = deps;
  if (deps.retentionDays <= 0) return { messages: 0, objects: 0 };

  const cutoff = drSql`now() - make_interval(days => ${deps.retentionDays})`;

  const victims = await db
    .select({ id: mailMessages.id, rawS3Key: mailMessages.rawS3Key })
    .from(mailMessages)
    .where(
      and(
        inArray(mailMessages.status, [...PURGEABLE_STATUSES]),
        lt(mailMessages.createdAt, cutoff),
      ),
    )
    .limit(PURGE_BATCH);
  if (victims.length === 0) return { messages: 0, objects: 0 };

  const ids = victims.map((v) => v.id);

  // Ключи вложений собираем ДО удаления: строки уйдут каскадом вместе с письмом.
  const attachments = await db
    .select({ id: mailAttachments.id, key: mailAttachments.stagingS3Key })
    .from(mailAttachments)
    .where(inArray(mailAttachments.mailMessageId, ids));

  const objects: { s3Key: string; entityType: string; entityId: string }[] = [];
  for (const v of victims) {
    if (v.rawS3Key) {
      objects.push({ s3Key: v.rawS3Key, entityType: 'mail_message', entityId: v.id });
    }
  }
  for (const a of attachments) {
    if (a.key) {
      objects.push({ s3Key: a.key, entityType: 'mail_attachment', entityId: a.id });
    }
  }

  await db.transaction(async (tx) => {
    if (objects.length > 0) {
      await tx.insert(s3CleanupOutbox).values(objects);
    }
    // Вложения уходят каскадом по FK, отдельного удаления не требуют.
    await tx.delete(mailMessages).where(inArray(mailMessages.id, ids));
  });

  deps.log?.info?.(
    { messages: ids.length, objects: objects.length, retentionDays: deps.retentionDays },
    'mail retention: старые письма удалены',
  );
  return { messages: ids.length, objects: objects.length };
}

/**
 * Чистит журнал попыток забора.
 *
 * Он растёт на каждое письмо, включая те, что даже не скачивались (переписка
 * без вложений). Записи нужны, пока граница до них не дошла, — поэтому удаляем
 * только те, что ниже текущей границы ящика и уже старые.
 */
export async function purgeOldReceipts(deps: PurgeDeps): Promise<number> {
  const { db } = deps;
  if (deps.retentionDays <= 0) return 0;

  const deleted = await db
    .delete(mailReceipts)
    .where(
      and(
        lt(mailReceipts.createdAt, drSql`now() - make_interval(days => ${deps.retentionDays})`),
        // Ниже границы ящика: выше неё записи ещё участвуют в её пересчёте.
        drSql`${mailReceipts.uid} <= coalesce((
          select last_uid from mail_accounts a where a.id = ${mailReceipts.mailAccountId}
        ), 0)`,
        // Запрошенное к повторному забору не трогаем, сколько бы ни лежало.
        drSql`${mailReceipts.replayRequestedAt} is null`,
      ),
    )
    .returning({ id: mailReceipts.id });
  return deleted.length;
}
