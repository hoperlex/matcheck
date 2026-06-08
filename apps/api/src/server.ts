import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { loadEnv } from './lib/env.js';
import { logger } from './lib/logger.js';
import dbPlugin from './plugins/db.js';
import redisPlugin from './plugins/redis.js';
import queuePlugin from './plugins/queue.js';
import securityPlugin from './plugins/security.js';
import authPlugin from './plugins/auth.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { counterpartyRoutes } from './routes/counterparties.js';
import { siteRoutes } from './routes/sites.js';
import { materialRoutes } from './routes/materials.js';
import { responsiblePersonRoutes } from './routes/responsiblePersons.js';
import { molRoutes } from './routes/mol.js';
import { assetRoutes } from './routes/assets.js';
import { sourceDocumentRoutes } from './routes/source-documents.js';
import { deliveryRoutes } from './routes/deliveries.js';
import { shipmentRoutes } from './routes/shipments.js';
import { reportRoutes } from './routes/reports.js';
import { statusRoutes } from './routes/statuses.js';
import { photoRoutes } from './routes/photos.js';
import { syncRoutes } from './routes/sync.js';
import { eventsRoutes } from './routes/events.js';
import { llmProviderRoutes } from './routes/admin/llm-providers.js';
import { llmProviderCredentialRoutes } from './routes/admin/llm-provider-credentials.js';
import { edoAccountRoutes } from './routes/admin/edo-accounts.js';
import { mailAccountRoutes } from './routes/admin/mail-accounts.js';
import { userAdminRoutes } from './routes/admin/users.js';
import { appSettingsRoutes } from './routes/admin/settings.js';
import { promptRoutes } from './routes/admin/prompts.js';
import { shareRoutes } from './routes/share.js';
import { shareMessageRoutes } from './routes/share-messages.js';

export async function buildServer() {
  const env = loadEnv();

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: env.NODE_ENV === 'production',
    trustProxy: true,
    // Потолок ожидания запроса (не задержка). Нужен для тяжёлых УПД-PDF,
    // где LLM может работать несколько минут — см. parse-upd-pdf.
    requestTimeout: 660_000,
    keepAliveTimeout: 70_000,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(redisPlugin);
  await app.register(dbPlugin);
  await app.register(queuePlugin);
  await app.register(securityPlugin);
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  });
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(counterpartyRoutes);
  await app.register(siteRoutes);
  await app.register(materialRoutes);
  await app.register(responsiblePersonRoutes);
  await app.register(molRoutes);
  await app.register(assetRoutes);
  await app.register(sourceDocumentRoutes);
  await app.register(deliveryRoutes);
  await app.register(shipmentRoutes);
  await app.register(reportRoutes);
  await app.register(statusRoutes);
  await app.register(photoRoutes);
  await app.register(syncRoutes);
  await app.register(eventsRoutes);
  await app.register(llmProviderRoutes);
  await app.register(llmProviderCredentialRoutes);
  await app.register(edoAccountRoutes);
  await app.register(mailAccountRoutes);
  await app.register(userAdminRoutes);
  await app.register(appSettingsRoutes);
  await app.register(promptRoutes);
  await app.register(shareRoutes);
  await app.register(shareMessageRoutes);

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request error');
    if (reply.statusCode < 400) reply.code(500);
    const error = err as Error & { code?: string };
    reply.send({
      error: error.name ?? 'internal_error',
      message: env.NODE_ENV === 'production' ? 'Internal error' : error.message,
    });
  });

  return app;
}
