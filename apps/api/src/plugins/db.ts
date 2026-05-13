import fp from 'fastify-plugin';
import { db, sql } from '../db/client.js';
import type { Db } from '../db/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export default fp(async (app) => {
  app.decorate('db', db);
  app.addHook('onClose', async () => {
    try {
      await sql.end({ timeout: 5 });
    } catch {
      /* ignore */
    }
  });
});
