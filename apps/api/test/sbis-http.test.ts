/**
 * Транспорт к API СБИС: разрешающий список адресов и методов, матрица ошибок,
 * лимит тела, маска секретов.
 *
 * Первая группа — главная. Все методы СБИС идут на один адрес, поэтому
 * обещание «только чтение» держит список методов: если кто-то добавит вызов
 * записи или отправки, тест обязан упасть раньше, чем запрос уйдёт в сеть.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SBIS_URLS,
  SbisAccessDenied,
  SbisAuthExpired,
  SbisGone,
  SbisPayloadTooLarge,
  SbisRequestNotAllowed,
  SbisRpcError,
  SbisTransient,
  isAllowedSbisRequest,
  isAllowedSbisRpc,
  readSbisBody,
  redact,
  rpcErrorClass,
  sbisFetch,
  sbisRpc,
} from '../src/domain/edo/sbis/sbis.http.js';

const noSleep = async () => {};
const SERVICE = new URL(SBIS_URLS.service);
const FILE = 'https://disk.sbis.ru/disk/api/v1/abc?sig=secret';

const rpcOk = (result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', result, id: 0 }), { status: 200 });
const rpcErr = (error: unknown, status = 500) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error, id: 0 }), { status });

function fetchSeq(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('лишний запрос');
    if (next instanceof Error) throw next;
    return next;
  });
  return fn;
}

describe('разрешающий список', () => {
  it('POST — только три адреса online.sbis.ru по https', () => {
    expect(isAllowedSbisRequest('POST', new URL(SBIS_URLS.oauth))).toBe(true);
    expect(isAllowedSbisRequest('POST', new URL(SBIS_URLS.auth))).toBe(true);
    expect(isAllowedSbisRequest('POST', SERVICE)).toBe(true);
    expect(isAllowedSbisRequest('POST', new URL('https://online.sbis.ru/service/'))).toBe(false);
    expect(isAllowedSbisRequest('POST', new URL('https://online.sbis.ru/service/?srv=2'))).toBe(false);
    expect(isAllowedSbisRequest('POST', new URL('http://online.sbis.ru/service/?srv=1'))).toBe(false);
    expect(isAllowedSbisRequest('POST', new URL('https://online.sbis.ru.evil.example/service/?srv=1'))).toBe(false);
    expect(isAllowedSbisRequest('POST', new URL('https://online.sbis.ru:8443/service/?srv=1'))).toBe(false);
    expect(isAllowedSbisRequest('GET', SERVICE)).toBe(false);
  });

  it('GET — только файлы с хостов disk по https', () => {
    expect(isAllowedSbisRequest('GET', new URL(FILE))).toBe(true);
    expect(isAllowedSbisRequest('GET', new URL('https://cdn-disk.saby.ru/x'))).toBe(true);
    expect(isAllowedSbisRequest('GET', new URL('http://disk.sbis.ru/x'))).toBe(false);
    expect(isAllowedSbisRequest('GET', new URL('https://user@disk.sbis.ru/x'))).toBe(false);
    expect(isAllowedSbisRequest('GET', new URL('https://evil.example/x'))).toBe(false);
    expect(isAllowedSbisRequest('PUT', new URL(FILE))).toBe(false);
  });

  it('методы JSON-RPC — только чтение, и каждый на своём адресе', () => {
    expect(isAllowedSbisRpc(SERVICE, 'СБИС.СписокИзменений')).toBe(true);
    expect(isAllowedSbisRpc(SERVICE, 'СБИС.СписокНашихОрганизаций')).toBe(true);
    expect(isAllowedSbisRpc(SERVICE, 'СБИС.ПрочитатьДокумент')).toBe(true);
    expect(isAllowedSbisRpc(SERVICE, 'СБИС.ЗаписатьДокумент')).toBe(false);
    expect(isAllowedSbisRpc(SERVICE, 'СБИС.ВыполнитьДействие')).toBe(false);
    expect(isAllowedSbisRpc(SERVICE, 'СБИС.Аутентифицировать')).toBe(false);
    expect(isAllowedSbisRpc(new URL(SBIS_URLS.auth), 'СБИС.Аутентифицировать')).toBe(true);
  });

  it('метод записи не доходит до сети', async () => {
    const fetchImpl = vi.fn();
    await expect(
      sbisRpc({ rpcMethod: 'СБИС.ЗаписатьДокумент', params: {}, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(SbisRequestNotAllowed);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('файл с чужого хоста не доходит до сети', async () => {
    const fetchImpl = vi.fn();
    await expect(
      sbisFetch({ method: 'GET', url: new URL('https://evil.example/f'), fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(SbisRequestNotAllowed);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('редирект — отказ, а не переход: запрос шёл с redirect=manual', async () => {
    const fetchImpl = fetchSeq(new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }));
    await expect(
      sbisFetch({ method: 'GET', url: new URL(FILE), fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisRequestNotAllowed);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(init.redirect).toBe('manual');
  });
});

describe('ошибки JSON-RPC', () => {
  it('1FA — фатально: без повтора, с кодом класса', async () => {
    const fetchImpl = fetchSeq(
      rpcErr({ code: -32000, message: 'Неверный тип документа', data: { classid: '{00000000-0000-0000-0000-1fa000010005}' } }),
    );
    const err = await sbisRpc({
      rpcMethod: 'СБИС.СписокИзменений',
      params: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SbisRpcError);
    expect((err as SbisRpcError).classCode).toBe('1FA000010005');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ошибка без кода — фатально (справка: любой код, кроме 1AA)', async () => {
    const fetchImpl = fetchSeq(rpcErr({ code: -32000, message: 'что-то не так' }));
    await expect(
      sbisRpc({ rpcMethod: 'СБИС.СписокИзменений', params: {}, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisRpcError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('1AA — повтор не раньше чем через 5 с, затем результат', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = fetchSeq(
      rpcErr({ message: 'повторите', details: '00000000-0000-0000-0000-1AA0000F1002' }),
      rpcOk({ ok: 1 }),
    );
    await expect(
      sbisRpc({ rpcMethod: 'СБИС.СписокИзменений', params: {}, fetchImpl: fetchImpl as unknown as typeof fetch, sleep }),
    ).resolves.toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThanOrEqual(5000);
  });

  it('1AA, попытки кончились — временный сбой', async () => {
    const err1aa = { message: 'занято', data: { classid: '{00000000-0000-0000-0000-1aa000001000}' } };
    const fetchImpl = fetchSeq(rpcErr(err1aa), rpcErr(err1aa));
    await expect(
      sbisRpc({
        rpcMethod: 'СБИС.СписокИзменений',
        params: {},
        maxRetries: 1,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(SbisTransient);
  });

  it('401 со строкой шлюза — авторизация, текст после маски', async () => {
    const fetchImpl = fetchSeq(new Response(JSON.stringify({ error: 'токен TOKEN-123456 не найден' }), { status: 401 }));
    const err = await sbisRpc({
      rpcMethod: 'СБИС.СписокИзменений',
      params: {},
      secrets: ['TOKEN-123456'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SbisAuthExpired);
    expect(String(err.message)).toContain('***');
    expect(String(err.message)).not.toContain('TOKEN-123456');
  });

  it('текст ошибки RPC маскируется', async () => {
    const fetchImpl = fetchSeq(rpcErr({ message: 'Приложение "APP-ID-777" не найдено' }));
    const err = await sbisRpc({
      rpcMethod: 'СБИС.СписокИзменений',
      params: {},
      secrets: ['APP-ID-777'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    }).catch((e) => e);
    expect(String(err.message)).not.toContain('APP-ID-777');
  });

  it('5xx без ответа JSON-RPC и сеть — повтор', async () => {
    const fetchImpl = fetchSeq(
      new Response('<html>bad gateway</html>', { status: 502 }),
      new TypeError('fetch failed'),
      rpcOk([1]),
    );
    await expect(
      sbisRpc({ rpcMethod: 'СБИС.СписокИзменений', params: {}, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).resolves.toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('тело запроса — JSON-RPC 2.0 с нужным типом содержимого', async () => {
    const fetchImpl = fetchSeq(rpcOk(null));
    await sbisRpc({
      rpcMethod: 'СБИС.СписокИзменений',
      params: { Фильтр: {} },
      headers: { 'X-SBISAccessToken': 't' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(SBIS_URLS.service);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json-rpc;charset=utf-8');
    expect((init.headers as Record<string, string>)['X-SBISAccessToken']).toBe('t');
    expect(JSON.parse(String(init.body))).toEqual({ jsonrpc: '2.0', method: 'СБИС.СписокИзменений', params: { Фильтр: {} }, id: 0 });
  });

  it('класс ошибки ищется по всему объекту', () => {
    expect(rpcErrorClass({ data: { classid: '{00000000-0000-0000-0000-1aa000001000}' } })).toEqual({
      code: '1AA000001000',
      retry: true,
    });
    expect(rpcErrorClass({ details: '00000000-0000-0000-0000-1FA000001001' }).retry).toBe(false);
    expect(rpcErrorClass({ message: 'нет кода' })).toEqual({ code: null, retry: false });
  });
});

describe('ответы на файлах', () => {
  it('403 и 404 — без повтора', async () => {
    const denied = fetchSeq(new Response('', { status: 403 }));
    await expect(
      sbisFetch({ method: 'GET', url: new URL(FILE), fetchImpl: denied as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisAccessDenied);
    expect(denied).toHaveBeenCalledTimes(1);

    const gone = fetchSeq(new Response('', { status: 404 }));
    await expect(
      sbisFetch({ method: 'GET', url: new URL(FILE), fetchImpl: gone as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisGone);
  });

  it('в тексте ошибки нет строки запроса ссылки (в ней подпись)', async () => {
    const denied = fetchSeq(new Response('', { status: 403 }));
    const err = await sbisFetch({
      method: 'GET',
      url: new URL(FILE),
      fetchImpl: denied as unknown as typeof fetch,
      sleep: noSleep,
    }).catch((e) => e);
    expect(String(err.message)).not.toContain('sig=');
  });

  it('5xx при retryOn=network не повторяется', async () => {
    const fetchImpl = fetchSeq(new Response('', { status: 503 }));
    await expect(
      sbisFetch({
        method: 'GET',
        url: new URL(FILE),
        retryOn: 'network',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(SbisTransient);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('сеть — повторы, затем временный сбой', async () => {
    const fetchImpl = fetchSeq(new TypeError('fetch failed'), new TypeError('fetch failed'));
    await expect(
      sbisFetch({ method: 'GET', url: new URL(FILE), maxRetries: 1, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisTransient);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('лимит тела', () => {
  it('Content-Length больше лимита — отказ до чтения', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'Content-Length': '10' } });
    await expect(readSbisBody(res, 5)).rejects.toBeInstanceOf(SbisPayloadTooLarge);
  });

  it('потоковое превышение — отказ', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
        c.enqueue(new Uint8Array(4));
        c.close();
      },
    });
    await expect(readSbisBody(new Response(body), 6)).rejects.toBeInstanceOf(SbisPayloadTooLarge);
  });

  it('обрыв тела — временный сбой', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(2));
        c.error(new TypeError('terminated'));
      },
    });
    await expect(readSbisBody(new Response(body), 100)).rejects.toBeInstanceOf(SbisTransient);
  });
});

describe('маска', () => {
  it('вырезает значения, длинные — первыми; короткие не трогает', () => {
    expect(redact('ключ ABCDEF и ABCDEFGH', ['ABCDEF', 'ABCDEFGH'])).toBe('ключ *** и ***');
    expect(redact('id 123', ['123'])).toBe('id 123');
    expect(redact('пусто', [null, undefined, ''])).toBe('пусто');
  });
});
