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

const {
  describeNetworkFailure,
  diadocFetch,
  readJson,
  readBodyWithLimit,
  DiadocTransient,
  DiadocPayloadTooLarge,
} = await import('../src/domain/edo/diadoc.http.js');

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

describe('коды HTTP-клиента и адрес запроса', () => {
  it('переводит коды undici, которые чаще всего несёт «fetch failed»', () => {
    expect(describeNetworkFailure(fetchFailed('UND_ERR_CONNECT_TIMEOUT'))).toMatch(
      /не установилось за отведённое время \(UND_ERR_CONNECT_TIMEOUT\)/,
    );
    expect(describeNetworkFailure(fetchFailed('UND_ERR_SOCKET'))).toMatch(
      /сервер закрыл соединение \(UND_ERR_SOCKET\)/,
    );
    expect(describeNetworkFailure(fetchFailed('EHOSTUNREACH'))).toMatch(/хост недостижим/);
  });

  it('в сообщение попадает хост и путь, но не строка запроса', async () => {
    // В строке запроса идентификаторы ящика и сообщения — им не место в поле
    // состояния учётной записи и в интерфейсе.
    const fetchImpl = (async () => {
      throw fetchFailed('ECONNRESET');
    }) as unknown as typeof fetch;
    const url = new URL('https://diadoc-api.kontur.ru/V8/GetNewEvents');
    url.searchParams.set('boxId', 'секретный-ящик@diadoc.ru');

    const err = await diadocFetch({ method: 'GET', url, timeoutMs: 1000, maxRetries: 0, fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DiadocTransient);
    const t = err as InstanceType<typeof DiadocTransient>;
    expect(t.endpoint).toBe('diadoc-api.kontur.ru/V8/GetNewEvents');
    expect(t.detail).toBe('соединение оборвано (ECONNRESET)');
    expect(t.message).not.toContain('секретный-ящик');
    // Исходная ошибка сохраняется для журнала сервера.
    expect((t.cause as Error).message).toBe('fetch failed');
  });
});

/** Ответ, чьё тело обрывается на чтении — как при разрыве соединения после заголовков. */
function brokenBodyResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"Events":['));
      controller.error(Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }));
    },
  });
  return new Response(stream, { status: 200 });
}

describe('обрыв при чтении тела ответа', () => {
  const url = new URL('https://diadoc-api.kontur.ru/V8/GetNewEvents?boxId=x');

  it('обрыв JSON-ответа — временный сбой, а не «сломанный документ»', async () => {
    const err = await readJson(brokenBodyResponse(), url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiadocTransient);
    expect((err as Error).message).toMatch(/оборвался при чтении/);
    expect((err as InstanceType<typeof DiadocTransient>).endpoint).toBe(
      'diadoc-api.kontur.ru/V8/GetNewEvents',
    );
  });

  it('неверный JSON остаётся ошибкой разбора — это не сеть', async () => {
    const err = await readJson(new Response('не json'), url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyntaxError);
    expect(err).not.toBeInstanceOf(DiadocTransient);
  });

  it('обрыв при скачивании файла — тоже временный сбой', async () => {
    const err = await readBodyWithLimit(brokenBodyResponse(), 1_000_000, url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiadocTransient);
  });

  it('превышение размера остаётся отдельной ошибкой', async () => {
    const big = new Response(new Uint8Array(2048), { status: 200 });
    const err = await readBodyWithLimit(big, 1024, url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiadocPayloadTooLarge);
  });
});
