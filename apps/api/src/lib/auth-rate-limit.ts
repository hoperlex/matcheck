import type { FastifyRequest, preHandlerHookHandler } from 'fastify';

type Noun = 'входа' | 'регистрации' | 'сброса пароля';

export interface BurstyRateLimitOptions {
  burst: number;
  burstWindowSec: number;
  slowWindowSec: number;
  keyPrefix: string;
  noun: Noun;
  /**
   * Что считаем за «одного клиента». По умолчанию — IP.
   *
   * Одного IP мало для сброса пароля: за офисным NAT сидят десятки человек, и
   * лимит по адресу либо бьёт по всем сразу, либо (если ослабить) позволяет
   * долбить форму по конкретному email. Поэтому на такие роуты вешаются два
   * независимых лимитера — по IP и по значению из тела (хэш email или токена).
   *
   * Вернуть null — пропустить проверку: значения нет (например, невалидное
   * тело), и ключ, по которому считать, тоже отсутствует.
   */
  keyOf?: (req: FastifyRequest) => string | null;
}

export function createBurstyRateLimit(opts: BurstyRateLimitOptions): preHandlerHookHandler {
  const { burst, burstWindowSec, slowWindowSec, keyPrefix, noun, keyOf } = opts;

  return async function burstyRateLimit(req, reply) {
    const app = req.server;
    const subject = keyOf ? keyOf(req) : req.ip;
    if (subject === null) return;
    const slowKey = `matcheck-rl:${keyPrefix}:slow:${subject}`;
    const fastKey = `matcheck-rl:${keyPrefix}:fast:${subject}`;

    try {
      const count = await app.redis.incr(slowKey);
      if (count === 1) {
        await app.redis.expire(slowKey, burstWindowSec);
      }
      if (count <= burst) return;

      const fcount = await app.redis.incr(fastKey);
      if (fcount === 1) {
        await app.redis.expire(fastKey, slowWindowSec);
      }
      if (fcount <= 1) return;

      const ttl = await app.redis.ttl(fastKey);
      const retryAfter = ttl > 0 ? ttl : slowWindowSec;
      reply.header('Retry-After', String(retryAfter));
      return reply.code(429).send({
        error: 'rate_limit_exceeded',
        message: `Слишком много попыток ${noun}. Повторите через ${retryAfter} сек.`,
      });
    } catch (err) {
      app.log.warn({ err, keyPrefix, subject }, 'bursty rate limit skipped (redis error)');
    }
  };
}
