/**
 * Рубильники нового поведения обязаны выключаться.
 *
 * Грабли известные и дорогие: z.coerce.boolean() превращает ЛЮБУЮ непустую
 * строку в true, включая '0' — то есть попытка выключить режим включала бы
 * его. Набор фиксирует контракт схемы, чтобы правка env не вернула это молча.
 *
 * Цена ошибки несимметрична: «включено вопреки конфигу» на боевом потоке
 * документов хуже, чем «выключено», — поэтому проверяем именно выключение.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function loadValue<K extends string>(key: K, value: string | undefined): Promise<unknown> {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  vi.resetModules();
  const { loadEnv } = await import('../src/lib/env.js');
  return (loadEnv() as unknown as Record<string, unknown>)[key];
}

describe('UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER', () => {
  it('по умолчанию выключен', async () => {
    expect(await loadValue('UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER', undefined)).toBe('off');
  });

  it('пустое значение читается как выключено, а не роняет старт', async () => {
    // Ровно то, что получается при копировании env-примера с незаполненным
    // значением: в схему приходит '', и без preprocess упали бы api и worker.
    expect(await loadValue('UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER', '')).toBe('off');
  });

  it('различает shadow и on', async () => {
    expect(await loadValue('UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER', 'shadow')).toBe('shadow');
    expect(await loadValue('UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER', 'on')).toBe('on');
  });

  it('мусор роняет старт, а не включает режим молча', async () => {
    await expect(loadValue('UPD_ASSEMBLY_SPLIT_BY_DOC_NUMBER', 'true')).rejects.toThrow();
  });
});

describe('UPD_ASSEMBLY_ROLLBACK_KIND', () => {
  it('по умолчанию выключен', async () => {
    expect(await loadValue('UPD_ASSEMBLY_ROLLBACK_KIND', undefined)).toBe('off');
  });

  it('пустое значение читается как выключено', async () => {
    expect(await loadValue('UPD_ASSEMBLY_ROLLBACK_KIND', '')).toBe('off');
  });

  it('мусор роняет старт', async () => {
    await expect(loadValue('UPD_ASSEMBLY_ROLLBACK_KIND', 'yes')).rejects.toThrow();
  });
});

describe('UPD_ASSEMBLY_NUMBER_AUDIT', () => {
  it("'0' выключает аудит, а не включает", async () => {
    expect(await loadValue('UPD_ASSEMBLY_NUMBER_AUDIT', '0')).toBe(false);
  });

  it("'1' включает", async () => {
    expect(await loadValue('UPD_ASSEMBLY_NUMBER_AUDIT', '1')).toBe(true);
  });

  it('по умолчанию и при пустом значении выключен', async () => {
    expect(await loadValue('UPD_ASSEMBLY_NUMBER_AUDIT', undefined)).toBe(false);
    expect(await loadValue('UPD_ASSEMBLY_NUMBER_AUDIT', '')).toBe(false);
  });
});
