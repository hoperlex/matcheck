import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadEnv } from '../lib/env.js';
import { recordQuery } from '../lib/request-metrics.js';
import * as schema from './schema.js';

const env = loadEnv();

const connectionString = env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/matcheck';

export const sql = postgres(connectionString, {
  // Pool под 35 объектов × 3-4 планшета (~105-140 устройств): worst-case
  // пиковая нагрузка — десятки одновременных запросов от мобил (push мутаций,
  // presign фото, confirm) + портал-менеджеры. Pool=10 захлёбывался бы в
  // утренние пики приёмок. 30 — с запасом 2.5x для штатной работы, влезает
  // в дефолтный max_connections=100 Postgres с буфером ~50 соединений на
  // superuser / бэкапы / ручные psql.
  max: env.DATABASE_POOL_MAX,
  idle_timeout: 30,
  prepare: false,
  // Волна 0A: считаем SQL на HTTP-запрос (baseline для N+1). `debug` вызывается
  // postgres-js на каждый запрос; ставим ТОЛЬКО при включённом флаге — иначе
  // хук не задаётся и оверхед нулевой.
  ...(env.REQUEST_METRICS_ENABLED ? { debug: () => recordQuery() } : {}),
});

export const db = drizzle(sql, { schema, casing: 'snake_case' });

export type Db = typeof db;
export { schema };
