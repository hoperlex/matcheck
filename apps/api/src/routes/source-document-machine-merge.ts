/**
 * «Объединить в одну машину» / «Разъединить» в «Документах».
 *
 * Логика — domain/sourceDocuments/machine-merge.ts; здесь только HTTP: права,
 * тексты отказов, повтор транзакции и события для портала и планшетов.
 *
 * Права — как у «Разрешить дубликат»: admin/manager плюс матрица
 * «Документы × Редактировать» (route-map.ts), то есть мониторинг с галочкой.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  ErrorResponseSchema,
  MachineMergeConfigResponseSchema,
  MachineMergePreviewRequestSchema,
  MachineMergePreviewResponseSchema,
  MachineMergeRequestSchema,
  MachineMergeResponseSchema,
  MachineUnmergeRequestSchema,
  MachineUnmergeResponseSchema,
  type MachineMergeBlocker,
} from '@matcheck/contracts';
import type { Db } from '../db/client.js';
import { sites } from '../db/schema.js';
import { asZod } from '../lib/fastify.js';
import { withTxRetry } from '../lib/db-retry.js';
import { machineMergeSites } from '../domain/groups/claim-scope.js';
import {
  analyzeMerge,
  blockerStatus,
  mergeMachines,
  unmergeMachine,
} from '../domain/sourceDocuments/machine-merge.js';
import { publishEvent } from './events.js';

/** Тело отказа: код, текст для окна и подробности (для подсветки строк). */
const BlockerErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  blocker: z.unknown().optional(),
  documentIds: z.array(z.string().uuid()).optional(),
});

const plural = (n: number, one: string, few: string, many: string) => {
  const last = n % 10;
  const lastTwo = n % 100;
  if (last === 1 && lastTwo !== 11) return one;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return few;
  return many;
};

/** Текст отказа — его покажет окно объединения. */
export function machineMergeBlockerMessage(b: MachineMergeBlocker): string {
  const values = (list: { label: string | null; value: string | null }[]) =>
    list.map((v) => v.label ?? v.value ?? 'не указано').join(', ');
  switch (b.code) {
    case 'machine_merge_disabled':
      return 'Объединение на этом объекте ещё не включено';
    case 'tablets_not_updated':
      return `На объекте работают планшеты старой версии${
        b.userNames.length ? ` (${b.userNames.join(', ')})` : ''
      } — их нужно обновить: иначе начатый на них 1 Этап может потеряться`;
    case 'groups_rollout_off':
      return 'Объединение недоступно: машины на планшетах собираются по старому правилу';
    case 'not_found':
      return 'Документ не найден — обновите список';
    case 'not_portal_upload':
      return 'Объединять можно только документы, загруженные через портал (/uploads), — у ЭДО и почты машины нет';
    case 'upload_before_rollout':
      return 'Документ загружен до перехода на машины — его нельзя объединить';
    case 'outbound_not_supported':
      return 'Объединение пока только для приёмки';
    case 'different_sites':
      return 'Документы с разных объектов — сначала поправьте объект у одной из машин';
    case 'different_expected_dates':
      return `Разные даты поставки (${values(b.values)}) — сначала поправьте дату у одной из машин`;
    case 'different_recipients':
      return `Разные получатели (${values(b.values)}) — в одну приёмку их объединить нельзя`;
    case 'machine_has_operation': {
      const parts: string[] = [];
      if (b.deliveryNumbers.length) {
        parts.push(
          `${plural(b.deliveryNumbers.length, 'приёмке', 'приёмках', 'приёмках')} ${b.deliveryNumbers.join(', ')}`,
        );
      }
      if (b.shipments)
        parts.push(`${b.shipments} ${plural(b.shipments, 'отгрузке', 'отгрузках', 'отгрузках')}`);
      if (b.edoMatches && !b.deliveryNumbers.length) parts.push('привязке УПД из ЭДО');
      return `Документы уже в ${parts.join(' и ') || 'операции'} — сначала отвяжите их`;
    }
  }
}

function blockerReply(b: MachineMergeBlocker) {
  return {
    status: blockerStatus(b.code),
    body: { error: b.code, message: machineMergeBlockerMessage(b), blocker: b },
  };
}

export async function machineMergeRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  // Где объединение включено — портал прячет кнопку, пока нигде.
  app.get(
    '/api/v1/source-documents/machine-merge/config',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: { response: { 200: MachineMergeConfigResponseSchema } },
    },
    async () => ({ enabledSites: machineMergeSites() }),
  );

  // Предпросмотр: что станет одной машиной и почему нельзя. Без блокировок.
  app.post(
    '/api/v1/source-documents/machine-merge/preview',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: MachineMergePreviewRequestSchema,
        response: { 200: MachineMergePreviewResponseSchema },
      },
    },
    async (req) => {
      const analysis = await analyzeMerge(app.db as unknown as Db, req.body.documentIds);
      const [site] = analysis.siteId
        ? await app.db.select({ name: sites.name }).from(sites).where(eq(sites.id, analysis.siteId))
        : [];
      return {
        ...analysis,
        siteName: site?.name ?? null,
        blockerMessages: analysis.blockers.map(machineMergeBlockerMessage),
      };
    },
  );

  app.post(
    '/api/v1/source-documents/machine-merge',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: MachineMergeRequestSchema,
        response: {
          200: MachineMergeResponseSchema,
          404: BlockerErrorSchema,
          409: BlockerErrorSchema,
          422: BlockerErrorSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id ?? null;
      const outcome = await withTxRetry(
        () =>
          app.db.transaction((tx) =>
            mergeMachines(tx as unknown as Db, {
              documentIds: req.body.documentIds,
              expectedDocumentIds: req.body.expectedDocumentIds,
              userId,
            }),
          ),
        {
          onRetry: (err, attempt) =>
            req.log.warn({ err, attempt }, 'machine merge: повтор транзакции'),
        },
      );
      if (!outcome.ok) {
        if ('compositionChanged' in outcome) {
          return reply.code(409).send({
            error: 'composition_changed',
            message: 'Состав машин изменился — проверьте ещё раз',
            documentIds: outcome.compositionChanged.documentIds,
          });
        }
        const { status, body } = blockerReply(outcome.blocker);
        return reply.code(status).send(body);
      }
      if (outcome.changed) {
        req.log.info(
          {
            event: 'machine_merged',
            groupId: outcome.groupId,
            mergeId: outcome.mergeId,
            documents: outcome.documentIds.length,
            userId,
          },
          'машины объединены',
        );
        notifyDocuments(app, outcome.documentIds, outcome.siteId);
      }
      return {
        changed: outcome.changed,
        groupId: outcome.groupId,
        documentIds: outcome.documentIds,
        mergeId: outcome.mergeId,
        undoable: outcome.undoable,
      };
    },
  );

  app.post(
    '/api/v1/source-documents/machine-unmerge',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: MachineUnmergeRequestSchema,
        response: {
          200: MachineUnmergeResponseSchema,
          404: BlockerErrorSchema,
          409: BlockerErrorSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const outcome = await withTxRetry(() =>
        app.db.transaction((tx) =>
          unmergeMachine(tx as unknown as Db, {
            documentId: req.body.documentId,
            expectedDocumentIds: req.body.expectedDocumentIds,
            mergeId: req.body.mergeId ?? null,
          }),
        ),
      );
      if (!outcome.ok) {
        if ('notFound' in outcome) {
          return reply
            .code(404)
            .send({ error: 'not_found', message: 'Документ не найден — обновите список' });
        }
        if ('compositionChanged' in outcome) {
          return reply.code(409).send({
            error: 'composition_changed',
            message: 'Состав машины изменился — проверьте ещё раз',
            documentIds: outcome.compositionChanged.documentIds,
          });
        }
        // Разъединение отказывает только из-за операции по машине — это 409.
        return reply.code(409).send(blockerReply(outcome.blocker).body);
      }
      if (outcome.changed) {
        req.log.info(
          {
            event: 'machine_unmerged',
            roots: outcome.rootIds,
            documents: outcome.documentIds.length,
            userId: req.user?.id ?? null,
          },
          'машина разъединена',
        );
        notifyDocuments(app, outcome.documentIds, outcome.siteId);
      }
      return { changed: outcome.changed, documentIds: outcome.documentIds };
    },
  );
}

/**
 * После коммита: портал обновит список, планшет объекта сделает обычную
 * дельту /sync (на source_document_updated он и тянет). Объект — чтобы не
 * будить планшеты чужих объектов.
 */
function notifyDocuments(app: FastifyInstance, documentIds: string[], siteId: string | null): void {
  const ts = new Date().toISOString();
  for (const id of documentIds) {
    publishEvent(app, {
      type: 'source_document_updated',
      entityId: id,
      ...(siteId ? { siteId } : {}),
      ts,
    });
  }
}
