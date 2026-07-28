import { describe, it, expect } from 'vitest';
import {
  parseOperationComment,
  buildOperationComment,
  mergeOperationComment,
  normalizeRawComment,
  OperationCommentPatchSchema,
  COMMENT_SLOT_MAX,
  COMMENT_RAW_MAX,
} from '@matcheck/contracts';

/**
 * Комментарий приёмки/отгрузки — одна колонка, в которую мобильный клиент пакует
 * «1 Этап / 2 Этап / Примечание». Теперь строку пересобирает сервер (слот-мерж в
 * PATCH /:id/comment), поэтому байтовая совместимость с мобильным билдером
 * (Stage2FormViewModel.buildCombinedComment) — не деталь реализации, а контракт
 * между клиентами. Литералы ниже пинят его.
 *
 * Запись в БД, статусный гейт и 409-ветки — инлайн-логика роутов; покрываются
 * ручным E2E из плана.
 */

describe('buildOperationComment — байтовая совместимость с мобильным билдером', () => {
  it('один слот', () => {
    expect(buildOperationComment({ stage1: 'гипсокартон' })).toBe('1 Этап: "гипсокартон"');
    expect(buildOperationComment({ stage2: 'принято' })).toBe('2 Этап: "принято"');
    expect(buildOperationComment({ note: '7256' })).toBe('Примечание: 7256');
  });

  it('все три слота — порядок и разделитель', () => {
    expect(buildOperationComment({ stage1: 'а', stage2: 'б', note: 'в' })).toBe(
      '1 Этап: "а"\n2 Этап: "б"\nПримечание: в',
    );
  });

  it('пустые/пробельные/null слоты пропускаются, пустой строки в середине не остаётся', () => {
    expect(buildOperationComment({ stage1: '', stage2: 'б' })).toBe('2 Этап: "б"');
    expect(buildOperationComment({ stage1: '   ', stage2: 'б', note: null })).toBe('2 Этап: "б"');
  });

  it('полностью пустой набор → null (а не пустая строка)', () => {
    expect(buildOperationComment({})).toBeNull();
    expect(buildOperationComment({ stage1: null, stage2: '', note: '  ' })).toBeNull();
  });

  it('переносы строк внутри слота схлопываются в пробел — иначе парсер развалится', () => {
    expect(buildOperationComment({ stage2: 'а\nб' })).toBe('2 Этап: "а б"');
    expect(buildOperationComment({ stage2: 'а\r\nб' })).toBe('2 Этап: "а б"');
    expect(buildOperationComment({ stage2: 'а\rб' })).toBe('2 Этап: "а б"');
    // и результат обязан остаться разбираемым
    expect(parseOperationComment(buildOperationComment({ stage2: 'а\nб' })!).stage2).toBe('а б');
  });
});

describe('parseOperationComment', () => {
  it('разбирает мобильный вывод', () => {
    const p = parseOperationComment('1 Этап: "гипсокартон"\n2 Этап: "ок"\nПримечание: 7256');
    expect(p.stage1).toBe('гипсокартон');
    expect(p.stage2).toBe('ок');
    expect(p.note).toBe('7256');
    expect(p.hasStructure).toBe(true);
    expect(p.isCanonical).toBe(true);
  });

  it('пустой вход — без структуры', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const p = parseOperationComment(raw);
      expect(p.hasStructure).toBe(false);
      expect(p.isCanonical).toBe(false);
      expect(p.stage1).toBeNull();
    }
  });

  it('строки без префикса уходят хвостом во 2 Этап (backward-compat) и не каноничны', () => {
    const p = parseOperationComment('старый текст без маркеров');
    expect(p.stage2).toBe('старый текст без маркеров');
    expect(p.hasStructure).toBe(false);
    expect(p.leftovers).toEqual(['старый текст без маркеров']);
    expect(p.isCanonical).toBe(false);
  });

  it('маркер + legacy-строка: hasStructure, но НЕ канонично (иначе merge потеряет строку)', () => {
    const p = parseOperationComment('1 Этап: "а"\n2 Этап: "б"\nхвост от старой версии');
    expect(p.hasStructure).toBe(true);
    expect(p.leftovers).toEqual(['хвост от старой версии']);
    expect(p.isCanonical).toBe(false);
  });

  it('хвостовой перевод строки делает комментарий неканоничным (lossless-правило)', () => {
    expect(parseOperationComment('1 Этап: "а"\n').isCanonical).toBe(false);
    expect(parseOperationComment('1 Этап: "а"').isCanonical).toBe(true);
  });

  it('лишние пробелы после двоеточия в «Примечание» — неканонично', () => {
    expect(parseOperationComment('Примечание:   7256').isCanonical).toBe(false);
    expect(parseOperationComment('Примечание: 7256').isCanonical).toBe(true);
  });
});

describe('round-trip parse(build(x)) === x', () => {
  const cases: Array<{ name: string; slots: Record<string, string> }> = [
    { name: 'кириллица', slots: { stage1: 'гипсокартон 12 мм', stage2: 'принято полностью' } },
    { name: 'кавычки внутри текста', slots: { stage1: 'водитель сказал "потом"' } },
    { name: 'двоеточия внутри текста', slots: { stage2: 'время: 11:10, борт открыт' } },
    { name: 'текст, похожий на маркер', slots: { stage1: '2 Этап: "подделка"' } },
    { name: 'номер УПД в примечании', slots: { note: 'УПД-7256/1' } },
    { name: 'все три слота', slots: { stage1: 'а', stage2: 'б', note: 'в' } },
    { name: 'внутренние пробелы сохраняются', slots: { stage1: 'а  б' } },
  ];

  for (const { name, slots } of cases) {
    it(name, () => {
      const built = buildOperationComment(slots);
      expect(built).not.toBeNull();
      const parsed = parseOperationComment(built);
      expect(parsed.isCanonical).toBe(true);
      expect(parsed.stage1).toBe(slots.stage1 ?? null);
      expect(parsed.stage2).toBe(slots.stage2 ?? null);
      expect(parsed.note).toBe(slots.note ?? null);
      // повторная сборка из разобранного даёт ту же строку
      expect(buildOperationComment(parsed)).toBe(built);
    });
  }
});

describe('mergeOperationComment — слот-мерж против гонки с мобилой', () => {
  it('правка одного слота не трогает остальные', () => {
    const current = '1 Этап: "с1"\n2 Этап: "с2"';
    const r = mergeOperationComment(current, { note: 'н' });
    expect(r).toEqual({ ok: true, comment: '1 Этап: "с1"\n2 Этап: "с2"\nПримечание: н' });
  });

  it('свежий «2 Этап» от мобилы выживает при правке «Примечания»', () => {
    // менеджер открыл документ, когда 2 Этапа ещё не было, и правит только note
    const currentOnServer = '1 Этап: "с1"\n2 Этап: "дописано инспектором"';
    const r = mergeOperationComment(currentOnServer, { note: 'новое' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.comment).toContain('2 Этап: "дописано инспектором"');
  });

  it('null очищает слот, строка исчезает целиком', () => {
    const r = mergeOperationComment('1 Этап: "а"\n2 Этап: "б"', { stage1: null });
    expect(r).toEqual({ ok: true, comment: '2 Этап: "б"' });
  });

  it('очистка последнего слота даёт null, а не пустую строку', () => {
    expect(mergeOperationComment('1 Этап: "а"', { stage1: null })).toEqual({
      ok: true,
      comment: null,
    });
  });

  it('пустой текущий комментарий — валидная база: слот можно добавить', () => {
    expect(mergeOperationComment(null, { note: '7256' })).toEqual({
      ok: true,
      comment: 'Примечание: 7256',
    });
    expect(mergeOperationComment('   ', { stage1: 'а' })).toEqual({
      ok: true,
      comment: '1 Этап: "а"',
    });
  });

  it('неканоническая строка отвергается — пересборка потеряла бы legacy-текст', () => {
    const r = mergeOperationComment('1 Этап: "а"\nхвост от старой версии', { note: 'н' });
    expect(r).toEqual({ ok: false, reason: 'not_canonical' });
  });
});

describe('normalizeRawComment — raw-режим сохраняет байты', () => {
  it('многострочный текст проходит без изменений (в т.ч. отступы и переносы)', () => {
    const raw = '  первая строка\n\n  вторая строка  ';
    expect(normalizeRawComment(raw)).toBe(raw);
  });

  it('пустое/пробельное → null', () => {
    expect(normalizeRawComment(null)).toBeNull();
    expect(normalizeRawComment(undefined)).toBeNull();
    expect(normalizeRawComment('')).toBeNull();
    expect(normalizeRawComment('  \n ')).toBeNull();
  });

  it('идемпотентность', () => {
    const raw = 'текст\nещё';
    expect(normalizeRawComment(normalizeRawComment(raw))).toBe(raw);
  });
});

describe('OperationCommentPatchSchema — тело PATCH /:id/comment', () => {
  it('слотовый режим валиден (одного слота достаточно)', () => {
    expect(OperationCommentPatchSchema.safeParse({ note: '7256' }).success).toBe(true);
    expect(OperationCommentPatchSchema.safeParse({ stage1: 'а', stage2: 'б' }).success).toBe(true);
    expect(OperationCommentPatchSchema.safeParse({ stage1: null }).success).toBe(true);
  });

  it('raw-режим валиден, в том числе очистка', () => {
    expect(OperationCommentPatchSchema.safeParse({ comment: 'текст' }).success).toBe(true);
    expect(OperationCommentPatchSchema.safeParse({ comment: null }).success).toBe(true);
  });

  it('оба режима сразу — невалидно', () => {
    expect(
      OperationCommentPatchSchema.safeParse({ comment: 'текст', stage1: 'а' }).success,
    ).toBe(false);
  });

  it('пустое тело — невалидно', () => {
    expect(OperationCommentPatchSchema.safeParse({}).success).toBe(false);
  });

  it('превышение лимитов — невалидно', () => {
    expect(
      OperationCommentPatchSchema.safeParse({ stage1: 'я'.repeat(COMMENT_SLOT_MAX + 1) }).success,
    ).toBe(false);
    expect(
      OperationCommentPatchSchema.safeParse({ comment: 'я'.repeat(COMMENT_RAW_MAX + 1) }).success,
    ).toBe(false);
    expect(
      OperationCommentPatchSchema.safeParse({ stage1: 'я'.repeat(COMMENT_SLOT_MAX) }).success,
    ).toBe(true);
  });
});
