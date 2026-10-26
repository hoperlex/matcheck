import type { FastifyInstance } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ErrorResponseSchema, RecipientSuggestionResponseSchema } from '@matcheck/contracts';
import { asZod } from '../lib/fastify.js';
import {
  counterparties,
  customerCounterparties,
  deliveries,
  deliverySources,
  sourceDocuments,
} from '../db/schema.js';
import { loadOwnInns } from '../domain/sourceDocuments/supplier-inn-check.js';
import {
  candidateInns,
  pickRecipientSuggestion,
} from '../domain/sourceDocuments/recipient-suggestion.js';

/**
 * Подсказка для чипа «Получатель» карточки приёмки: подрядчик, которого
 * называют стороны привязанных документов. Только чтение — подставляет и
 * сохраняет человек (см. domain/sourceDocuments/recipient-suggestion.ts).
 *
 * Круг доступа тот же, что у POST /counterparties/from-directory, которым
 * подсказку применяют: admin/manager, расширение — по правке приёмок
 * (route-map). Подсказка без права её применить была бы бесполезна.
 */
export function registerDeliveryRecipientRoutes(rawApp: FastifyInstance): void {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/deliveries/:id/recipient-suggestion',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: RecipientSuggestionResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const [delivery] = await app.db
        .select({ id: deliveries.id })
        .from(deliveries)
        .where(eq(deliveries.id, req.params.id))
        .limit(1);
      if (!delivery) return reply.code(404).send({ error: 'not_found' });

      const docs = await app.db
        .select({
          id: sourceDocuments.id,
          buyerInn: sourceDocuments.buyerInnRaw,
          consigneeInn: sourceDocuments.consigneeInnRaw,
        })
        .from(deliverySources)
        .innerJoin(sourceDocuments, eq(sourceDocuments.id, deliverySources.sourceDocumentId))
        .where(eq(deliverySources.deliveryId, delivery.id))
        .orderBy(asc(sourceDocuments.id));
      const inns = candidateInns(docs);
      if (inns.length === 0) return { suggestion: null };

      const [directory, ownInns, operational] = await Promise.all([
        app.db
          .select({
            id: customerCounterparties.id,
            name: customerCounterparties.name,
            inn: customerCounterparties.inn,
          })
          .from(customerCounterparties)
          .orderBy(asc(customerCounterparties.name), asc(customerCounterparties.id)),
        loadOwnInns(app.db),
        // Тем же равенством, что шаг 1 from-directory: ИНН справочника там
        // очищается до цифр и сравнивается с counterparties.inn как есть.
        app.db
          .selectDistinct({ inn: counterparties.inn })
          .from(counterparties)
          .where(inArray(counterparties.inn, inns)),
      ]);

      return {
        suggestion: pickRecipientSuggestion(
          docs,
          directory,
          ownInns,
          new Set(operational.map((r) => r.inn)),
        ),
      };
    },
  );
}
