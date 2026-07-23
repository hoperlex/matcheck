import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Волна 0A: инструментовка запросов (число SQL/длительность/размер ответа на
  // HTTP-вызов) для baseline перед оптимизациями. Выключено по умолчанию —
  // нулевой оверхед; включать временно на staging/проде для замера пика.
  REQUEST_METRICS_ENABLED: z.coerce.boolean().default(false),

  // DB / Redis
  DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(30),
  REDIS_URL: z.string().optional(),

  // Внешняя БД ФОТ (read-only) — список МОЛ. Отдельный пул, не основной.
  // Если не задан — эндпоинт /api/v1/mol отдаёт пустой список с флагом stale.
  FOT_DATABASE_URL: z.string().url().optional(),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // JWT (Ed25519)
  JWT_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_PUBLIC_KEY_PEM: z.string().optional(),
  JWT_ISSUER: z.string().default('matcheck-api'),
  JWT_AUDIENCE: z.string().default('matcheck-web'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(14),
  REFRESH_TOKEN_ABSOLUTE_MAX_DAYS: z.coerce.number().int().positive().default(90),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // CSRF
  CSRF_SECRET: z.string().min(32).optional(),

  // Field encryption (AES-256-GCM, key map JSON)
  APP_FIELD_ENCRYPTION_KEYS: z
    .string()
    .default('{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}'),
  APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: z.string().default('v1'),

  // Sentry (мониторинг ошибок). instrument.ts читает process.env.SENTRY_* напрямую
  // (до цепочки модулей); здесь — только для валидации/документации. DSN публичный.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  SENTRY_RELEASE: z.string().optional(),

  // S3 (cloud.ru)
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ru-central-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
