import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
// Старый путь импорта намеренно: реэкспорт из s3.signer должен работать.
import { s3FetchWithRetry } from '../src/domain/storage/s3.signer.js';
import { discardBody, fetchPresignedForStream } from '../src/domain/storage/s3.retry.js';

// sleep-заглушка: ретрай не должен ждать в тестах.
const noSleep = () => Promise.resolve();
const resp = (status: number) => new Response(null, { status });

describe('s3FetchWithRetry — ретрай транзиентных сбоев S3', () => {
  it('успех с первой попытки → один вызов, без повтора (поведение как раньше)', async () => {
    const attempt = vi.fn().mockResolvedValue(resp(200));
    const res = await s3FetchWithRetry(attempt, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('сетевой throw (ConnectTimeout) → повтор → успех на 2-й попытке', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed: Connect Timeout Error'))
      .mockResolvedValueOnce(resp(200));
    const res = await s3FetchWithRetry(attempt, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('503 → повтор → 200', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(resp(503)).mockResolvedValueOnce(resp(200));
    const res = await s3FetchWithRetry(attempt, { sleep: noSleep });
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('РЕГРЕСС: 404 → без повтора, сразу возврат (валидный ответ headObject)', async () => {
    const attempt = vi.fn().mockResolvedValue(resp(404));
    const res = await s3FetchWithRetry(attempt, { sleep: noSleep });
    expect(res.status).toBe(404);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('РЕГРЕСС: 403 → без повтора', async () => {
    const attempt = vi.fn().mockResolvedValue(resp(403));
    const res = await s3FetchWithRetry(attempt, { sleep: noSleep });
    expect(res.status).toBe(403);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('исчерпание попыток на сетевом throw → прокидывает последнюю ошибку', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(s3FetchWithRetry(attempt, { sleep: noSleep, maxAttempts: 3 })).rejects.toThrow(
      'ECONNRESET',
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('исчерпание попыток на 503 → отдаёт последний 503 вызывающему (он бросит HTTP-ошибку)', async () => {
    const attempt = vi.fn().mockResolvedValue(resp(503));
    const res = await s3FetchWithRetry(attempt, { sleep: noSleep, maxAttempts: 3 });
    expect(res.status).toBe(503);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('backoff растёт (200мс, 600мс) и вызывается между попытками', async () => {
    const delays: number[] = [];
    const sleep = (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    };
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('EAI_AGAIN'))
      .mockRejectedValueOnce(new Error('EAI_AGAIN'))
      .mockResolvedValueOnce(resp(200));
    await s3FetchWithRetry(attempt, { sleep });
    expect(delays).toEqual([200, 600]);
  });
});

// ── Хуки, освобождение тела и обвязка стрим-прокси (s3.retry.ts) ─────────────

/** Ответ с настоящим потоком-телом и шпионом на его отмену. */
function respWithBody(status: number): { res: Response; cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('upstream body'));
    },
    cancel,
  });
  return { res: new Response(body, { status }), cancel };
}

describe('s3FetchWithRetry — хуки onRetry/onFinish', () => {
  it('onRetry: со status на 502→200 и с err на throw→200', async () => {
    const onRetry = vi.fn();
    await s3FetchWithRetry(
      vi.fn().mockResolvedValueOnce(resp(502)).mockResolvedValueOnce(resp(200)),
      { sleep: noSleep, onRetry },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, status: 502 });

    onRetry.mockClear();
    const boom = new Error('ECONNRESET');
    await s3FetchWithRetry(
      vi.fn().mockRejectedValueOnce(boom).mockResolvedValueOnce(resp(200)),
      { sleep: noSleep, onRetry },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, err: boom });
  });

  it('onRetry не вызывается на 200 и на 404', async () => {
    const onRetry = vi.fn();
    await s3FetchWithRetry(vi.fn().mockResolvedValue(resp(200)), { sleep: noSleep, onRetry });
    await s3FetchWithRetry(vi.fn().mockResolvedValue(resp(404)), { sleep: noSleep, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('onFinish — ровно один раз, с итогом запроса', async () => {
    const onFinish = vi.fn();
    await s3FetchWithRetry(vi.fn().mockResolvedValue(resp(200)), { sleep: noSleep, onFinish });
    expect(onFinish).toHaveBeenLastCalledWith({ attempts: 1, status: 200 });

    await s3FetchWithRetry(
      vi.fn().mockResolvedValueOnce(resp(502)).mockResolvedValueOnce(resp(200)),
      { sleep: noSleep, onFinish },
    );
    expect(onFinish).toHaveBeenLastCalledWith({ attempts: 2, status: 200 });

    await s3FetchWithRetry(vi.fn().mockResolvedValue(resp(502)), { sleep: noSleep, onFinish });
    expect(onFinish).toHaveBeenLastCalledWith({ attempts: 3, status: 502 });

    const boom = new Error('ECONNRESET');
    await expect(
      s3FetchWithRetry(vi.fn().mockRejectedValue(boom), { sleep: noSleep, onFinish }),
    ).rejects.toBe(boom);
    expect(onFinish).toHaveBeenLastCalledWith({ attempts: 3, err: boom });

    expect(onFinish).toHaveBeenCalledTimes(4);
  });

  it('упавший хук не ломает операцию: повтор идёт, ответ возвращается', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(resp(503)).mockResolvedValueOnce(resp(200));
    const res = await s3FetchWithRetry(attempt, {
      sleep: noSleep,
      onRetry: () => {
        throw new Error('logger down');
      },
      onFinish: () => {
        throw new Error('logger down');
      },
    });
    expect(res.status).toBe(200);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('s3FetchWithRetry — тело отброшенного ответа освобождается', () => {
  it('тело транзиентного 502 отменено ДО следующей попытки', async () => {
    const first = respWithBody(502);
    const order: string[] = [];
    first.cancel.mockImplementation(() => {
      order.push('cancel');
    });
    const attempt = vi
      .fn()
      .mockImplementationOnce(async () => {
        order.push('attempt1');
        return first.res;
      })
      .mockImplementationOnce(async () => {
        order.push('attempt2');
        return resp(200);
      });
    await s3FetchWithRetry(attempt, { sleep: noSleep });
    expect(order).toEqual(['attempt1', 'cancel', 'attempt2']);
  });

  it('последний 502 и неповторяемый 403 возвращаются вызывающему нетронутыми', async () => {
    // Освобождать их — работа маршрута (он решает, читать ли тело).
    const last = respWithBody(502);
    const res = await s3FetchWithRetry(vi.fn().mockResolvedValue(last.res), {
      sleep: noSleep,
      maxAttempts: 1,
    });
    expect(res.bodyUsed).toBe(false);
    expect(last.cancel).not.toHaveBeenCalled();

    const denied = respWithBody(403);
    await s3FetchWithRetry(vi.fn().mockResolvedValue(denied.res), { sleep: noSleep });
    expect(denied.cancel).not.toHaveBeenCalled();
  });
});

describe('discardBody', () => {
  it('отменяет непрочитанное тело', async () => {
    const { res, cancel } = respWithBody(502);
    await discardBody(res);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('не бросает на ответе без тела, на прочитанном и на захваченном теле', async () => {
    await expect(discardBody(resp(304))).resolves.toBeUndefined();

    const read = new Response('x', { status: 502 });
    await read.text();
    await expect(discardBody(read)).resolves.toBeUndefined();

    const locked = respWithBody(502).res;
    locked.body!.getReader();
    await expect(discardBody(locked)).resolves.toBeUndefined();
  });
});

describe('fetchPresignedForStream — на настоящем HTTP-сервере', () => {
  let server: Server;
  let base = '';
  let handler: (req: IncomingMessage, res: ServerResponse) => void = () => {};

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const mkLog = () => ({ warn: vi.fn() });

  it('502 → 200: клиент получает тело, повтор и итог записаны в лог', async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(502);
        res.end('bad gateway');
      } else {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end('jpeg-bytes');
      }
    };
    const log = mkLog();
    const res = await fetchPresignedForStream(`${base}/obj`, {
      log,
      logContext: { proxy: 'photo', key: 'k' },
      sleep: noSleep,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('jpeg-bytes');
    expect(hits).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: 'photo', key: 'k', attempt: 1, status: 502 }),
      'S3 transient, retrying',
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: 'photo', key: 'k', attempts: 2, status: 200 }),
      'S3 retry finished',
    );
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('успех с первой попытки — ни одной строки лога', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end('ok');
    };
    const log = mkLog();
    const res = await fetchPresignedForStream(`${base}/obj`, {
      log,
      logContext: { proxy: 'raw' },
      sleep: noSleep,
    });
    expect(await res.text()).toBe('ok');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('404 не повторяется', async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      res.writeHead(404);
      res.end();
    };
    const res = await fetchPresignedForStream(`${base}/obj`, {
      log: mkLog(),
      logContext: {},
      sleep: noSleep,
    });
    expect(res.status).toBe(404);
    expect(hits).toBe(1);
  });

  it('заголовки запроса (Range) доходят до S3, 206 возвращается как есть', async () => {
    let seenRange: string | undefined;
    handler = (req, res) => {
      seenRange = req.headers.range;
      res.writeHead(206, { 'content-range': 'bytes 0-1/10' });
      res.end('ab');
    };
    const res = await fetchPresignedForStream(`${base}/obj`, {
      headers: { range: 'bytes=0-1' },
      log: mkLog(),
      logContext: {},
      sleep: noSleep,
    });
    expect(res.status).toBe(206);
    expect(seenRange).toBe('bytes=0-1');
  });

  it('заголовки не пришли за таймаут → три попытки, затем DOMException TimeoutError', async () => {
    // Три обращения к серверу доказывают и то, что у каждой попытки свой
    // сигнал: общий, уже прерванный, отклонил бы 2-ю и 3-ю без запроса.
    let hits = 0;
    handler = () => {
      hits++; // не отвечаем вовсе
    };
    const log = mkLog();
    const err = await fetchPresignedForStream(`${base}/obj`, {
      log,
      logContext: { proxy: 'raw' },
      headersTimeoutMs: 50,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('TimeoutError');
    expect(hits).toBe(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ proxy: 'raw', attempts: 3, err }),
      'S3 retry finished',
    );
  });

  it('таймер снят после заголовков: тело, пришедшее позже окна таймаута, читается целиком', async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.write('first-');
      setTimeout(() => res.end('second'), 200);
    };
    const res = await fetchPresignedForStream(`${base}/obj`, {
      log: mkLog(),
      logContext: {},
      headersTimeoutMs: 50,
      sleep: noSleep,
    });
    expect(await res.text()).toBe('first-second');
  });
});
