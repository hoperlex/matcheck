// Повтор транзакции, которую оборвала взаимная блокировка (40P01) или смена
// головы машины между её вычислением и захватом (MachineHeadMovedError).
//
// Обе причины временные и лечатся простым повтором: Postgres снимает одну из
// сторон цикла, а смена состава машины — редкое ручное действие менеджера.
// Повторяется ВСЯ транзакция: частичная работа отброшена откатом.
//
// Когда попытки кончились — BusyRetryError (503 + Retry-After). Не 409: на
// неизвестный 409 планшет замораживает мутацию и блокирует очередь сущности,
// а 5xx он просто повторит позже.

import { MachineHeadMovedError } from '../domain/sourceDocuments/machine-lock.js';
import { BusyRetryError } from './http-error.js';

/** Взаимная блокировка или сбой сериализации где-то в цепочке cause. */
export function isRetryableTxError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 6; depth++) {
    // По имени тоже: после горячей перезагрузки модулей (тесты, vi.resetModules)
    // класс в цепочке может оказаться другим экземпляром.
    if (current instanceof MachineHeadMovedError) return true;
    if ((current as { name?: string }).name === 'MachineHeadMovedError') return true;
    const code = (current as { code?: string }).code;
    if (code === '40P01' || code === '40001') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function withTxRetry<T>(
  run: () => Promise<T>,
  opts: { attempts?: number; onRetry?: (err: unknown, attempt: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!isRetryableTxError(err)) throw err;
      if (attempt >= attempts) throw new BusyRetryError();
      opts.onRetry?.(err, attempt);
      // Короткая пауза с разбросом: два участника цикла не должны снова
      // столкнуться в ту же миллисекунду.
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.random() * 30));
    }
  }
}
