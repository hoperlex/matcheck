import fp from 'fastify-plugin';
import { loadEnv } from '../lib/env.js';
import { startRequestMetrics, currentMetrics } from '../lib/request-metrics.js';

/**
 * Волна 0A — плагин per-request метрик (baseline перед оптимизациями).
 *
 * Под флагом REQUEST_METRICS_ENABLED. При выключенном флаге плагин НЕ вешает
 * хуки (нулевой оверхед). При включённом — на каждый ответ печатает структурную
 * строку `req-metric`: route/method/status/durMs/sql/respBytes/role. Из неё
 * агрегируются p95/p99 latency, число SQL на вызов (детект N+1) и размер ответа
 * по разделам — метрики SLO из плана.
 *
 * Регистрируется РАНЬШЕ authPlugin, чтобы ALS-контекст был активен уже для
 * запросов attachUser (тогда SQL аутентификации тоже попадают в счёт), а роль
 * читается на onResponse из req.user, который к тому моменту проставлен.
 */
export default fp(async (app) => {
  const env = loadEnv();
  if (!env.REQUEST_METRICS_ENABLED) return;

  app.addHook('onRequest', async () => {
    startRequestMetrics();
  });

  app.addHook('onSend', async (_req, _reply, payload) => {
    const ctx = currentMetrics();
    if (ctx) {
      if (typeof payload === 'string') ctx.respBytes = Buffer.byteLength(payload);
      else if (Buffer.isBuffer(payload)) ctx.respBytes = payload.length;
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const ctx = currentMetrics();
    if (!ctx) return;
    const durMs = Number(process.hrtime.bigint() - ctx.startNs) / 1e6;
    req.log.info(
      {
        metric: 'request',
        route: req.routeOptions?.url ?? req.url,
        method: req.method,
        status: reply.statusCode,
        durMs: Math.round(durMs * 10) / 10,
        sql: ctx.sqlCount,
        respBytes: ctx.respBytes,
        role: req.user?.role ?? null,
      },
      'req-metric',
    );
  });
});
