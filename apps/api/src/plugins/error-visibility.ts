import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { loadEnv } from '../lib/env.js';
import { clientIpOf } from '../lib/client-ip.js';

/**
 * Видимость 5xx: единое событие в логе и никаких внутренностей наружу.
 *
 * Почему хуки, а не setErrorHandler. Наш errorHandler (lib/error-handler.ts) на
 * бою не применяется НИ К ОДНОМУ роуту: в server.ts он регистрируется после
 * всех app.register(...routes), а дочерние контексты Fastify наследуют
 * обработчик в момент создания. Обёртка в fastify-plugin от этого не спасает —
 * проверено. Хуки же действуют независимо от порядка регистрации, поэтому
 * наблюдаемость чинится ими, а разбор обработчика остаётся отдельной задачей:
 * его включение меняет статусы 4xx и требует своего анти-регресса.
 *
 * Регистрируется ДО metricsPlugin и compress: onSend-хуки выполняются в порядке
 * добавления, и подменённое тело должно попасть и в замер respBytes, и в
 * компрессор — иначе метрика считает исходный размер, а сжимается не то тело.
 */

/**
 * Ошибки живут в WeakMap, а не в поле запроса: так у FastifyRequest не
 * появляется публичного свойства, которое кто-то начнёт читать как контракт.
 */
const unhandledErrors = new WeakMap<FastifyRequest, Error>();

/** Тело, которое видит клиент вместо необработанного исключения. */
export function sanitizedErrorBody(requestId: string): string {
  // Русский текст намеренно: портал во многих местах показывает message
  // напрямую (message.error(err.message)), мимо localizeApiError. requestId —
  // взамен утраченного текста: по нему строка находится в логе.
  return JSON.stringify({
    error: 'internal_error',
    message: 'Внутренняя ошибка сервера',
    requestId,
  });
}

export default fp(async (app) => {
  const env = loadEnv();
  const hideDetails = env.NODE_ENV === 'production';

  // Только запоминаем. Логировать здесь нельзя: onError срабатывает и на 4xx
  // (валидация, битый JSON, 413), и строка уровня error на каждую валидацию
  // превратила бы лог в шум.
  app.addHook('onError', async (req, _reply, err) => {
    unhandledErrors.set(req, err);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    // Заголовки уже ушли — значит маршрут пишет в сокет сам (SSE, ручной
    // стрим). Такой ответ не наш: подмена тела здесь ничего не исправит, а
    // попытка выставить заголовок роняет процесс с ERR_HTTP_HEADERS_SENT.
    // Проверка стоит первой и не зависит от статуса: hijack() у потока может
    // появиться в любом маршруте, а падение процесса — слишком дорогая плата
    // за санитизацию тела, которого клиент всё равно не увидит.
    if (reply.raw.headersSent) return payload;
    if (reply.statusCode < 500) return payload;
    if (!unhandledErrors.has(req)) return payload;
    if (!hideDetails) return payload;
    // Тело формировал Fastify из текста исключения — там оказывается SQL с
    // параметрами. Явные reply.code(5xx).send({...}) сюда не попадают: по ним
    // onError не срабатывает, и их коды остаются контрактом для клиентов.
    //
    // content-type проставляем сами: ошибка могла случиться на маршруте,
    // который уже объявил image/* или другой тип. onSend обязан вернуть
    // строку или Buffer — объект Fastify отвергает (FST_ERR_REP_INVALID_PAYLOAD_TYPE).
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.removeHeader('content-length');
    return sanitizedErrorBody(String(req.id));
  });

  // Единственная строка на каждый 5xx-ответ — и на брошенный, и на явный.
  // Собственные warn/error внутри роутов остаются, поэтому считать 5xx нужно
  // именно по event: 'http_5xx'.
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode < 500) return;
    const err = unhandledErrors.get(req);
    req.log.error(
      {
        event: 'http_5xx',
        // Только шаблон маршрута: в сыром req.url лежат share-токены и
        // публичные тикеты, им в логах не место.
        route: req.routeOptions?.url ?? null,
        method: req.method,
        status: reply.statusCode,
        reqId: req.id,
        // Не req.ip: при trustProxy: true это подделываемый левый адрес XFF.
        ip: clientIpOf(req),
        unhandled: err !== undefined,
        err,
      },
      'http 5xx',
    );
  });
});
