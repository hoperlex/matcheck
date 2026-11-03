/**
 * Групповая привязка из списка: эталон подбора по умолчанию — первая отмеченная
 * приёмка с документом. У приёмки без документа подбору не за что зацепиться.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Delivery } from '@matcheck/contracts';

vi.mock('../../services/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class extends Error {},
}));

const { defaultAnchor } = await import('./BulkEdoLinkFlow');

const d = (id: string, sourceDocumentIds: string[] = []) =>
  ({ id, sourceDocumentIds }) as unknown as Delivery;

describe('defaultAnchor', () => {
  it('первая с документом, иначе первая; пусто — нет эталона', () => {
    expect(defaultAnchor([d('a'), d('b', ['doc']), d('c', ['doc'])])).toBe('b');
    expect(defaultAnchor([d('a'), d('b')])).toBe('a');
    expect(defaultAnchor([])).toBeNull();
  });
});
