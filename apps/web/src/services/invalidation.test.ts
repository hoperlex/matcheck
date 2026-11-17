// @vitest-environment jsdom
/**
 * SSE-события перечитывают сверку открытого фото документа.
 *
 * Таблица фото сверяется с УПД операции (linkedDocument), а запрос
 * ['photo-recognition', photoId] держится 60 секунд. Без инвалидации после
 * привязки, отвязки или правки УПД уже открытое фото показывало бы прежнюю
 * сверку.
 */
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupInvalidation } from './invalidation';

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners = new Map<string, (evt: MessageEvent) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (evt: MessageEvent) => void): void {
    this.listeners.set(type, fn);
  }
  close(): void {}
  emit(type: string): void {
    this.listeners.get(type)?.(new MessageEvent(type));
  }
}

describe('setupInvalidation → photo-recognition', () => {
  let invalidateQueries: ReturnType<typeof vi.fn>;
  let teardown: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    invalidateQueries = vi.fn().mockResolvedValue(undefined);
    teardown = setupInvalidation({ invalidateQueries } as unknown as QueryClient);
  });

  afterEach(() => {
    teardown();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const invalidatedKeys = () =>
    invalidateQueries.mock.calls.map(([arg]) =>
      JSON.stringify((arg as { queryKey: unknown }).queryKey),
    );

  it.each(['delivery_updated', 'shipment_updated', 'source_document_updated'])(
    '%s сбрасывает сверку фото',
    (type) => {
      FakeEventSource.last!.emit(type);
      vi.advanceTimersByTime(500);
      expect(invalidatedKeys()).toContain(JSON.stringify(['photo-recognition']));
    },
  );
});

describe('поток событий открывается только ролям, которым его отдаёт сервер', () => {
  it('зеркало allow-list /api/v1/events', async () => {
    const { sseAvailableForRole } = await import('./invalidation');
    expect(sseAvailableForRole('admin')).toBe(true);
    expect(sseAvailableForRole('manager')).toBe(true);
    expect(sseAvailableForRole('inspector_kpp')).toBe(true);
    for (const role of ['observer', 'monitor', 'contractor', undefined]) {
      expect(sseAvailableForRole(role), String(role)).toBe(false);
    }
  });

  it('при sse: false EventSource не создаётся, межвкладочная инвалидация живёт', () => {
    vi.useFakeTimers();
    const created = vi.fn();
    vi.stubGlobal(
      'EventSource',
      class {
        constructor() {
          created();
        }
        addEventListener() {}
        close() {}
      },
    );
    const teardown = setupInvalidation(
      { invalidateQueries: vi.fn().mockResolvedValue(undefined) } as unknown as QueryClient,
      { sse: false },
    );
    expect(created).not.toHaveBeenCalled();
    teardown();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
