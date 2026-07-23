import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Волна 0A — per-request инструментовка (baseline перед оптимизациями).
 *
 * Считаем на каждый HTTP-запрос: число SQL-запросов (ключевая метрика для
 * доказательства/устранения N+1), длительность и размер ответа. Контекст —
 * через AsyncLocalStorage: `enterWith` в самом раннем onRequest-хуке, дальше
 * каждый DB-запрос инкрементит счётчик из postgres-js `debug`-хука
 * (см. db/client.ts), а onResponse печатает структурную строку метрики.
 *
 * Всё под флагом REQUEST_METRICS_ENABLED — при выключенном флаге `debug`-хук
 * postgres-js не ставится и плагин не регистрирует хуки → нулевой оверхед.
 */
export interface RequestMetrics {
  sqlCount: number;
  startNs: bigint;
  respBytes: number;
}

const als = new AsyncLocalStorage<RequestMetrics>();

/** Инициализирует контекст метрик для текущего запроса (вызывать в onRequest). */
export function startRequestMetrics(): RequestMetrics {
  const ctx: RequestMetrics = { sqlCount: 0, startNs: process.hrtime.bigint(), respBytes: 0 };
  als.enterWith(ctx);
  return ctx;
}

/** Текущий контекст метрик (undefined вне запроса / при выключенном флаге). */
export function currentMetrics(): RequestMetrics | undefined {
  return als.getStore();
}

/** Инкремент счётчика SQL — вызывается из postgres-js `debug` на каждый запрос. */
export function recordQuery(): void {
  const ctx = als.getStore();
  if (ctx) ctx.sqlCount += 1;
}
