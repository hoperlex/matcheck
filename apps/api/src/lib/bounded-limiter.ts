/**
 * Ограничитель параллельной работы с ограниченной очередью ожидания.
 *
 * Не больше `concurrency` задач выполняются одновременно, ещё не больше
 * `maxQueue` ждут своей очереди. Всё, что сверх, сразу получает
 * LimiterBusyError: тяжёлую работу в процессе API нельзя копить без предела —
 * очередь из сотни ожидающих держит в памяти сотню запросов и всё равно не
 * успеет ответить до таймаута клиента.
 *
 * Слот передаётся из рук в руки: освободившаяся задача будит следующую в
 * очереди, не уменьшая счётчик, поэтому новая задача не может «проскочить»
 * мимо ожидающих.
 */
export class LimiterBusyError extends Error {
  constructor() {
    super('Очередь занята');
    this.name = 'LimiterBusyError';
  }
}

export type BoundedLimiter = {
  <T>(task: () => Promise<T>): Promise<T>;
  /** Для тестов и логов: сколько выполняется и сколько ждёт. */
  stats(): { active: number; queued: number };
};

export function createBoundedLimiter(opts: {
  concurrency: number;
  maxQueue: number;
}): BoundedLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];

  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < opts.concurrency) {
      active++;
    } else {
      if (waiting.length >= opts.maxQueue) throw new LimiterBusyError();
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };

  return Object.assign(run, {
    stats: () => ({ active, queued: waiting.length }),
  });
}
