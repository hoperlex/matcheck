import { loadEnv } from './env.js';

const env = loadEnv();

/**
 * Минимальная длительность ответа — против перечисления пользователей по
 * времени.
 *
 * Одинакового тела ответа мало: для существующего email обработчик пишет в базу,
 * для неизвестного нет, и эта разница видна в задержке. Выравнивание убирает
 * канал: ответ не может прийти раньше `minMs` независимо от того, что нашлось.
 *
 * Гарантия односторонняя — «не быстрее», а не «ровно столько». Если работа
 * заняла больше, ответ уйдёт позже: искусственно ускорить его нельзя, а
 * маскировать медленную ветку пришлось бы задержкой на порядок больше.
 */
// Дефолт для роутов: в тестах ноль, иначе набор из десятков запросов растянулся
// бы на десятки секунд. Само выравнивание проверяется unit-тестом, который
// передаёт длительность явно — переданное значение всегда уважается.
export const MIN_ANTI_ENUMERATION_MS = env.NODE_ENV === 'test' ? 0 : 300;

export async function withMinimumDuration<T>(
  fn: () => Promise<T>,
  minMs: number = MIN_ANTI_ENUMERATION_MS,
): Promise<T> {
  const budget = minMs;
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - startedAt;
    if (budget > elapsed) {
      await new Promise((resolve) => setTimeout(resolve, budget - elapsed));
    }
  }
}
