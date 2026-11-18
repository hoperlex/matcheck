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

  it('отменённая в ожидании задача снимается с очереди и не запускается', async () => {
    const enqueue = createLoadQueue(1);
    let release!: () => void;
    const first = enqueue(() => new Promise<string>((r) => (release = () => r('first'))));
    const started: string[] = [];
    const ctrl = new AbortController();
    const skipped = enqueue(async () => {
      started.push('skipped');
      return 'skipped';
    }, ctrl.signal);
    const current = enqueue(async () => {
      started.push('current');
      return 'current';
    });

    ctrl.abort();
    await expect(skipped).rejects.toMatchObject({ name: 'AbortError' });
    release();
    await expect(first).resolves.toBe('first');
    // Нужная задача получила слот сразу за первой, пропущенная не стартовала.
    await expect(current).resolves.toBe('current');
    expect(started).toEqual(['current']);
  });

  it('отмена во время выполнения обрывает задачу и освобождает слот', async () => {
    const enqueue = createLoadQueue(1);
    const ctrl = new AbortController();
    // Задача сама слушает сигнал — как fetch с переданным signal.
    const running = enqueue(
      () =>
        new Promise<string>((_, reject) => {
          ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason));
        }),
      ctrl.signal,
    );
    const next = enqueue(async () => 'next');
    ctrl.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(next).resolves.toBe('next');
  });

  it('уже отменённый сигнал — задача не запускается вовсе', async () => {
    const enqueue = createLoadQueue(2);
    const ctrl = new AbortController();
    ctrl.abort();
    let started = false;
    await expect(
      enqueue(async () => {
        started = true;
      }, ctrl.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toBe(false);
    // Слот не занят: обе следующие задачи идут параллельно.
    await expect(Promise.all([enqueue(async () => 1), enqueue(async () => 2)])).resolves.toEqual([
      1, 2,
    ]);
  });
});
