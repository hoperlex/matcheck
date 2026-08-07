import { describe, it, expect } from 'vitest';
import { withVerifySlot, verifyQueueDepth } from '../src/domain/auth/verify-queue.js';

/**
 * Очередь bcrypt-проверок — единственное, что стоит между /auth/login и
 * событийным циклом: отклоняющих лимитов на этом роуте нет вовсе. Поэтому
 * проверяем ровно три её обещания: лимит соблюдается, разрешение возвращается
 * даже после исключения, и ни одна ждущая задача не теряется.
 */

const MAX = 4;

/** Задача, которая держит слот, пока её не отпустят вручную. */
function heldTask() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
}

describe('withVerifySlot — очередь проверок пароля', () => {
  it('одновременно выполняется не более четырёх задач', async () => {
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 10 }, () => heldTask());

    const all = gates.map((g) =>
      withVerifySlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.held;
        running -= 1;
      }),
    );

    // Дали событийному циклу прокрутиться: если бы лимита не было, стартовали
    // бы все десять.
    await new Promise((r) => setImmediate(r));
    expect(running).toBe(MAX);
    expect(verifyQueueDepth()).toBe(10 - MAX);

    gates.forEach((g) => g.release());
    await Promise.all(all);
    expect(peak).toBe(MAX);
    expect(running).toBe(0);
  });

  it('разрешение освобождается, даже если задача бросила исключение', async () => {
    const failures = Array.from({ length: MAX }, (_, i) =>
      withVerifySlot(async () => {
        throw new Error(`boom ${i}`);
      }).catch((e: Error) => e.message),
    );
    expect(await Promise.all(failures)).toEqual(['boom 0', 'boom 1', 'boom 2', 'boom 3']);

    // Очередь не встала намертво: следующая задача проходит сразу.
    await expect(withVerifySlot(async () => 'ok')).resolves.toBe('ok');
    expect(verifyQueueDepth()).toBe(0);
  });

  it('ожидающие задачи не теряются и выполняются в порядке постановки', async () => {
    const order: number[] = [];
    const gates = Array.from({ length: MAX }, () => heldTask());

    // Первые MAX занимают все слоты и держат их.
    const blockers = gates.map((g) => withVerifySlot(() => g.held));
    await new Promise((r) => setImmediate(r));

    // Ещё шесть встают в очередь.
    const queued = Array.from({ length: 6 }, (_, i) =>
      withVerifySlot(async () => {
        order.push(i);
      }),
    );
    expect(verifyQueueDepth()).toBe(6);

    gates.forEach((g) => g.release());
    await Promise.all([...blockers, ...queued]);

    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(verifyQueueDepth()).toBe(0);
  });
});
