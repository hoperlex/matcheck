import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Тест-замок на промпт v8.
 *
 * Цель — зафиксировать ключевые инструкции в SQL-миграции 0066:
 *   1. vatRate ВКЛЮЧАЕТ 22 (с 2026 г. в РФ).
 *   2. sum = графа 9 «с НАЛОГОМ», явно отделена от графы 5 «без налога».
 *   3. Multi-page: игнорировать страницы НЕ-УПД (ТН, спецификации, ...).
 *   4. Поворот страниц допустим — читать в любой ориентации.
 *
 * Если кто-то случайно отредактирует промпт и удалит ключевую фразу —
 * тест упадёт, и регрессию заметят до выкатки на стенд. Поведение
 * Vision-моделей очень чувствительно к этим формулировкам: например,
 * v7 без явного «22» возвращал vatRate=20 для УПД с НДС 22%.
 *
 * НЕ проверяем дословно весь промпт — он длинный и может уточняться
 * без слома семантики. Проверяем только критичные substring'и.
 */

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);

function loadPromptMigration(file: string): string {
  return readFileSync(join(migrationsDir, file), 'utf-8');
}

describe('0066_upd_prompt_v8 — содержимое активного промпта', () => {
  const sql = loadPromptMigration('0066_upd_prompt_v8.sql');

  it('SQL содержит INSERT с doc_kind=upd и is_active=true', () => {
    expect(sql).toMatch(/INSERT INTO "prompts"/i);
    expect(sql).toMatch(/'upd'/);
    expect(sql).toMatch(/, true\)/); // is_active = true
  });

  it('SQL деактивирует предыдущие промпты (UPDATE is_active=false)', () => {
    expect(sql).toMatch(/UPDATE "prompts" SET "is_active" = false/);
  });

  it('Имя промпта — "default v8"', () => {
    expect(sql).toContain("'default v8'");
  });

  it('vatRate явно включает 22 (с 2026 г. в РФ)', () => {
    // Раздел про графу 7: должен упоминать 22 как валидное значение.
    expect(sql).toMatch(/может быть 22,?\s*20,?\s*10/i);
    // Дополнительное упоминание про 2026: чтобы Vision не путал
    // с устаревшей формой «20% по умолчанию». dotall флаг — для
    // переноса строк в SQL.
    expect(sql).toMatch(/2026[\s\S]*22%/);
  });

  it('sum строго = графа 9, НЕ путать с графой 5', () => {
    // Самый частый источник ошибки Vision — путаница 5 и 9.
    expect(sql).toMatch(/ГРАФЫ 9/);
    expect(sql).toMatch(/НЕ\s+из\s+графы 5/i);
    // Объяснение разницы между 5 и 9 присутствует.
    expect(sql).toMatch(/графа 5[\s\S]*графа 9[\s\S]*РАЗНЫЕ/);
  });

  it('Multi-page инструкция: игнорировать ТН/спецификации/сертификаты', () => {
    // Эта инструкция критична для УПД_214 и подобных: 1 страница УПД +
    // 4 транспортных накладных. Без неё Vision смешивает позиции.
    expect(sql).toMatch(/транспортн.*наклад/i);
    expect(sql).toMatch(/специфика/i);
    expect(sql).toMatch(/паспорт.*качеств/i);
    expect(sql).toMatch(/ИГНОРИРУЙ/);
    expect(sql).toMatch(/Извлекай позиции ТОЛЬКО из страниц УПД/);
  });

  it('Поворот страниц: читать в любой ориентации (не понижать confidence)', () => {
    expect(sql).toMatch(/повёрнут/i);
    expect(sql).toMatch(/любой ориентации/i);
  });

  it('Существенные секции v7 сохранены (объём/масса, ОКЕИ, groupName)', () => {
    // Не сломать: эти разделы давали ценную инфу для Vision и
    // пользовались уже несколько релизов.
    expect(sql).toMatch(/ОКЕИ/);
    expect(sql).toMatch(/796.*шт/);
    expect(sql).toMatch(/volumeM3/);
    expect(sql).toMatch(/groupName/);
    expect(sql).toMatch(/confidence/);
  });

  it('Journal-файл включает миграцию 0066_upd_prompt_v8', () => {
    const journal = readFileSync(
      join(migrationsDir, 'meta', '_journal.json'),
      'utf-8',
    );
    expect(journal).toMatch(/"tag":\s*"0066_upd_prompt_v8"/);
  });
});
