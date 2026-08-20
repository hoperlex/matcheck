/**
 * IP клиента — для rate-limit по адресу и для логов.
 *
 * req.ip брать нельзя: Fastify поднят с trustProxy: true и берёт САМЫЙ ЛЕВЫЙ
 * адрес из X-Forwarded-For, а nginx этот заголовок не заменяет, а дополняет
 * ($proxy_add_x_forwarded_for) — клиент подделал бы себе новый лимит каждым
 * запросом. X-Real-IP nginx перезаписывает своим $remote_addr, подделать его
 * нельзя; следом идёт последний элемент XFF (его добавил наш же nginx).
 *
 * Живёт отдельным модулем, а не в routes/public-upload.ts, потому что тем же
 * адресом подписывается событие http_5xx (plugins/error-visibility.ts): по нему
 * запись сопоставляется со строкой nginx access.log, и разъехаться эти две
 * трактовки «кто клиент» не должны.
 */
export function clientIpOf(req: { headers: Record<string, unknown>; ip: string }): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return req.ip;
}
