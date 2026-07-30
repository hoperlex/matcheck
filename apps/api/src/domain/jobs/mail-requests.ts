import { and, eq, sql as drSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  counterparties,
  llmProviders,
  mailAccounts,
  sourceDocumentItems,
  sourceDocuments,
} from '../../db/schema.js';
import { fetchNewMessages } from '../mail/imap.client.js';
import { parseRequestFromMail } from '../mail/request.parser.js';

/**
 * Приём ЗАЯВОК из почтового ящика (`kind = 'request'`).
 *
 * Это исторический канал: письмо разбирается LLM сразу при получении и
 * становится `source_documents` без участия оператора. Канал приёма УПД от
 * подрядчиков строится отдельно (карантин + подтверждение) и получит свой
 * поллер — поэтому заявочный код вынесен сюда из `mail-poller.ts`.
 */

async function findOrCreateCounterparty(
  app: FastifyInstance,
  party: { inn?: string; kpp?: string | null; name?: string },
): Promise<string | null> {
  if (!party.inn) return null;
  const [existing] = await app.db
    .select({ id: counterparties.id })
    .from(counterparties)
    .where(
      and(
        eq(counterparties.inn, party.inn),
        party.kpp ? eq(counterparties.kpp, party.kpp) : drSql`${counterparties.kpp} is null`,
      ),
    )
    .limit(1);
  if (existing) return existing.id;
  const [created] = await app.db
    .insert(counterparties)
    .values({
      inn: party.inn,
      kpp: party.kpp ?? null,
      name: party.name ?? party.inn,
      isSupplier: true,
    })
    .returning({ id: counterparties.id });
  return created?.id ?? null;
}

export async function runMailSyncForAccount(
  app: FastifyInstance,
  account: typeof mailAccounts.$inferSelect,
): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;
  let lastUid = account.lastUid ?? 0;

  // Identify active LLM provider id
  const [defaultProvider] = await app.db
    .select({ id: llmProviders.id })
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);

  const messages = await fetchNewMessages(account);

  // Строго по возрастанию UID: watermark двигается только по непрерывному
  // префиксу успешно обработанных писем (см. ниже). Порядок выдачи IMAP
  // формально не гарантирован, а от него зависит, какое письмо потеряется.
  const ordered = [...messages].sort((a, b) => a.uid - b.uid);

  // Первое упавшее письмо останавливает watermark: раньше `lastUid` сдвигался
  // ВНЕ try/catch, поэтому письмо, на котором сорвался LLM или сеть, больше
  // никогда не попадало в выборку `uid > last_uid` — терялось навсегда.
  // Ценой возможной повторной обработки следующих писем (её гасит дедуп по
  // `(mail_account_id, message_id)`) не теряем ни одного.
  let watermarkStalled = false;

  for (const m of ordered) {
    try {
      const parseResult = await parseRequestFromMail({
        emailBody: m.textBody || m.htmlBody,
        attachments: m.attachments,
      });
      const data = parseResult.data;
      const supplierId = data.supplier ? await findOrCreateCounterparty(app, data.supplier) : null;

      const [created] = await app.db
        .insert(sourceDocuments)
        .values({
          kind: 'request',
          direction: 'inbound',
          origin: 'mail',
          mailAccountId: account.id,
          messageId: m.messageId,
          messageReceivedAt: m.receivedAt,
          supplierId,
          docNumber: data.docNumber ?? null,
          docDate: data.docDate ? new Date(data.docDate) : null,
          expectedDate: data.expectedDate ? new Date(data.expectedDate) : null,
          llmProviderId: defaultProvider?.id ?? null,
          llmConfidence: data.confidence?.toString() ?? null,
          status: 'parsed',
        })
        // Предикат обязан ТОЧНО совпадать с условием частичного индекса
        // `source_mail_message_unique` (schema.ts: `where mail_account_id is
        // not null`). Без него PostgreSQL не находит подходящего ограничения и
        // отвечает 42P10 на КАЖДОМ письме. В проде дефект не проявился только
        // потому, что таблица `mail_accounts` пуста.
        //
        // Именно совпадать, а не «покрывать»: проверено на живой БД —
        // логически более сильный предикат (`… and kind = 'request'`) на этом
        // индексе тоже даёт 42P10. Поэтому сужение индекса и правка этого
        // предиката обязаны выехать ОДНИМ шагом, в contract-фазе.
        .onConflictDoNothing({
          target: [sourceDocuments.mailAccountId, sourceDocuments.messageId],
          where: drSql`${sourceDocuments.mailAccountId} is not null`,
        })
        .returning({ id: sourceDocuments.id });

      if (created && data.items.length) {
        await app.db.insert(sourceDocumentItems).values(
          data.items.map((it, i) => ({
            sourceDocumentId: created.id,
            nameRaw: it.nameRaw,
            qty: it.qty.toString(),
            unit: it.unit,
            price: it.price?.toString() ?? null,
            expectedDate: it.expectedDate ? new Date(it.expectedDate) : null,
            lineNo: i + 1,
          })),
        );
      }
      // Считаем только реально созданные документы: повтор того же письма —
      // не «импорт», иначе счётчик в UI показывает работу там, где сработал
      // дедуп.
      if (created) imported += 1;
    } catch (err) {
      failed += 1;
      watermarkStalled = true;
      app.log.warn({ err, uid: m.uid }, 'mail message parse failed');
    }
    if (!watermarkStalled) lastUid = Math.max(lastUid, m.uid);
  }

  if (lastUid !== (account.lastUid ?? 0)) {
    await app.db
      .update(mailAccounts)
      .set({ lastUid, updatedAt: new Date() })
      .where(eq(mailAccounts.id, account.id));
  }
  return { imported, failed };
}
