/**
 * Инициализация Sentry ДО всего остального.
 *
 * Импортируется ПЕРВОЙ строкой в index.ts и worker.ts — чтобы Sentry.init
 * отработал раньше, чем вычислятся модули Fastify/http/undici/postgres/bullmq
 * (иначе авто-инструментация не подхватит их). Файл намеренно зависит только от
 * @sentry/node и читает process.env НАПРЯМУЮ (без loadEnv), чтобы не тянуть цепочку.
 *
 * Если SENTRY_DSN не задан — init не вызывается, всё превращается в no-op
 * (captureException/flush безопасны). Так локальная/тестовая среда не шлёт события.
 *
 * Безопасность: sendDefaultPii:false + beforeSend/beforeBreadcrump вырезают токены,
 * пароли, хэши и ПДн. Список ключей синхронизирован с redact в lib/logger.ts.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

// Ключи, значения которых НИКОГДА не уходят в Sentry (сравнение по lower-case).
const SENSITIVE_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'token',
  'refreshtoken',
  'accesstoken',
  'tokenhash',
  'passwordhash',
  'authorization',
  'cookie',
  'set-cookie',
  'apikey',
  'api_key',
  'csrf',
  'x-csrf-token',
  'email',
  'senderemail',
  'fullname',
  'full_name',
  'phone',
]);

function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Вырезаем share-токен из пути и любую query-строку (в т.ч. presigned-подписи).
function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const noShareToken = url.replace(/\/share\/[^/?#]+/i, '/share/[token]');
  const q = noShareToken.indexOf('?');
  return q === -1 ? noShareToken : noShareToken.slice(0, q);
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0') || 0,
    sendDefaultPii: false,
    beforeSend(event) {
      const req = event.request;
      if (req) {
        delete req.cookies;
        delete req.query_string;
        if (req.headers) {
          for (const h of Object.keys(req.headers)) {
            if (SENSITIVE_KEYS.has(h.toLowerCase())) req.headers[h] = '[REDACTED]';
          }
        }
        if (req.data !== undefined) req.data = redactDeep(req.data);
        req.url = scrubUrl(req.url);
      }
      if (event.extra) event.extra = redactDeep(event.extra) as Record<string, unknown>;
      if (event.contexts) {
        event.contexts = redactDeep(event.contexts) as NonNullable<typeof event.contexts>;
      }
      if (event.user) {
        event.user = { id: event.user.id, username: undefined, ...pickIdRole(event.user) };
      }
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data) {
        if (typeof breadcrumb.data.url === 'string') {
          breadcrumb.data.url = scrubUrl(breadcrumb.data.url);
        }
        breadcrumb.data = redactDeep(breadcrumb.data) as Record<string, unknown>;
      }
      return breadcrumb;
    },
  });
}

// Оставляем в user только id и role (без email/имени/ip).
function pickIdRole(user: { id?: string | number; [k: string]: unknown }): {
  id?: string | number;
  role?: unknown;
} {
  return { id: user.id, role: user.role };
}
