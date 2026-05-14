import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import { StatusListResponseSchema } from '@matcheck/contracts';
import { statuses } from '../db/schema.js';

const ListQuerySchema = z.object({
  entity: z.string().min(1).max(64),
});

export async function statusRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);
  app.get(
    '/api/v1/statuses',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: ListQuerySchema,
        response: { 200: StatusListResponseSchema },
      },
    },
    async (req) => {
      const rows = await app.db
        .select()
        .from(statuses)
        .where(eq(statuses.entityType, req.query.entity))
        .orderBy(asc(statuses.sortOrder), asc(statuses.label));
      return {
        items: rows.map((s) => ({
          id: s.id,
          entityType: s.entityType,
          code: s.code,
          label: s.label,
          color: s.color,
          sortOrder: s.sortOrder,
        })),
      };
    },
  );
}
