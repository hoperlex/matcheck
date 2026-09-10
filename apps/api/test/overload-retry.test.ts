import { describe, expect, it, vi } from 'vitest';
import {
  isRetriableNetworkError,
  isOverloadStatus,
  llmFetchWithOverloadRetry,
  overloadDelayMs,
  parseRetryAfterMs,
} from '../src/domain/llm/overload-retry.js';

const QUEUE_FULL = JSON.stringify({
  error: { code: 'queue_full', message: 'proxy queue is full, retry later' },
});

function overloaded(status = 503, headers: Record<string, string> = {}): Response {
  return new Response(QUEUE_FULL, { status, headers });
}

describe('isOverloadStatus', () => {
  it('считает перегрузкой 429 и шлюзовые 5xx', () => {
    expect([429, 502, 503, 504].map(isOverloadStatus)).toEqual([true, true, true, true]);
  });

  it('не трогает успех и прочие 4xx/5xx', () => {
    expect([200, 400, 403, 404, 500].map(isOverloadStatus)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('parseRetryAfterMs', () => {
  it('читает секунды', () => {
    expect(parseRetryAfterMs('7')).toBe(7000);
  });

  it('читает HTTP-дату относительно текущего момента', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    expect(parseRetryAfterMs('Thu, 10 Sep 2026 12:00:05 GMT', now)).toBe(5000);
  });

  it('игнорирует мусор, пустое и прошедшую дату', () => {
    const now = Date.parse('2026-09-10T12:00:00Z');
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('скоро')).toBeNull();
    expect(parseRetryAfterMs('Thu, 10 Sep 2026 11:59:55 GMT', now)).toBeNull();
  });
});

describe('overloadDelayMs', () => {
  it('слушается Retry-After', () => {
    expect(overloadDelayMs({ attempt: 1, retryAfterMs: 4000 })).toBe(4000);
  });

  it('обрезает слишком долгую просьбу потолком паузы', () => {
    expect(overloadDelayMs({ attempt: 1, retryAfterMs: 600_000 })).toBe(10_000);
  });

  it('без Retry-After растёт экспоненциально и остаётся в пределах джиттера', () => {
    const low = overloadDelayMs({ attempt: 1, retryAfterMs: null, baseMs: 1000, random: () => 0 });
    const high = overloadDelayMs({ attempt: 1, retryAfterMs: null, baseMs: 1000, random: () => 1 });
    expect(low).toBe(500);
    expect(high).toBe(1000);

    const second = overloadDelayMs({
      attempt: 2,
      retryAfterMs: null,
      baseMs: 1000,
      random: () => 1,
    });
    expect(second).toBe(2000);
  });
});

describe('llmFetchWithOverloadRetry', () => {
  it('не трогает успешный ответ', async () => {
    const attempt = vi.fn(async () => new Response('{}', { status: 200 }));

    const res = await llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined });

    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('повторяет queue_full и отдаёт успех второй попытки', async () => {
    // Ровно случай приёмки 14601: первый ответ — перегрузка чужой очереди.
    const attempt = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(overloaded())
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const slept: number[] = [];

    const res = await llmFetchWithOverloadRetry(attempt, {
      sleep: async (ms) => void slept.push(ms),
      random: () => 1,
      baseMs: 1000,
    });

    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([1000]);
  });

  it('повторяет шлюзовой 502', async () => {
    const attempt = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(overloaded(502))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const res = await llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined });

    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('на устойчивой перегрузке отдаёт последний ответ, исчерпав попытки', async () => {
    const attempt = vi.fn(async () => overloaded());

    const res = await llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined });

    expect(res.status).toBe(503);
    expect(attempt).toHaveBeenCalledTimes(3);
    await expect(res.text()).resolves.toContain('queue_full');
  });

  it('не повторяет 4xx по существу запроса', async () => {
    const attempt = vi.fn(async () => new Response('{"error":"forbidden"}', { status: 403 }));

    const res = await llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined });

    expect(res.status).toBe(403);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('не ждёт дольше бюджета: просьбу «через минуту» не выполняет', async () => {
    const attempt = vi.fn(async () => overloaded(503, { 'retry-after': '60' }));
    const sleep = vi.fn(async () => undefined);

    const res = await llmFetchWithOverloadRetry(attempt, { sleep, totalBudgetMs: 5000 });

    expect(res.status).toBe(503);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('свой таймаут наверх, без повтора: бюджет ожидания уже потрачен', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const attempt = vi.fn(async () => {
      throw timeout;
    });

    await expect(
      llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined }),
    ).rejects.toThrow('aborted');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('обрыв соединения повторяет — случай «fetch failed» от 04.09', async () => {
    const attempt = vi
      .fn<[], Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const res = await llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined });

    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('устойчивый обрыв бросает исходную ошибку, исчерпав попытки', async () => {
    const attempt = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    await expect(
      llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined }),
    ).rejects.toThrow('fetch failed');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('сообщает о повторе через onRetry', async () => {
    const attempt = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(overloaded(503, { 'retry-after': '2' }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const onRetry = vi.fn();

    await llmFetchWithOverloadRetry(attempt, { sleep: async () => undefined, onRetry });

    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, status: 503, delayMs: 2000 });
  });
});

describe('isRetriableNetworkError', () => {
  it('повторяет обрыв соединения undici', () => {
    expect(isRetriableNetworkError(new TypeError('fetch failed'))).toBe(true);
  });

  it('повторяет сетевые коды из cause', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isRetriableNetworkError(err)).toBe(true);
  });

  it('не повторяет собственный таймаут и отмену', () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isRetriableNetworkError(timeout)).toBe(false);
    expect(isRetriableNetworkError(abort)).toBe(false);
  });

  it('не повторяет коды, где ожидание уже произошло', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(isRetriableNetworkError(err)).toBe(false);
  });

  it('не считает ошибкой сети обычное исключение разбора', () => {
    expect(isRetriableNetworkError(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isRetriableNetworkError('строка')).toBe(false);
  });
});
