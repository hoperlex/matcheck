/**
 * Как выглядит сетевой отказ в глазах администратора.
 *
 * Повод боевой: 25.09.2026 все обращения к Диадоку с боевого сервера начали
 * обрываться, и в карточке было написано «Diadoc: временный сбой — TypeError».
 * Из этой строки не следует ничего: под `TypeError` у fetch скрыты и
 * недостижимый хост, и оборванное соединение, и ошибка сертификата — а лечатся
 * они по-разному. Настоящая причина лежит в `cause.code`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 0, EDO_XML_MAX_BYTES: 1024 }),
}));

const { describeNetworkFailure, diadocFetch } = await import(
  '../src/domain/edo/diadoc.http.js'
);

/** Так undici сообщает о сетевом отказе: общий TypeError с причиной внутри. */
function fetchFailed(code: string): Error {
  const err = new TypeError('fetch failed');
  (err as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return err;
}

describe('описание сетевого отказа', () => {
  it('называет причину обрыва, а не тип исключения', () => {
    expect(describeNetworkFailure(fetchFailed('ECONNRESET'))).toBe(
      'соединение оборвано (ECONNRESET)',
    );
    expect(describeNetworkFailure(fetchFailed('ENOTFOUND'))).toBe(
      'имя хоста не разрешается (DNS) (ENOTFOUND)',
    );
    expect(describeNetworkFailure(fetchFailed('ETIMEDOUT'))).toBe(
      'соединение не установилось (таймаут сети) (ETIMEDOUT)',
    );
  });

  it('отличает истёкшее ожидание от несостоявшегося соединения', () => {
    // Разница существенная: в первом случае связь была, во втором её не было.
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(describeNetworkFailure(timeout)).toMatch(/время ожидания/);
  });

  it('незнакомый код показывает как есть, не пряча его', () => {
    expect(describeNetworkFailure(fetchFailed('EHOSTUNREACH'))).toContain('EHOSTUNREACH');
  });

  it('ошибка без причины не превращается в пустую строку', () => {
    expect(describeNetworkFailure(new TypeError('fetch failed'))).toBe('fetch failed');
    expect(describeNetworkFailure('строка вместо ошибки')).toBe('сетевая ошибка');
  });

  it('причина доходит до сообщения, которое увидит человек', async () => {
    // Раньше здесь оказывался «TypeError», и разбирательство начиналось с нуля.
    const fetchImpl = (async () => {
      throw fetchFailed('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(
      diadocFetch({
        method: 'GET',
        url: new URL('https://diadoc-api.kontur.ru/GetMyOrganizations'),
        timeoutMs: 1000,
        maxRetries: 0,
        fetchImpl,
      }),
    ).rejects.toThrow(/соединение оборвано \(ECONNRESET\)/);
  });
});
