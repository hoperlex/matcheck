import { describe, it, expect } from 'vitest';
import type { UpdPdfItem, UpdPdfParsed } from '@matcheck/contracts';
import { normalizeM15ZeroTotals } from '../src/domain/edo/m15-normalize.js';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';

// ── Фабрики фикстур ──────────────────────────────────────────────────────────

function item(over: Partial<UpdPdfItem> = {}): UpdPdfItem {
  return {
    nameRaw: 'Подкладка под СПК, L-100мм',
    unit: 'шт',
    qty: 30,
    price: null,
    sum: null,
    vatRate: null,
    vatSum: null,
    ...over,
  };
}

/** По умолчанию — толлинг-М-15 №191: шапка есть, стоимость пуста везде. */
function doc(over: Partial<UpdPdfParsed> = {}): UpdPdfParsed {
  return {
    docNumber: '191',
    docDate: '2026-07-03',
    totalSum: null,
    vatSum: null,
    itemsCount: null,
    items: [item(), item({ nameRaw: 'Втулка L-94 мм', qty: 25 })],
    confidence: 0.85,
    ...over,
  };
}

// ── Юниты pure-функции: вход → выход по всем ветвям ───────────────────────────

describe('normalizeM15ZeroTotals — доопределение нулевого итога для толлинг-М-15', () => {
  it('m15 + позиции + стоимость пуста везде → totalSum/vatSum = 0 (новый объект)', () => {
    const input = doc();
    const out = normalizeM15ZeroTotals(input, 'm15');
    expect(out.totalSum).toBe(0);
    expect(out.vatSum).toBe(0);
    // immutable: вход не мутирован, возвращена копия.
    expect(input.totalSum).toBeNull();
    expect(input.vatSum).toBeNull();
    expect(out).not.toBe(input);
    // прочие поля сохранены.
    expect(out.docNumber).toBe('191');
    expect(out.items).toHaveLength(2);
  });

  it('РЕГРЕСС: m15 + у строки есть sum → без изменений (totalSum остаётся null)', () => {
    const input = doc({ items: [item(), item({ sum: 1200 })] });
    const out = normalizeM15ZeroTotals(input, 'm15');
    expect(out).toBe(input); // тот же объект — no-op
    expect(out.totalSum).toBeNull();
  });

  it('РЕГРЕСС: m15 + у строки есть price → без изменений', () => {
    const input = doc({ items: [item({ price: 40 })] });
    expect(normalizeM15ZeroTotals(input, 'm15')).toBe(input);
  });

  it('РЕГРЕСС: m15 + у строки есть vatSum → без изменений', () => {
    const input = doc({ items: [item({ vatSum: 100 })] });
    expect(normalizeM15ZeroTotals(input, 'm15')).toBe(input);
  });

  it('РЕГРЕСС: m15 + шапочный totalSum уже задан → без изменений', () => {
    const input = doc({ totalSum: 5000 });
    const out = normalizeM15ZeroTotals(input, 'm15');
    expect(out).toBe(input);
    expect(out.totalSum).toBe(5000);
  });

  it('РЕГРЕСС: m15 + шапочный vatSum задан (totalSum null) → без изменений', () => {
    const input = doc({ vatSum: 800 });
    expect(normalizeM15ZeroTotals(input, 'm15')).toBe(input);
  });

  it('РЕГРЕСС: m15 + нет позиций → без изменений', () => {
    const input = doc({ items: [] });
    const out = normalizeM15ZeroTotals(input, 'm15');
    expect(out).toBe(input);
    expect(out.totalSum).toBeNull();
  });

  it('РЕГРЕСС: docKind=upd + пустая стоимость → без изменений (guard по docKind)', () => {
    const input = doc();
    expect(normalizeM15ZeroTotals(input, 'upd')).toBe(input);
    expect(input.totalSum).toBeNull();
  });

  it('РЕГРЕСС: docKind=undefined + пустая стоимость → без изменений', () => {
    const input = doc();
    expect(normalizeM15ZeroTotals(input, undefined)).toBe(input);
  });
});

// ── Связка со статусом: воспроизводим инвариант из worker.ts:806-812 ──────────
// worker.ts НЕ трогаем (нулевой риск для общего save-path), поэтому расчёт
// статуса дублируем локальным хелпером теста — так проверяем, что нормализация
// действительно переводит толлинг-М-15 в «обработано», а регресс-кейсы остаются
// «распознано частично».

function outcome(parsed: UpdPdfParsed): {
  status: 'parsed' | 'needs_resolution';
  hasMismatch: boolean;
  isIncomplete: boolean;
} {
  const validation = validateUpdTotals({
    totalSum: parsed.totalSum ?? null,
    vatSum: parsed.vatSum ?? null,
    itemsCount: parsed.itemsCount ?? null,
    items: parsed.items.map((i) => ({ qty: i.qty, price: i.price ?? null, sum: i.sum ?? null })),
  });
  const isIncomplete =
    parsed.items.length === 0 ||
    parsed.totalSum == null ||
    parsed.docNumber == null ||
    parsed.docDate == null;
  const status: 'parsed' | 'needs_resolution' =
    validation.hasMismatch || isIncomplete ? 'needs_resolution' : 'parsed';
  return { status, hasMismatch: validation.hasMismatch, isIncomplete };
}

describe('связка normalize → validateUpdTotals → статус', () => {
  it('толлинг-М-15: после normalize → parsed, mismatch=false, totalSum=0', () => {
    const normalized = normalizeM15ZeroTotals(doc(), 'm15');
    const r = outcome(normalized);
    expect(normalized.totalSum).toBe(0);
    expect(r.hasMismatch).toBe(false);
    expect(r.isIncomplete).toBe(false);
    expect(r.status).toBe('parsed');
  });

  it('РЕГРЕСС: М-15 со стоимостью в строке, но без итога → needs_resolution', () => {
    const normalized = normalizeM15ZeroTotals(doc({ items: [item({ sum: 1200 })] }), 'm15');
    expect(normalized.totalSum).toBeNull();
    expect(outcome(normalized).status).toBe('needs_resolution');
  });

  it('РЕГРЕСС: обычный УПД без итога → needs_resolution (нормализация не задевает)', () => {
    const normalized = normalizeM15ZeroTotals(doc(), 'upd');
    expect(normalized.totalSum).toBeNull();
    expect(outcome(normalized).status).toBe('needs_resolution');
  });

  it('РЕГРЕСС: М-15 без позиций → needs_resolution', () => {
    const normalized = normalizeM15ZeroTotals(doc({ items: [] }), 'm15');
    expect(outcome(normalized).status).toBe('needs_resolution');
  });
});
