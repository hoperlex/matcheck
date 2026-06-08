import postgres, { type Sql } from 'postgres';
import { loadEnv } from '../lib/env.js';

/**
 * Отдельный read-only пул к внешней БД ФОТ (Yandex Managed PostgreSQL).
 * НЕ основной DATABASE_URL — только SELECT из `public.mol_persons`.
 *
 * CA (Yandex root) подаётся через NODE_EXTRA_CA_CERTS — postgres-js не парсит
 * `sslrootcert` из URL (так же, как основной клиент db/client.ts). На проде
 * это /etc/ssl/yandex/root.crt (тот же CA, что у основной БД).
 *
 * Если FOT_DATABASE_URL не сконфигурирован — пул не создаётся (getFotPool
 * вернёт null), и роут /api/v1/mol деградирует мягко (пустой список + stale).
 */
let pool: Sql | null = null;
let initialized = false;

export function getFotPool(): Sql | null {
  if (initialized) return pool;
  initialized = true;
  const env = loadEnv();
  if (!env.FOT_DATABASE_URL) return null;
  pool = postgres(env.FOT_DATABASE_URL, {
    max: 2,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  return pool;
}
