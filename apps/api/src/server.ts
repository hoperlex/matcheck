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
import { supplierRoutes } from './routes/suppliers.js';
import { customerCounterpartyRoutes } from './routes/customer-counterparties.js';
import { siteRoutes } from './routes/sites.js';
import { unitRoutes } from './routes/units.js';
import { materialRoutes } from './routes/materials.js';
import { responsiblePersonRoutes } from './routes/responsiblePersons.js';
import { molRoutes, warmUpFotMolCache } from './routes/mol.js';
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

  // Read-only guard для роли contractor. Регистрируем ПОСЛЕ authPlugin, чтобы
  // req.user был уже прикреплён его onRequest-хуком. Метод-ориентированный:
  // любой мутирующий запрос (POST/PUT/PATCH/DELETE) от подрядчика → 403, кроме
  // self-service под /api/v1/auth/ (logout, PATCH /me, смена пароля). Иммунен к
  // добавлению новых write-эндпоинтов — не нужно закрывать каждый вручную.
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  app.addHook('onRequest', async (req, reply) => {
    if (req.user?.role !== 'contractor') return;
    if (!MUTATING.has(req.method.toUpperCase())) return;
    if (req.url.startsWith('/api/v1/auth/')) return;
    req.log.warn({ path: req.url, method: req.method }, 'contractor write blocked (read-only)');
    return reply.code(403).send({ error: 'forbidden', message: 'Read-only role' });
  });

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(counterpartyRoutes);
  await app.register(supplierRoutes);
  await app.register(customerCounterpartyRoutes);
  await app.register(siteRoutes);
  await app.register(unitRoutes);
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

  // Глобальный onSend hook: проставляем no-store / Vary: Authorization на
  // все API-ответы, чтобы PWA Service Worker / прокси / CDN не отдавали
  // ответ одного пользователя другому при смене JWT в той же вкладке.
  // Реальный кейс: в Firefox у разных аккаунтов отображался один и тот
  // же закэшированный ответ /reports/operations-counters (см. отчёт от
  // 2026-06-16). Hook идемпотентный: если endpoint сам уже выставил
  // Cache-Control (SSE /events, photos /content?thumb, share, raw),
  // мы не затираем — сохраняем осознанные политики кэширования.
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.getHeader('cache-control')) {
      reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
    }
    const existingVary = reply.getHeader('vary');
    if (existingVary) {
      const varyStr = String(existingVary);
      if (!varyStr.toLowerCase().split(',').map((s) => s.trim()).includes('authorization')) {
        reply.header('vary', `${varyStr}, Authorization`);
      }
    } else {
      reply.header('vary', 'Authorization');
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request error');
    if (reply.statusCode < 400) reply.code(500);
    const error = err as Error & { code?: string };
    reply.send({
      error: error.name ?? 'internal_error',
      message: env.NODE_ENV === 'production' ? 'Internal error' : error.message,
    });
  });

  // Подтянуть актуальный список МОЛ из ФОТ и зеркалить в
  // responsible_persons сразу после регистрации плагинов — чтобы
  // выпадающие списки во всех формах работали из коробки. Не блокирует
  // listen (fire-and-forget из onReady-хука), при недоступной ФОТ молча
  // логирует.
  app.addHook('onReady', async () => {
    void warmUpFotMolCache(app.db, app.log);
    // Каждые 10 мин пересинхронизируем без участия UI. Совпадает с TTL
    // кэша /mol и матчится с ожиданием «обновился ФОТ → в течение 10 мин
    // увижу на портале». Не делаем чаще, чтобы не нагружать ФОТ-БД.
    const FOT_MOL_RESYNC_MS = 10 * 60 * 1000;
    const timer = setInterval(() => {
      void warmUpFotMolCache(app.db, app.log);
    }, FOT_MOL_RESYNC_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  });

  return app;
}
