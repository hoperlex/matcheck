import { describe, it, expect, vi } from 'vitest';

// Модуль тянет клиент БД и провайдеров LLM — для чистой функции нормализации
// они не нужны, но импорт без них падает.
vi.mock('../src/db/client.js', () => ({ db: {} }));

const { normalizeKind } = await import('../src/domain/edo/vision-classifier.js');

describe('vision-classifier normalizeKind', () => {
  it('распознаёт документы качества как supplementary', () => {
    // Модель отвечает свободным текстом, и синонимы приходят регулярно.
    expect(normalizeKind('supplementary')).toBe('supplementary');
    expect(normalizeKind('certificate')).toBe('supplementary');
    expect(normalizeKind('сертификат')).toBe('supplementary');
    expect(normalizeKind('паспорт качества')).toBe('supplementary');
  });

  it('прежние виды не задеты', () => {
    expect(normalizeKind('upd')).toBe('upd');
    expect(normalizeKind('transport_waybill')).toBe('transport_waybill');
    expect(normalizeKind('м-15')).toBe('m15');
  });

  it('незнакомое и пустое → unknown', () => {
    expect(normalizeKind('накладная-чего-то')).toBe('unknown');
    expect(normalizeKind(undefined)).toBe('unknown');
  });
});
