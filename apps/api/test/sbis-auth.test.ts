/**
 * Вход в СБИС: тело запроса, отказы и маска.
 *
 * Справка требует для входа по ключу три значения, и без третьего («Сервисный
 * ключ») запрос не должен уходить вовсе: лишние попытки приближают блокировку по
 * лимиту входов. Значения ключей и токен не должны попадать ни в один текст ошибки.
 */
import { describe, expect, it, vi } from 'vitest';
import { loginByKey, loginByPassword, missingKeyFields } from '../src/domain/edo/sbis/sbis.auth.js';
import {
  SBIS_URLS,
  SbisAuthExpired,
  SbisAuthRejected,
  SbisTransient,
  sbisRpc,
} from '../src/domain/edo/sbis/sbis.http.js';

const noSleep = async () => {};
const KEYS = { appClientId: '  1234567  ', appSecret: 'SECRET-AAAA', secretKey: 'SERVICE-BBBB' };

function fetchSeq(...responses: (Response | Error)[]) {
  return vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('лишний запрос');
    if (next instanceof Error) throw next;
    return next;
  });
}

describe('вход по ключу', () => {
  it('три поля без пробелов, JSON на /oauth/service/; в сессии только X-SBISAccessToken', async () => {
    const fetchImpl = fetchSeq(new Response(JSON.stringify({ token: 'TOKEN-XYZ-1', sid: 'SID-1' })));
    const session = await loginByKey(KEYS, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(SBIS_URLS.oauth);
    expect(JSON.parse(String(init.body))).toEqual({
      app_client_id: '1234567',
      app_secret: 'SECRET-AAAA',
      secret_key: 'SERVICE-BBBB',
    });
    expect(session.mode).toBe('key');
    expect(session.headers).toEqual({ 'X-SBISAccessToken': 'TOKEN-XYZ-1' });
    expect(session.headers).not.toHaveProperty('X-SBISSessionID');
    expect(session.secrets).toEqual(expect.arrayContaining(['1234567', 'SECRET-AAAA', 'SERVICE-BBBB', 'TOKEN-XYZ-1']));
  });

  it('без сервисного ключа запрос не уходит, в тексте — имена переменных, не значения', async () => {
    const fetchImpl = vi.fn();
    const err = await loginByKey(
      { ...KEYS, secretKey: '  ' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((e) => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(err.message)).toContain('SBIS_SECRET_KEY');
    expect(String(err.message)).not.toContain('SECRET-AAAA');
    expect(missingKeyFields({ appClientId: 'x' })).toHaveLength(2);
  });

  it('400 — отказ входа с текстом СБИС после маски', async () => {
    const fetchImpl = fetchSeq(
      new Response(
        JSON.stringify({ error: 'Не удалось осуществить авторизацию. Приложение "1234567" не найдено!' }),
        { status: 400 },
      ),
    );
    const err = await loginByKey(KEYS, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(SbisAuthRejected);
    expect(String(err.message)).toContain('Не удалось осуществить авторизацию');
    expect(String(err.message)).not.toContain('1234567');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('сетевой сбой — ровно один повтор', async () => {
    const fetchImpl = fetchSeq(new TypeError('fetch failed'), new TypeError('fetch failed'));
    await expect(
      loginByKey(KEYS, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisTransient);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('5xx на входе не повторяется', async () => {
    const fetchImpl = fetchSeq(new Response('', { status: 502 }));
    await expect(
      loginByKey(KEYS, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisTransient);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ответ без token — отказ', async () => {
    const fetchImpl = fetchSeq(new Response(JSON.stringify({ sid: 'only-sid' })));
    await expect(
      loginByKey(KEYS, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toBeInstanceOf(SbisAuthRejected);
  });

  it('токен сессии маскируется в ошибках последующих вызовов', async () => {
    const login = fetchSeq(new Response(JSON.stringify({ token: 'TOKEN-XYZ-1' })));
    const session = await loginByKey(KEYS, { fetchImpl: login as unknown as typeof fetch, sleep: noSleep });
    const call = fetchSeq(new Response(JSON.stringify({ error: 'сессия TOKEN-XYZ-1 истекла' }), { status: 401 }));
    const err = await sbisRpc({
      rpcMethod: 'СБИС.СписокИзменений',
      params: {},
      headers: session.headers,
      secrets: session.secrets,
      fetchImpl: call as unknown as typeof fetch,
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SbisAuthExpired);
    expect(String(err.message)).not.toContain('TOKEN-XYZ-1');
  });
});

describe('вход логином', () => {
  it('СБИС.Аутентифицировать на /auth/service/ → X-SBISSessionID', async () => {
    const fetchImpl = fetchSeq(new Response(JSON.stringify({ jsonrpc: '2.0', result: 'SESSION-1', id: 0 })));
    const session = await loginByPassword(
      { login: ' user ', password: 'pass-word' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep },
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(SBIS_URLS.auth);
    expect(JSON.parse(String(init.body))).toMatchObject({
      method: 'СБИС.Аутентифицировать',
      params: { Параметр: { Логин: 'user', Пароль: 'pass-word' } },
    });
    expect(session).toMatchObject({ mode: 'password', headers: { 'X-SBISSessionID': 'SESSION-1' } });
  });
});
