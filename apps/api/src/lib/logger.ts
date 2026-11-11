import { pino } from 'pino';
import { loadEnv } from './env.js';

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      'currentPassword',
      'newPassword',
      'authorization',
      'cookie',
      'token',
      'refreshToken',
      'apiKey',
      'api_key',
      // Машинный канал 1С: секрет учётки и выданный токен (OAuth-имена полей).
      'client_secret',
      'access_token',
      '*.client_secret',
      '*.access_token',
      '*.password',
      '*.token',
      'headers.authorization',
      'headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});
