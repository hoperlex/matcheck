/**
 * Тест-замок на промпт распознавания фото документа.
 *
 * Промпт живёт в коде, а не в таблице prompts, — значит у него нет ни версии,
 * ни кнопки отката, и единственная защита от тихой потери правил — этот тест.
 * Правила добавлены после боевого случая с УПД № 848: «66,294 м² × 8 114,75 ₽»
 * распозналось как qty 8114.75 / price 66.294.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'domain', 'photos', 'recognize.ts'),
  'utf8',
);

describe('промпт распознавания фото документа', () => {
  it('описывает раскладку граф УПД и счёта-фактуры', () => {
    expect(src).toContain('qty читается из графы 3, price — из графы 4, sum — из графы 5');
    expect(src).toContain('является разметкой заголовка');
    expect(src).toContain('пока в графе 1 не появился новый номер');
  });

  it('не выдаёт точность цены за признак перестановки', () => {
    expect(src).toContain('цена может иметь более двух знаков');
    expect(src).not.toMatch(/максимум два знака/i);
  });

  it('оставляет прежнюю семантику остальным формам', () => {
    expect(src).toMatch(/Для остальных форм .*правила про номера граф не применяй/);
  });
});
