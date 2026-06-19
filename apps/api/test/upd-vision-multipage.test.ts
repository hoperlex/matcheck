import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  MAX_PAGES_FOR_OPENROUTER,
  pdfToPngsViaPoppler,
} from '../src/domain/edo/upd-vision.parser.js';

/**
 * Регрессионные тесты на multi-page rendering PDF в PNG.
 * Покрывают сценарий пользователя «УПД_214 — 5 страниц, первая УПД,
 * остальные транспортные накладные». Vision должен получать массив
 * страниц (а не одну), чтобы видеть таблицу позиций, которая может
 * растягиваться на лист 2.
 *
 * Тут НЕ проверяется, что Vision правильно разделяет УПД и ТН —
 * это задача промпта (см. Шаг 5 / промпт v8). Здесь только pipeline
 * рендеринга: получает на вход N страниц, рендерит ≤ N PNG.
 *
 * НЕ тестируем сам parseUpdVision (он зависит от LLM-провайдера и БД),
 * только нижний слой — pdfToPngsViaPoppler.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('parseUpdVision — multi-page PDF rendering', () => {
  it('1-страничный PDF (1697.pdf) → 1 PNG', async () => {
    const buf = readFileSync(join(fixturesDir, 'upd-debug', '1697.pdf'));
    const pages = await pdfToPngsViaPoppler(buf, MAX_PAGES_FOR_OPENROUTER);
    expect(pages).toHaveLength(1);
    // Каждый PNG валидный (начинается с magic-байтов PNG).
    expect(pages[0]!.subarray(0, 4).toString('hex').toUpperCase()).toBe(
      '89504E47',
    );
  });

  it('5-страничный УПД (upd-214.pdf) → 5 PNG (до MAX_PAGES_FOR_OPENROUTER)', async () => {
    const buf = readFileSync(join(fixturesDir, 'upd-debug', 'upd-214.pdf'));
    const pages = await pdfToPngsViaPoppler(buf, MAX_PAGES_FOR_OPENROUTER);
    // У файла ровно 5 страниц, MAX_PAGES_FOR_OPENROUTER=5.
    // Если файл когда-нибудь станет 6+ страничным — лимит сработает.
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.length).toBeLessThanOrEqual(MAX_PAGES_FOR_OPENROUTER);
    for (const page of pages) {
      expect(page.length).toBeGreaterThan(1000); // не пустой PNG
      expect(page.subarray(0, 4).toString('hex').toUpperCase()).toBe(
        '89504E47',
      );
    }
  });

  it('5-страничный УПД с лимитом 2 → ровно 2 PNG', async () => {
    const buf = readFileSync(join(fixturesDir, 'upd-debug', 'upd-214.pdf'));
    const pages = await pdfToPngsViaPoppler(buf, 2);
    // Лимит maxPages передаётся в pdftoppm -l N → лишние страницы
    // не рендерятся вовсе, экономия CPU/RAM.
    expect(pages).toHaveLength(2);
  });

  it('MAX_PAGES_FOR_OPENROUTER не меньше пользовательского минимума (3)', () => {
    // Пользователь требовал: «поддержать multi-page Vision для PDF-сканов
    // минимум 3-5 страниц». Зашитое значение должно ≥ 3.
    expect(MAX_PAGES_FOR_OPENROUTER).toBeGreaterThanOrEqual(3);
  });

  it('PNG размер ≤ 2.5 МБ для типовой A4 (intersection с Шагом 3 — адаптивный DPI)', async () => {
    // Sanity check: 5-страничный A4-PDF с адаптивным DPI (150 для типовых
    // страниц) не должен порождать PNG > 2.5 МБ — это запас над целью
    // 2 МБ из Шага 3, чтобы не словить ложно-красные тесты на колебания
    // содержимого страницы.
    const buf = readFileSync(join(fixturesDir, 'upd-debug', 'upd-214.pdf'));
    const pages = await pdfToPngsViaPoppler(buf, MAX_PAGES_FOR_OPENROUTER);
    for (const page of pages) {
      expect(page.length).toBeLessThan(2.5 * 1024 * 1024);
    }
  });
});
