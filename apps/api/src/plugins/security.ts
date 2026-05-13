import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { loadEnv } from '../lib/env.js';

export default fp(async (app) => {
  const env = loadEnv();

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    strictTransportSecurity:
      env.NODE_ENV === 'production'
        ? { maxAge: 63072000, includeSubDomains: true, preload: true }
        : false,
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  });

  await app.register(cookie, {
    parseOptions: { secure: env.COOKIE_SECURE, sameSite: 'strict' },
  });

  await app.register(rateLimit, {
    global: false,
    redis: app.redis,
    nameSpace: 'matcheck-rl:',
    keyGenerator: (req) => `${req.ip}`,
    skipOnError: true,
  });
});
