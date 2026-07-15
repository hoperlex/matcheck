import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { loadEnv } from './env.js';
import { HttpError } from './http-error.js';

const env = loadEnv();

/**
 * Единый обработчик ошибок. Порядок выбора статуса:
 *   1) reply.statusCode, если он уже >= 400 — его выставил тот, кто ближе
 *      к контексту (например, роут через reply.code(403));
 *   2) HttpError — наши ошибки с явным статусом (см. lib/http-error.ts);
 *   3) 500 — всё остальное.
 *
 * НАМЕРЕННО не читаем err.statusCode у произвольных ошибок. Ошибки
 * валидации Fastify/zod несут statusCode=400, и такой «улучшайзинг»
 * поменял бы их ответ с 500 (как сейчас) на 400. Мобильный
 * MutationProcessor.kt на 4xx делает Drop — мутация удаляется из очереди
 * вместе с данными приёмки, тогда как на 5xx он делает Backoff и запись
 * остаётся. Поведение для мобилы должно остаться ровно прежним.
 */
export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  req.log.error({ err }, 'request error');
  const fromReply = reply.statusCode >= 400 ? reply.statusCode : null;
  const fromError = err instanceof HttpError ? err.statusCode : null;
  const status = fromReply ?? fromError ?? 500;
  reply.code(status);
  const error = err as Error & { code?: string };
  // Детали 5xx наружу не отдаём — в них попадает текст SQL с параметрами.
  // Сообщения HttpError — часть контракта («Некорректная дата в arrivedTo»),
  // их отдаём всегда.
  const hideDetails = status >= 500 && env.NODE_ENV === 'production';
  reply.send({
    error: error.name ?? 'internal_error',
    message: hideDetails ? 'Internal error' : error.message,
  });
}

/**
 * Требуем от инстанса только setErrorHandler, а не полный FastifyInstance:
 * боевой app — это Fastify({loggerInstance}).withTypeProvider<ZodTypeProvider>(),
 * его дженерики (Logger<never, boolean> вместо FastifyBaseLogger) не совпадают
 * с базовыми, и точная сигнатура заставила бы звать это через `as`.
 */
export function registerErrorHandler(app: {
  setErrorHandler(handler: typeof errorHandler): unknown;
}): void {
  app.setErrorHandler(errorHandler);
}
