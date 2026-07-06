/**
 * Инициализация Sentry для веб-портала. Импортируется ПЕРВОЙ строкой в main.tsx
 * (до `import { App }`), чтобы router-factory уже был обёрнут на момент рендера.
 *
 * No-op, если VITE_SENTRY_DSN не задан на этапе сборки (dev/локально события не шлём).
 * Безопасность: sendDefaultPii:false; beforeSend вырезает чувствительные заголовки,
 * share-токен из URL и любые query-строки (в т.ч. подписи signed photo/S3 URL);
 * beforeBreadcrumb дропает ui.input (значения полей форм логина/кредов) и чистит URL.
 */
import * as Sentry from '@sentry/react';
import { useEffect } from 'react';
import {
  useLocation,
  useNavigationType,
  createRoutesFromChildren,
  matchRoutes,
} from 'react-router-dom';

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-csrf-token'];

function scrubUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  const noToken = url.replace(/\/share\/[^/?#]+/i, '/share/[token]');
  const q = noToken.indexOf('?');
  return q === -1 ? noToken : noToken.slice(0, q);
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    integrations: [
      Sentry.reactRouterV7BrowserTracingIntegration({
        useEffect,
        useLocation,
        useNavigationType,
        createRoutesFromChildren,
        matchRoutes,
      }),
    ],
    beforeSend(event) {
      const req = event.request;
      if (req) {
        if (req.headers) {
          for (const h of Object.keys(req.headers)) {
            if (SENSITIVE_HEADERS.includes(h.toLowerCase())) req.headers[h] = '[REDACTED]';
          }
        }
        req.url = scrubUrl(req.url);
        delete req.query_string;
        delete req.cookies;
      }
      return event;
    },
    beforeBreadcrumb(breadcrumb) {
      // Значения полей ввода (логин/пароль/креды) не сохраняем вовсе.
      if (breadcrumb.category === 'ui.input') return null;
      if (breadcrumb.data && typeof breadcrumb.data.url === 'string') {
        breadcrumb.data.url = scrubUrl(breadcrumb.data.url) ?? breadcrumb.data.url;
      }
      return breadcrumb;
    },
  });
}
