import { describe, expect, it } from 'vitest';
import { createBoundedLimiter, LimiterBusyError } from '../src/lib/bounded-limiter.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('createBoundedLimiter', () => {
  it('выполняет не больше concurrency задач, лишние ждут, сверх очереди — busy', async () => {
    const limit = createBoundedLimiter({ concurrency: 2, maxQueue: 8 });
    const gates = Array.from({ length: 10 }, deferred);
    let running = 0;
    let peak = 0;
    const results = gates.map((gate, i) =>
      limit(async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
        return i;
      }),
    );
    await tick();
    expect(limit.stats()).toEqual({ active: 2, queued: 8 });

    await expect(limit(async () => 'лишняя')).rejects.toBeInstanceOf(LimiterBusyError);

    gates.forEach((g) => g.resolve());
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(2);
    expect(limit.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('очередь идёт по порядку, и новая задача не обгоняет ожидающих', async () => {
    const limit = createBoundedLimiter({ concurrency: 1, maxQueue: 5 });
    const order: string[] = [];
    const first = deferred();
    const a = limit(async () => {
      await first.promise;
      order.push('a');
    });
    const b = limit(async () => {
      order.push('b');
    });
    const c = limit(async () => {
      order.push('c');
    });
    await tick();
    first.resolve();
    // Пока слот передаётся b, пришедшая d встаёт в конец.
    const d = limit(async () => {
      order.push('d');
    });
    await Promise.all([a, b, c, d]);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('упавшая задача отдаёт слот следующей', async () => {
    const limit = createBoundedLimiter({ concurrency: 1, maxQueue: 1 });
    const gate = deferred();
    const failing = limit(async () => {
      await gate.promise;
    });
    const next = limit(async () => 'после сбоя');
    gate.reject(new Error('сбой'));
    await expect(failing).rejects.toThrow('сбой');
    await expect(next).resolves.toBe('после сбоя');
    expect(limit.stats()).toEqual({ active: 0, queued: 0 });
  });
});
