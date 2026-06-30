import { describe, it, expect } from 'vitest';
import {
  parseRouterVisionRaw,
  mapVisionKind,
} from '../src/domain/edo/document-router-vision.js';

/**
 * Офлайн-ядро vision-доклассификации (Этап 4) — без сети. Замораживает
 * разбор ответа модели и маппинг типа. Безопасность: всё неясное → unknown/0,
 * чтобы worker никогда не создал документ наугад.
 */

describe('mapVisionKind — сырой kind → DocClass', () => {
  it('известные типы маппятся 1:1', () => {
    expect(mapVisionKind('upd')).toBe('upd');
    expect(mapVisionKind('transport_waybill')).toBe('transport_waybill');
    expect(mapVisionKind('os2_transfer')).toBe('os2_transfer');
    expect(mapVisionKind('m15')).toBe('m15');
  });
  it('other / мусор / null → unknown', () => {
    expect(mapVisionKind('other')).toBe('unknown');
    expect(mapVisionKind('что-то')).toBe('unknown');
    expect(mapVisionKind(undefined)).toBe('unknown');
    expect(mapVisionKind(null)).toBe('unknown');
  });
});

describe('parseRouterVisionRaw — разбор ответа классификатора', () => {
  it('валидный УПД с высокой уверенностью', () => {
    const r = parseRouterVisionRaw('{"kind":"upd","confidence":0.93}');
    expect(r.kind).toBe('upd');
    expect(r.confidence).toBeCloseTo(0.93);
  });

  it('накладная', () => {
    const r = parseRouterVisionRaw('{"kind":"transport_waybill","confidence":0.88}');
    expect(r.kind).toBe('transport_waybill');
    expect(r.confidence).toBeCloseTo(0.88);
  });

  it('array-обёртка (Gemini preview [{…}]) разворачивается', () => {
    const r = parseRouterVisionRaw('[{"kind":"upd","confidence":0.9}]');
    expect(r.kind).toBe('upd');
    expect(r.confidence).toBeCloseTo(0.9);
  });

  it('markdown-ограждения снимаются', () => {
    const r = parseRouterVisionRaw('```json\n{"kind":"os2_transfer","confidence":0.86}\n```');
    expect(r.kind).toBe('os2_transfer');
    expect(r.confidence).toBeCloseTo(0.86);
  });

  it('other → unknown и confidence обнуляется (никогда не авто-создаём)', () => {
    const r = parseRouterVisionRaw('{"kind":"other","confidence":0.99}');
    expect(r.kind).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  it('м15 сохраняется как m15 (worker уведёт в needs_review)', () => {
    const r = parseRouterVisionRaw('{"kind":"m15","confidence":0.8}');
    expect(r.kind).toBe('m15');
    expect(r.confidence).toBeCloseTo(0.8);
  });

  it('confidence вне диапазона клампится в 0..1', () => {
    expect(parseRouterVisionRaw('{"kind":"upd","confidence":1.5}').confidence).toBe(1);
    expect(parseRouterVisionRaw('{"kind":"upd","confidence":-0.3}').confidence).toBe(0);
  });

  it('confidence не число → 0', () => {
    const r = parseRouterVisionRaw('{"kind":"upd","confidence":"высокая"}');
    expect(r.kind).toBe('upd');
    expect(r.confidence).toBe(0);
  });

  it('битый JSON → unknown/0 (безопасный дефолт)', () => {
    expect(parseRouterVisionRaw('не json вовсе')).toEqual({ kind: 'unknown', confidence: 0 });
    expect(parseRouterVisionRaw('{"kind":"upd",')).toEqual({ kind: 'unknown', confidence: 0 });
  });

  it('null / пустая строка → unknown/0', () => {
    expect(parseRouterVisionRaw(null)).toEqual({ kind: 'unknown', confidence: 0 });
    expect(parseRouterVisionRaw('')).toEqual({ kind: 'unknown', confidence: 0 });
  });

  it('пустой массив и многоэлементный массив не разворачиваются → unknown/0', () => {
    expect(parseRouterVisionRaw('[]')).toEqual({ kind: 'unknown', confidence: 0 });
    expect(
      parseRouterVisionRaw('[{"kind":"upd","confidence":0.9},{"kind":"upd","confidence":0.8}]'),
    ).toEqual({ kind: 'unknown', confidence: 0 });
  });
});
