/**
 * Транспорт к API Диадока: разрешающий список, матрица ошибок, лимит размера.
 *
 * Самая важная проверка здесь — первая. Интеграция объявлена read-only, и
 * держится это обещание не дисциплиной автора, а тем, что запрос не по списку
 * физически не уходит. Если кто-то однажды добавит вызов подписания, тест
 * обязан упасть раньше, чем от имени организации уйдёт документ.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 2, EDO_XML_MAX_BYTES: 1024 }),
}));

const {
  DiadocAccessDenied,
  DiadocGone,
  DiadocPayloadTooLarge,
  DiadocRateLimited,
  DiadocRequestNotAllowed,
  DiadocSubscriptionExpired,
  DiadocTransient,
  diadocFetch,
  isAllowedRequest,
  parseRetryAfterMs,
  readBodyWithLimit,
} = await import('../src/domain/edo/diadoc.http.js');

const API = 'https://diadoc-api.kontur.ru';
const noSleep = async () => {};

function okResponse(body = '{}'): Response {
  return new Response(body, { status: 200 });
}

describe('разрешающий список путей', () => {
  it('пропускает только чтение', () => {
    expect(isAllowedRequest('GET', new URL(`${API}/V8/GetNewEvents`))).toBe(true);
    expect(isAllowedRequest('GET', new URL(`${API}/V4/GetEntityContent`))).toBe(true);
    expect(isAllowedRequest('GET', new URL(`${API}/GetMyOrganizations`))).toBe(true);
  });

  it('не пропускает методы, которые что-то отправляют или подписывают', () => {
    expect(isAllowedRequest('POST', new URL(`${API}/V3/PostMessage`))).toBe(false);
    expect(isAllowedRequest('POST', new URL(`${API}/V3/Sign`))).toBe(false);
    // Тот же путь другим методом — тоже нет: список проверяет сочетание.
    expect(isAllowedRequest('POST', new URL(`${API}/V8/GetNewEvents`))).toBe(false);
  });

  it('не даёт обмануть себя путём, похожим на разрешённый', () => {
    // Проверка по подстроке пропустила бы обе эти формы.
    expect(isAllowedRequest('GET', new URL(`${API}/V8/GetNewEvents/../V3/Sign`))).toBe(false);
    expect(isAllowedRequest('GET', new URL('https://evil.example.com/V8/GetNewEvents'))).toBe(
      false,
    );
  });

  it('запрещённый запрос не доходит до сети', async () => {
    const fetchImpl = vi.fn();
    await expect(
      diadocFetch({
        method: 'POST',
        url: new URL(`${API}/V3/PostMessage`),
        timeoutMs: 1000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DiadocRequestNotAllowed);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('матрица ошибок', () => {
  it('403 и 402 не повторяются: повтор их не лечит', async () => {
    for (const [status, ctor] of [
      [403, DiadocAccessDenied],
      [402, DiadocSubscriptionExpired],
    ] as const) {
      const fetchImpl = vi.fn(async () => new Response('', { status }));
      await expect(
        diadocFetch({
          method: 'GET',
          url: new URL(`${API}/V8/GetNewEvents`),
          timeoutMs: 1000,
          sleep: noSleep,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toBeInstanceOf(ctor);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('404 и 410 означают «документа больше нет»', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 410 }));
    await expect(
      diadocFetch({
        method: 'GET',
        url: new URL(`${API}/V4/GetEntityContent`),
        timeoutMs: 1000,
        sleep: noSleep,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DiadocGone);
  });

  it('429 ждёт Retry-After и повторяет, а исчерпав попытки — сдаётся', async () => {
    const slept: number[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : okResponse();
    });
    const res = await diadocFetch({
      method: 'GET',
      url: new URL(`${API}/V8/GetNewEvents`),
      timeoutMs: 1000,
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    // Джиттер ±15% вокруг двух секунд.
    expect(slept[0]).toBeGreaterThan(1500);
    expect(slept[0]).toBeLessThan(2600);

    const always429 = vi.fn(async () => new Response('', { status: 429 }));
    await expect(
      diadocFetch({
        method: 'GET',
        url: new URL(`${API}/V8/GetNewEvents`),
        timeoutMs: 1000,
        sleep: noSleep,
        fetchImpl: always429 as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DiadocRateLimited);
  });

  it('5xx повторяется, затем становится временным сбоем', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    await expect(
      diadocFetch({
        method: 'GET',
        url: new URL(`${API}/V6/GetMessage`),
        timeoutMs: 1000,
        sleep: noSleep,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DiadocTransient);
    // Первая попытка плюс EDO_HTTP_MAX_RETRIES.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('сообщение об ошибке не содержит тела ответа', async () => {
    const secret = 'ИНН 7712345678, договор №17';
    const fetchImpl = vi.fn(async () => new Response(secret, { status: 400 }));
    await expect(
      diadocFetch({
        method: 'GET',
        url: new URL(`${API}/V6/GetMessage`),
        timeoutMs: 1000,
        sleep: noSleep,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 400/);
    await expect(
      diadocFetch({
        method: 'GET',
        url: new URL(`${API}/V6/GetMessage`),
        timeoutMs: 1000,
        sleep: noSleep,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.not.toThrow(new RegExp(secret));
  });
});

describe('Retry-After', () => {
  it('понимает секунды, дату и отсутствие заголовка', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    const now = Date.now();
    expect(parseRetryAfterMs(new Date(now + 3000).toUTCString(), now)).toBeGreaterThan(1000);
    expect(parseRetryAfterMs(null)).toBeGreaterThan(0);
    // Сколько бы ни просили ждать, проход не висит вечно.
    expect(parseRetryAfterMs('100000')).toBeLessThanOrEqual(120_000);
  });
});

describe('лимит размера', () => {
  it('обрывает чтение на превышении, а не после него', async () => {
    // Двадцать кусков по 100 байт при лимите 500: без потоковой проверки в
    // память уехали бы все две тысячи.
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 20) {
          controller.close();
          return;
        }
        produced += 1;
        controller.enqueue(new Uint8Array(100));
      },
    });
    await expect(readBodyWithLimit(new Response(stream), 500)).rejects.toBeInstanceOf(
      DiadocPayloadTooLarge,
    );
    expect(produced).toBeLessThan(20);
  });

  it('отказывает сразу, если размер объявлен заранее', async () => {
    const res = new Response('x'.repeat(10), { headers: { 'Content-Length': '10000' } });
    await expect(readBodyWithLimit(res, 500)).rejects.toBeInstanceOf(DiadocPayloadTooLarge);
  });

  it('тело в пределах лимита читается целиком', async () => {
    const body = await readBodyWithLimit(new Response('привет'), 1024);
    expect(body.toString('utf-8')).toBe('привет');
  });
});
