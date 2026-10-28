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
