import { describe, it, expect } from 'vitest';
import type { EdoDryRunReport } from '@matcheck/contracts';
import { acceptedCount, contentSummary, contentTone, itemKindLabel } from './edo-dry-run-view';

function report(patch: Partial<EdoDryRunReport> = {}): EdoDryRunReport {
  return {
    eventsSeen: 40,
    truncated: false,
    candidates: 7,
    examined: 7,
    interrupted: null,
    selection: { byMeta: [], byContent: [] },
    documents: [],
    scans: [],
    ...patch,
  };
}

describe('сводка пробного разбора', () => {
  it('складывает скачанные УПД по категориям', () => {
    const r = report({
      selection: {
        byMeta: [],
        byContent: [
          { category: 'materials', label: 'материалы', count: 3 },
          { category: 'services', label: 'работы или услуги', count: 4 },
        ],
      },
    });
    expect(contentSummary(r)).toBe('Скачано УПД: 7. 3 — материалы, 4 — работы или услуги');
  });

  it('без скачиваний так и говорит', () => {
    expect(contentSummary(report())).toBe('УПД не скачивались');
  });

  it('считает только документы, которые прошли бы в карточки', () => {
    const doc = { accepted: true } as EdoDryRunReport['documents'][number];
    expect(acceptedCount(report({ documents: [doc, { ...doc, accepted: false }] }))).toBe(1);
  });
});

describe('подписи', () => {
  it('признак предмета позиции', () => {
    expect(itemKindLabel(1)).toBe('имущество');
    expect(itemKindLabel(3)).toBe('услуга');
    expect(itemKindLabel(null)).toBe('признак не указан');
    expect(itemKindLabel(9)).toBe('код 9');
  });

  it('цвет категории', () => {
    expect(contentTone('materials')).toBe('green');
    expect(contentTone('undetermined')).toBe('orange');
    expect(contentTone('services')).toBe('default');
    expect(contentTone(null)).toBe('red');
  });
});
