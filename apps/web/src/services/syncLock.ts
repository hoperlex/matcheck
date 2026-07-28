/**
 * Эксклюзивный лок на запись операционных документов.
 *
 * Зачем: комментарий приёмки/отгрузки пишут два независимых пути — узкий
 * PATCH /:id/comment и общий offline-upsert из очереди мутаций. Очередь
 * снимает payload из IndexedDB (buildUpsertPayload), отправляет его и затем
 * обнуляет local-overlay; если PATCH проскочит внутрь этого окна, правка
 * будет молча затёрта отправленным ранее payload'ом. Прежний флаг RUNNING в
 * sync.ts от этого не спасал — он лишь делал ранний return, дождаться его
 * было нельзя.
 *
 * Почему Web Locks, а не модульный mutex: IndexedDB общая для всех вкладок
 * одного origin, а модульная переменная — нет. Без межвкладочного лока вторая
 * вкладка спокойно запускает sync во время PATCH первой. Fallback на
 * промис-цепочку остаётся для окружений без navigator.locks (небезопасный
 * контекст) — там гарантия слабее и ограничена одной вкладкой.
 *
 * Лок держится на ВСЮ цепочку, включая reconciliation IndexedDB и обновление
 * кеша React Query, а не только на HTTP-запрос: иначе фоновый sync захватит
 * освободившийся лок между ответом сервера и записью в IDB.
 */

const LOCK_NAME = 'matcheck-sync';

function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.locks ?? null;
}

// Fallback: последовательная цепочка промисов + счётчик ожидающих.
let fallbackChain: Promise<unknown> = Promise.resolve();
let fallbackPending = 0;

function runFallbackExclusive<T>(fn: () => Promise<T>): Promise<T> {
  fallbackPending += 1;
  const run = fallbackChain.then(fn, fn);
  fallbackChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run.finally(() => {
    fallbackPending -= 1;
  });
}

/** Выполняет fn под локом, дожидаясь освобождения. */
export async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = lockManager();
  if (!locks) return runFallbackExclusive(fn);
  return (await locks.request(LOCK_NAME, fn)) as T;
}

/**
 * Выполняет fn, только если лок свободен. Возвращает true, если fn отработала.
 * Для фоновых fire-and-forget вызовов (интервальный sync, дозагрузка фото):
 * ждущий вариант выстроил бы очередь из нескольких полных проходов sync.
 */
export async function tryRunExclusive(fn: () => Promise<void>): Promise<boolean> {
  const locks = lockManager();
  if (!locks) {
    if (fallbackPending > 0) return false;
    await runFallbackExclusive(fn);
    return true;
  }
  return (await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
    if (!lock) return false;
    await fn();
    return true;
  })) as boolean;
}
