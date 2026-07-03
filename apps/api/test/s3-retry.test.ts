import { describe, it, expect, vi } from 'vitest';
import { s3FetchWithRetry } from '../src/domain/storage/s3.signer.js';

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
