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
  // Odyssey пускает пользователя FOT_Prod.mcp_readonly не более чем 4 подключениями
  // (лимит общий на всех, кто ходит этим логином). max:1 и короткий простой
  // оставляют место MCP/SSH-сессиям, а их подключения не отнимают пул у matcheck-api.
  // Правка работала на бою с 05.11 (образ собран из незакоммиченной копии),
  // в git перенесена 10.11 без изменения кода.
  pool = postgres(env.FOT_DATABASE_URL, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: 'matcheck-api-fot-ro',
    },
  });
  return pool;
}
