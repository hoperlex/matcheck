import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { loadEnv } from './env.js';
import { HttpError } from './http-error.js';

const env = loadEnv();

/**
 * ВНИМАНИЕ: на бою этот обработчик НЕ ПОДКЛЮЧЁН НИ К ОДНОМУ роуту.
 *
 * server.ts зовёт registerErrorHandler ПОСЛЕ всех app.register(...routes), а
 * дочерние контексты Fastify наследуют обработчик в момент своего создания —
 * значит все роуты остались на дефолтном обработчике фреймворка. Обёртка в
 * fastify-plugin не помогает (проверено на 5.8.5). Тесты ниже этого не видят:
 * они поднимают лёгкое приложение, где роуты объявлены на root и ПОСЛЕ
 * registerErrorHandler, то есть в конфигурации, которой в проде нет.
 *
 * Поэтому фактические статусы и тела ошибок сейчас определяет связка
 * setErrorHeaders + setErrorStatusCode внутри Fastify, и линейной формулы там
 * нет: приоритет err.status против err.statusCode зависит от того, звал ли
 * роут reply.code(). Замеры на 5.8.5:
 *   {status:418, statusCode:409} без reply.code() -> 409, с reply.code(403) -> 418;
 *   statusCode:503 -> 503; err.headers переносятся в ответ.
 *
 * Из этого следует: включать обработчик (перенос регистрации выше роутов)
 * нельзя одним движением — поедут статусы 4xx, а мобильный MutationProcessor
 * различает 4xx (Drop) и 5xx (Backoff). Начинать надо с characterization-тестов,
 * снимающих текущее поведение, и только потом менять проводку. Логирование и
 * санитизация 5xx от этого не зависят — они живут в plugins/error-visibility.ts
 * на хуках, которые работают независимо от порядка регистрации.
 *
 * Единый обработчик ошибок. Порядок выбора статуса:
 *   1) reply.statusCode, если он уже >= 400 — его выставил тот, кто ближе
 *      к контексту (например, роут через reply.code(403));
 *   2) HttpError — наши ошибки с явным статусом (см. lib/http-error.ts);
 *   3) 500 — всё остальное.
 *
 * НАМЕРЕННО не читаем err.statusCode у произвольных ошибок. Ошибки
 * валидации Fastify/zod несут statusCode=400, и такой «улучшайзинг»
 * поменял бы их ответ с 500 (как сейчас) на 400. Мобильный
 * MutationProcessor.kt на 4xx делает Drop, на 5xx — Backoff; менять
 * классификацию задним числом не нужно, поведение для мобилы должно
 * остаться ровно прежним.
 *
 * Уточнение к прежней редакции этого комментария: Drop давно НЕ удаляет
 * мутацию. MutationProcessor сохраняет её с conflictPending=true и
 * lastError, чтобы причина была видна в «Очереди синхронизации» — данные
 * приёмки при 4xx не теряются.
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
  // `details` отдаём только у НАШИХ 4xx. Два ограничения, и оба намеренные:
  // произвольная ошибка с уже выставленным 4xx (например, из библиотеки) могла
  // бы принести наружу внутренние данные, а у 5xx подробности закрыты всегда —
  // там в тексте оказывается SQL с параметрами.
  const details = err instanceof HttpError && status < 500 ? err.details : undefined;
  reply.send({
    error: error.name ?? 'internal_error',
    message: hideDetails ? 'Internal error' : error.message,
    ...(details !== undefined ? { details } : {}),
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
