import type { FastifyRequest } from 'fastify';

/**
 * Запрос пришёл с мобильного клиента.
 *
 * Планшет ставит заголовок на КАЖДЫЙ запрос (AuthHeaderInterceptor в
 * matcheck.mobile), веб его не ставит вовсе. Различать источник приходится там,
 * где один и тот же маршрут обслуживает оба клиента с разными договорённостями:
 * например, refresh-token мобильному отдаётся в теле (cookie он хранить не
 * может), а единицу измерения из документа восстанавливаем только мобильным
 * запросам — на портале её выбирают руками, и подменять выбор менеджера нельзя.
 */
export function isMobileClient(req: FastifyRequest): boolean {
  return req.headers['x-client-type'] === 'mobile';
}
