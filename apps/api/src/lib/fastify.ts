import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export type AppWithZod = ReturnType<typeof asZod>;

export function asZod(app: FastifyInstance) {
  return app.withTypeProvider<ZodTypeProvider>();
}
