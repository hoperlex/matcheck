import { afterEach, describe, expect, it, vi } from 'vitest';
import { withMinimumDuration } from '../src/lib/constant-time.js';

/**
 * Выравнивание времени ответа — защита от перечисления пользователей: для
 * существующего email обработчик пишет в базу, для неизвестного нет, и без
 * выравнивания эта разница видна в задержке.
 *
 * Проверяем на fake timers, а не по настенным часам: замер реальных
 * миллисекунд в CI даёт плавающие результаты и тест начинают игнорировать.
 */
describe('withMinimumDuration — постоянная нижняя граница ответа', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('быструю ветку добивает до минимума', async () => {
    vi.useFakeTimers();
    let settled = false;
    const promise = withMinimumDuration(async () => 'быстро', 300).then((v) => {
      settled = true;
      return v;
    });

    // Сама работа завершена, но ответ ещё не отдан.
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('быстро');
  });

  it('медленную ветку не задерживает дополнительно', async () => {
    vi.useFakeTimers();
    const promise = withMinimumDuration(async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 'медленно';
    }, 300);

    // Гарантия односторонняя: «не быстрее минимума», а не «ровно минимум».
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe('медленно');
  });

  it('ошибку пробрасывает, но тоже не раньше минимума', async () => {
    vi.useFakeTimers();
    let settled = false;
    const promise = withMinimumDuration(async () => {
      throw new Error('boom');
    }, 300).catch((e: Error) => {
      settled = true;
      return e.message;
    });

    // Иначе неизвестный email выдавал бы себя мгновенной ошибкой.
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('boom');
  });
});
