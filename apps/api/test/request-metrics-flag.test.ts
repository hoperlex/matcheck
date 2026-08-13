/**
 * Рубильник метрик обязан выключаться.
 *
 * REQUEST_METRICS_ENABLED раньше читался через z.coerce.boolean(), а он
 * превращает ЛЮБУЮ непустую строку в true — включая '0' и 'false'. То есть
 * REQUEST_METRICS_ENABLED=0 включал метрики вместо того, чтобы выключить, и
 * убрать их можно было только удалением переменной целиком.
 *
 * Цена ошибки здесь выше, чем «лишний оверхед»: плагин пишет строку
 * `req-metric` в лог на КАЖДЫЙ HTTP-ответ, а метрики включают временным окном
 * на боевом API. Рубильник, который нельзя выключить, означает распухающие
 * логи на контейнере, который и так делит VPS с соседями.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function loadFlag(value: string | undefined): Promise<boolean> {
  if (value === undefined) delete process.env.REQUEST_METRICS_ENABLED;
  else process.env.REQUEST_METRICS_ENABLED = value;
  vi.resetModules();
  const { loadEnv } = await import('../src/lib/env.js');
  return loadEnv().REQUEST_METRICS_ENABLED;
}

describe('REQUEST_METRICS_ENABLED', () => {
  it("'0' выключает метрики, а не включает", async () => {
    expect(await loadFlag('0')).toBe(false);
  });

  it("'1' включает метрики", async () => {
    expect(await loadFlag('1')).toBe(true);
  });

  it('по умолчанию выключено', async () => {
    expect(await loadFlag(undefined)).toBe(false);
  });

  it('ПУСТОЕ значение не роняет старт, а читается как выключено', async () => {
    // `REQUEST_METRICS_ENABLED=` — ровно то, что получается при копировании
    // env-примера с незаполненным значением. Пустая строка приходит в схему
    // как '', а не undefined, поэтому .default('0') до неё не доходит: без
    // preprocess валидация падала бы и роняла api и worker целиком.
    expect(await loadFlag('')).toBe(false);
  });

  it('мусорное значение падает на старте, а не включает метрики молча', async () => {
    // Явная ошибка конфигурации лучше тихого включения: 'true' или 'yes' —
    // типичная попытка выставить флаг «по привычке», и она должна быть видна
    // сразу, а не через сутки распухших логов.
    process.env.REQUEST_METRICS_ENABLED = 'true';
    vi.resetModules();
    const { loadEnv } = await import('../src/lib/env.js');
    expect(() => loadEnv()).toThrow();
  });
});
