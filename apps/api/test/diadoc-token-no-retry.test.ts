/**
 * Обмен refresh_token не повторяется — и это не оптимизация, а сохранность.
 *
 * Сетевой сбой или таймаут не означают, что запрос не дошёл: сервер мог его
 * выполнить и вернуть новый refresh_token, которого мы не увидели. Повтор с
 * прежним значением в такой ситуации — попытка воспользоваться тем, что уже
 * обменяно, и по ней невозможно отличить «токен не приняли» от «мы сами его
 * потеряли». Отказ здесь дешевле: следующий проход начнёт заново.
 *
 * Поэтому окружение здесь нарочно разрешает повторы: если бы их не было
 * вообще, тест доказывал бы не поведение обмена, а настройку.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 3, EDO_XML_MAX_BYTES: 1024 }),
}));

vi.mock('../src/domain/auth/crypto.js', () => ({
  buildAad: (t: string, id: string) => `${t}:${id}`,
  encryptToString: (plain: string) => plain,
  decryptField: (cipher: string) => cipher,
}));

const { createDiadocAuth } = await import('../src/domain/edo/diadoc.auth.js');
const { diadocFetch } = await import('../src/domain/edo/diadoc.http.js');

const account = {
  id: '11111111-1111-1111-1111-111111111111',
  authMode: 'oidc_refresh' as const,
  environment: 'production' as const,
  credentialsEncrypted: JSON.stringify({
    authMode: 'oidc_refresh',
    clientId: 'ci_test',
    clientSecret: 'secret',
    refreshToken: 'refresh',
  }),
  authStateEncrypted: null,
  authStateVersion: 0,
};

const db = {
  update: () => ({
    set: () => ({ where: () => ({ returning: async () => [{ version: 1 }] }) }),
  }),
} as never;

/** Считает попытки и всегда обрывает соединение. */
function failingFetch() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

describe('обмен refresh_token', () => {
  it('не повторяется при обрыве связи', async () => {
    const net = failingFetch();
    const auth = createDiadocAuth({ db, fetchImpl: net.fetchImpl }, account);

    await expect(auth.header()).rejects.toThrow(/временный сбой/i);
    // Ровно одна попытка: исход первой неизвестен, и вторая его не прояснит.
    expect(net.calls()).toBe(1);
  });

  it('прочие запросы к Диадоку повторы сохраняют', async () => {
    // Контраст доказывает, что единственная попытка выше — свойство обмена, а
    // не отсутствие повторов в окружении. Чтение ленты повторить безопасно:
    // оно ничего не расходует и ничего не меняет.
    const net = failingFetch();
    await expect(
      diadocFetch({
        method: 'GET',
        url: new URL('https://diadoc-api.kontur.ru/V8/GetNewEvents'),
        timeoutMs: 1000,
        sleep: async () => {},
        fetchImpl: net.fetchImpl,
      }),
    ).rejects.toThrow(/временный сбой/i);
    expect(net.calls()).toBe(4);
  });
});
