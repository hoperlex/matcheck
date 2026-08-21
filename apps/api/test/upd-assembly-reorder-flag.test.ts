/**
 * Рубильник перестановки страниц обязан выключаться.
 *
 * Проверка планировщика (upd-assembly-reorder.test.ts) ничего не говорит о том,
 * доходит ли до него нужное значение флага. А цена ошибки здесь несимметрична:
 * перестановка меняет состав документов, и «включено вопреки конфигу» гораздо
 * хуже, чем «выключено».
 *
 * Грабли известные: z.coerce.boolean() превращает ЛЮБУЮ непустую строку в true,
 * включая '0' и 'false' — то есть UPD_ASSEMBLY_REORDER_V1=0 включал бы
 * перестановку вместо того, чтобы выключить, и убрать её можно было бы только
 * удалением переменной целиком. Схема использует enum('0','1'); этот набор
 * фиксирует контракт, чтобы правка схемы не вернула прежнее поведение молча.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function loadFlag(value: string | undefined): Promise<boolean> {
  if (value === undefined) delete process.env.UPD_ASSEMBLY_REORDER_V1;
  else process.env.UPD_ASSEMBLY_REORDER_V1 = value;
  vi.resetModules();
  const { loadEnv } = await import('../src/lib/env.js');
  return loadEnv().UPD_ASSEMBLY_REORDER_V1;
}

describe('UPD_ASSEMBLY_REORDER_V1', () => {
  it("'0' выключает перестановку, а не включает", async () => {
    expect(await loadFlag('0')).toBe(false);
  });

  it("'1' включает перестановку", async () => {
    expect(await loadFlag('1')).toBe(true);
  });

  it('по умолчанию выключено', async () => {
    expect(await loadFlag(undefined)).toBe(false);
  });

  it('ПУСТОЕ значение не роняет старт, а читается как выключено', async () => {
    // Ровно то, что получается при копировании env-примера с незаполненным
    // значением: в схему приходит '', а не undefined, и .default('0') до неё
    // не доходит — без preprocess валидация уронила бы api и worker целиком.
    expect(await loadFlag('')).toBe(false);
  });

  it('мусорное значение падает на старте, а не включает перестановку молча', async () => {
    process.env.UPD_ASSEMBLY_REORDER_V1 = 'true';
    vi.resetModules();
    const { loadEnv } = await import('../src/lib/env.js');
    expect(() => loadEnv()).toThrow();
  });
});
