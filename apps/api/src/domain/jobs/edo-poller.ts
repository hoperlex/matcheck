import { and, eq, sql as drSql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  counterparties,
  edoAccounts,
  sourceDocumentItems,
  sourceDocuments,
} from '../../db/schema.js';
import type { EdoAdapter } from '../edo/adapter.js';
import { parseUpdXml } from '../edo/upd.parser.js';

async function findOrCreateCounterparty(
  app: FastifyInstance,
  party: { inn: string; kpp: string | null; name: string },
  role: 'supplier' | 'customer',
): Promise<string> {
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
      kpp: party.kpp,
      name: party.name,
      isSupplier: role === 'supplier',
      isCustomer: role === 'customer',
    })
    .returning({ id: counterparties.id });
  if (!created) throw new Error('Failed to create counterparty');
  return created.id;
}

export async function runEdoSyncForAccount(
  app: FastifyInstance,
  account: typeof edoAccounts.$inferSelect,
  adapter: EdoAdapter,
): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;
  const docs = await adapter.listIncoming(account.lastSyncAt ?? undefined);
  for (const incoming of docs) {
    try {
      const parsed = parseUpdXml(incoming.xml);
      const supplierId = await findOrCreateCounterparty(app, parsed.supplier, 'supplier');
      const recipientId = parsed.recipient
        ? await findOrCreateCounterparty(app, parsed.recipient, 'customer')
        : null;

      const [inserted] = await app.db
        .insert(sourceDocuments)
        .values({
          kind: 'upd',
          direction: 'inbound',
          origin: 'edo_diadoc',
          edoAccountId: account.id,
          providerMessageId: incoming.providerMessageId,
          supplierId,
          supplierInnRaw: parsed.supplier.inn ?? null,
          recipientId,
          // Покупатель документа — как на ручном XML-маршруте (upload-upd):
          // recipient_id здесь всегда собран из parsed.recipient, поэтому копия
          // в buyer_* переносит именно распознанную сторону, а не операционного
          // получателя. Без неё колонка «Покупатель» у документов из ЭДО пуста.
          buyerId: recipientId,
          buyerNameRaw: parsed.recipient?.name ?? null,
          buyerInnRaw: parsed.recipient?.inn ?? null,
          docNumber: parsed.docNumber,
          docDate: parsed.docDate ? new Date(parsed.docDate) : null,
          totalSum: parsed.totalSum?.toString() ?? null,
          vatSum: parsed.vatSum?.toString() ?? null,
          status: 'parsed',
        })
        // Предикат обязан ТОЧНО совпадать с условием частичного индекса
        // `source_edo_message_unique` (schema.ts: `where edo_account_id is not
        // null`). Без него PostgreSQL не находит подходящего ограничения и
        // отвечает 42P10 на КАЖДОМ документе — импорт молча уходит в `failed`.
        // Тот же дефект уже был на почтовом пути (см. mail-requests.ts); здесь
        // он не проявлялся только потому, что таблица edo_accounts пуста.
        .onConflictDoNothing({
          target: [sourceDocuments.edoAccountId, sourceDocuments.providerMessageId],
          where: drSql`${sourceDocuments.edoAccountId} is not null`,
        })
        .returning({ id: sourceDocuments.id });
      if (inserted && parsed.items.length) {
        await app.db.insert(sourceDocumentItems).values(
          parsed.items.map((it) => ({
            sourceDocumentId: inserted.id,
            nameRaw: it.nameRaw,
            qty: it.qty.toString(),
            unit: it.unit,
            price: it.price?.toString() ?? null,
            sum: it.sum?.toString() ?? null,
            vatRate: it.vatRate?.toString() ?? null,
            vatSum: it.vatSum?.toString() ?? null,
            lineNo: it.lineNo,
          })),
        );
      }
      imported += 1;
    } catch (err) {
      failed += 1;
      app.log.warn({ err, providerMessageId: incoming.providerMessageId }, 'EDO doc parse failed');
    }
  }
  await app.db
    .update(edoAccounts)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(edoAccounts.id, account.id));
  return { imported, failed };
}
