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
  for (const m of messages) {
    try {
      const parseResult = await parseRequestFromMail({
        emailBody: m.textBody || m.htmlBody,
        attachments: m.attachments,
      });
      const data = parseResult.data;
      const supplierId = data.supplier ? await findOrCreateCounterparty(app, data.supplier) : null;

      await app.db
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
        .onConflictDoNothing({ target: [sourceDocuments.mailAccountId, sourceDocuments.messageId] })
        .returning({ id: sourceDocuments.id })
        .then(async (rows) => {
          const created = rows[0];
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
        });
      imported += 1;
    } catch (err) {
      failed += 1;
      app.log.warn({ err, uid: m.uid }, 'mail message parse failed');
    }
    lastUid = Math.max(lastUid, m.uid);
  }
  if (lastUid !== (account.lastUid ?? 0)) {
    await app.db
      .update(mailAccounts)
      .set({ lastUid, updatedAt: new Date() })
      .where(eq(mailAccounts.id, account.id));
  }
  return { imported, failed };
}
