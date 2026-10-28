/**
 * Транспорт EstiMat: ветвление по коду отказа и recovery, паузы из Retry-After,
 * отказ токена без повторов, токен не попадает ни в один текст ошибки.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createEstimatClient,
  EstimatAborted,
  EstimatAuthError,
  EstimatCursorError,
  EstimatError,
} from '../src/domain/estimat/estimat.http.js';

const BASE = 'https://api.estimat.su10.ru/api/external/v1';
const TOKEN = 'estm_prefix01.secretsecretsecret';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json({ error, message: `${error} — текст`, failureClass: 'x', recovery: { strategy: 'none', sameIdempotencyKey: false }, requestId: `req-${error}`, ...extra }, status, headers);
const page = (n: number, nextCursor: string | null) => json({ data: new Array(n).fill({}), meta: { limit: 100, nextCursor } });

function fetchSeq(...responses: (Response | Error)[]) {
  return vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('лишний запрос');
    if (next instanceof Error) throw next;
    return next;
  });
}

function client(fetchImpl: ReturnType<typeof fetchSeq>, extra: Record<string, unknown> = {}) {
  const sleep = vi.fn(async () => {});
  const onWait = vi.fn();
  const c = createEstimatClient({ baseUrl: BASE, token: TOKEN, fetchImpl: fetchImpl as never, sleep, onWait, ...extra });
  return { c, sleep, onWait };
}

describe('запрос', () => {
  it('Bearer, Accept, limit=100, курсор без изменений', async () => {
    const fetchImpl = fetchSeq(page(0, null));
    const { c } = client(fetchImpl);
    const cursor = 'eyJ+/=a b&c';
    await c.listSupplierOrders(cursor);
    const [url, init] = fetchImpl.mock.calls[0]!;
    const u = new URL(String(url));
    expect(u.origin + u.pathname).toBe(`${BASE}/supplier-orders`);
    expect(u.searchParams.get('limit')).toBe('100');
    expect(u.searchParams.get('cursor')).toBe(cursor);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect((init!.headers as Record<string, string>).Accept).toBe('application/json');
    expect(init!.redirect).toBe('manual');
  });

  it('первая страница — без курсора', async () => {
    const fetchImpl = fetchSeq(page(0, null));
    await client(fetchImpl).c.listSupplierOrders(null);
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.has('cursor')).toBe(false);
  });

  it('спецификация запрашивается без токена', async () => {
    const fetchImpl = fetchSeq(json({ info: { version: '1.6.0' } }));
    expect(await client(fetchImpl).c.openapiVersion()).toBe('1.6.0');
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('HTML вместо JSON — bad_content_type', async () => {
    const fetchImpl = fetchSeq(new Response('<html>вход</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(client(fetchImpl).c.listSupplierOrders(null)).rejects.toMatchObject({ code: 'bad_content_type' });
  });

  it('редирект — ошибка, а не следование за ним', async () => {
    const fetchImpl = fetchSeq(new Response(null, { status: 302, headers: { location: 'https://estimat.su10.ru/login' } }));
    await expect(client(fetchImpl).c.listSupplierOrders(null)).rejects.toMatchObject({ code: 'redirect' });
  });
});

describe('повторы', () => {
  it('429 с Retry-After: onWait, пауза, повтор', async () => {
    const fetchImpl = fetchSeq(fail(429, 'rate_limited', {}, { 'retry-after': '7' }), page(1, null));
    const { c, sleep, onWait } = client(fetchImpl);
    const p = await c.listSupplierOrders(null);
    expect(p.data).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onWait).toHaveBeenCalledTimes(1);
    const ms = (sleep.mock.calls[0] as unknown as [number])[0];
    expect(ms).toBeGreaterThanOrEqual(7000 * 0.8);
    expect(ms).toBeLessThanOrEqual(7000 * 1.2);
  });

  it('429 больше maxAttempts — отказ rate_limited', async () => {
    const fetchImpl = fetchSeq(
      fail(429, 'rate_limited', { recovery: { strategy: 'retry_same_key', sameIdempotencyKey: false, maxAttempts: 2 } }),
      fail(429, 'rate_limited'),
    );
    await expect(client(fetchImpl).c.listSupplierOrders(null)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('без повторов на 429, если так просили (состав по требованию)', async () => {
    const fetchImpl = fetchSeq(fail(429, 'rate_limited'));
    const { c, sleep } = client(fetchImpl, { retryRateLimit: false });
    await expect(c.getSupplierOrderItems('3f6c2a1e-0000-4000-8000-000000000001')).rejects.toMatchObject({ code: 'rate_limited' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('503 database_busy — пауза из recovery.retryAfterSec', async () => {
    const fetchImpl = fetchSeq(
      fail(503, 'database_busy', { recovery: { strategy: 'retry_same_key', sameIdempotencyKey: false, retryAfterSec: 3 } }),
      page(0, null),
    );
    const { c, sleep } = client(fetchImpl);
    await c.listSupplierOrders(null);
    const ms = (sleep.mock.calls[0] as unknown as [number])[0];
    expect(ms).toBeGreaterThanOrEqual(3000 * 0.8);
    expect(ms).toBeLessThanOrEqual(3000 * 1.2);
  });

  it('500 internal_error — нарастающие паузы, затем сдача', async () => {
    const fetchImpl = fetchSeq(...Array.from({ length: 4 }, () => fail(500, 'internal_error')));
    const { c, sleep } = client(fetchImpl);
    await expect(c.listSupplierOrders(null)).rejects.toMatchObject({ code: 'internal_error', requestId: 'req-internal_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const waits = sleep.mock.calls.map((c) => (c as unknown as [number])[0]);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    expect(waits[2]!).toBeGreaterThan(waits[1]!);
  });

  it('сетевой сбой — повтор, потом network', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetchImpl = fetchSeq(netErr, page(0, null));
    await client(fetchImpl).c.listSupplierOrders(null);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const always = fetchSeq(netErr, netErr, netErr, netErr);
    await expect(client(always).c.listSupplierOrders(null)).rejects.toMatchObject({ code: 'network' });
  });
});

describe('отказы без повторов', () => {
  it('401 api_token_revoked — EstimatAuthError сразу', async () => {
    const fetchImpl = fetchSeq(fail(401, 'api_token_revoked'));
    const err = await client(fetchImpl).c.listSupplierOrders(null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EstimatAuthError);
    expect(err).toMatchObject({ code: 'api_token_revoked', status: 401, requestId: 'req-api_token_revoked' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('403 insufficient_scope — missing попадает в сообщение', async () => {
    const fetchImpl = fetchSeq(fail(403, 'insufficient_scope', { details: { missing: ['purchases:read'] } }));
    const err = (await client(fetchImpl).c.listSupplierOrders(null).catch((e: unknown) => e)) as EstimatAuthError;
    expect(err).toBeInstanceOf(EstimatAuthError);
    expect(err.message).toContain('purchases:read');
  });

  it('400 invalid_cursor — EstimatCursorError', async () => {
    const fetchImpl = fetchSeq(fail(400, 'invalid_cursor'));
    await expect(client(fetchImpl).c.listSupplierOrders('old')).rejects.toBeInstanceOf(EstimatCursorError);
  });

  it('прочие коды — EstimatError с кодом из тела', async () => {
    const fetchImpl = fetchSeq(fail(404, 'not_found'));
    const err = await client(fetchImpl).c.getSupplierOrderItems('3f6c2a1e-0000-4000-8000-000000000001').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EstimatError);
    expect(err).toMatchObject({ code: 'not_found' });
  });
});

describe('секреты и остановка', () => {
  it('токен не попадает в текст ошибки, даже если сервер его повторил', async () => {
    const fetchImpl = fetchSeq(fail(401, 'api_token_invalid', { message: `токен ${TOKEN} не найден` }));
    const err = (await client(fetchImpl).c.listSupplierOrders(null).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain('secretsecret');
  });

  it('путь вне разрешённых — ошибка программы, запрос не уходит', async () => {
    const fetchImpl = fetchSeq();
    await expect(client(fetchImpl).c.getSupplierOrderItems('../projects')).rejects.toThrow(/не разрешён/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('остановка во время паузы — EstimatAborted', async () => {
    const controller = new AbortController();
    const fetchImpl = fetchSeq(fail(429, 'rate_limited', {}, { 'retry-after': '60' }));
    const c = createEstimatClient({ baseUrl: BASE, token: TOKEN, fetchImpl: fetchImpl as never, signal: controller.signal });
    const p = c.listSupplierOrders(null);
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toBeInstanceOf(EstimatAborted);
  });

  it('capabilities: projectId и права', async () => {
    const fetchImpl = fetchSeq(
      json({ data: { role: 'r', scopes: ['purchases:read'], granted: [], roleScopes: [], projectId: null, expiresAt: null, apiVersion: '1.6.0', contractSha256: null } }),
    );
    expect(await client(fetchImpl).c.capabilities()).toMatchObject({ scopes: ['purchases:read'], projectId: null });
  });
});

