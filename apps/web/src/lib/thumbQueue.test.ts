import { describe, it, expect } from 'vitest';
import { createLoadQueue } from './thumbQueue';

describe('createLoadQueue', () => {
  it('не запускает больше limit задач одновременно', async () => {
    const enqueue = createLoadQueue(3);
    let running = 0;
    let peak = 0;
    const task = () =>
      enqueue(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      });

    await Promise.all(Array.from({ length: 12 }, task));

    expect(peak).toBe(3);
    expect(running).toBe(0);
  });

  it('освобождает слот даже если задача упала', async () => {
    const enqueue = createLoadQueue(1);
    await expect(enqueue(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    // Слот освобождён — следующая задача выполняется, а не висит вечно.
    const ok = await enqueue(async () => 'ok');
    expect(ok).toBe('ok');
  });

  it('возвращает результат задачи вызывающему', async () => {
    const enqueue = createLoadQueue(2);
    const results = await Promise.all([1, 2, 3].map((n) => enqueue(async () => n * 10)));
    expect(results).toEqual([10, 20, 30]);
  });
});
