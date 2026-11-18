// @vitest-environment jsdom
/**
 * Отметки «фото просмотрено»: localStorage, ключ на фото, у каждого
 * пользователя свои. Здесь закрепляется то, ради чего ключ на фото, а не одна
 * карта: отметка другой вкладки не затирается своей записью; плюс смена
 * пользователя, очистка хранилища, потолок и отсчёт «простояло секунду».
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../stores/auth';
import {
  __resetPhotoViewedCacheForTests,
  markPhotoViewed,
  useMarkViewedAfterDwell,
  useViewedPhotos,
  VIEWED_DWELL_MS,
  VIEWED_MAX,
  VIEWED_TRIM_TO,
} from './photoViewed';

const user = (id: string) => ({ id }) as unknown as UserDto;
const key = (userId: string, photoId: string) => `matcheck.photoViewed.v1:${userId}:${photoId}`;

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  localStorage.clear();
  __resetPhotoViewedCacheForTests();
  useAuthStore.setState({ user: user('u1') });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAuthStore.setState({ user: null });
});

/** Событие storage, как его получает вкладка от записи в ДРУГОЙ вкладке. */
function fromOtherTab(k: string | null, newValue: string | null): void {
  if (k !== null) {
    if (newValue === null) localStorage.removeItem(k);
    else localStorage.setItem(k, newValue);
  }
  act(() => {
    window.dispatchEvent(
      new StorageEvent('storage', { key: k, newValue, storageArea: localStorage }),
    );
  });
}

describe('photoViewed', () => {
  it('отметка видна хуку и лежит под ключом пользователя и фото', () => {
    const { result } = renderHook(() => useViewedPhotos());
    expect(result.current).toEqual({});
    act(() => markPhotoViewed('p1', 1000));
    expect(result.current).toEqual({ p1: 1000 });
    expect(localStorage.getItem(key('u1', 'p1'))).toBe('1000');
  });

  it('две вкладки: чужая отметка и своя не затирают друг друга', () => {
    const { result } = renderHook(() => useViewedPhotos());
    act(() => markPhotoViewed('a', 1000));
    // Другая вкладка того же пользователя отметила своё фото.
    fromOtherTab(key('u1', 'b'), '2000');
    expect(result.current).toEqual({ a: 1000, b: 2000 });
    // Своя следующая отметка — и в хранилище все три, ничего не потерялось.
    act(() => markPhotoViewed('c', 3000));
    expect(result.current).toEqual({ a: 1000, b: 2000, c: 3000 });
    expect(localStorage.getItem(key('u1', 'a'))).toBe('1000');
    expect(localStorage.getItem(key('u1', 'b'))).toBe('2000');
    expect(localStorage.getItem(key('u1', 'c'))).toBe('3000');
  });

  it('событие другой вкладки про чужого пользователя и чужой ключ — мимо', () => {
    const { result } = renderHook(() => useViewedPhotos());
    fromOtherTab(key('u2', 'x'), '5');
    fromOtherTab('matcheck.docModal.layout', 'wide');
    expect(result.current).toEqual({});
  });

  it('удаление ключа в другой вкладке убирает отметку; clear() — пересборка', () => {
    const { result } = renderHook(() => useViewedPhotos());
    act(() => markPhotoViewed('a', 1000));
    act(() => markPhotoViewed('b', 2000));
    fromOtherTab(key('u1', 'a'), null);
    expect(result.current).toEqual({ b: 2000 });
    localStorage.clear();
    fromOtherTab(null, null);
    expect(result.current).toEqual({});
  });

  it('смена пользователя перерисовывает хук с его отметками', () => {
    localStorage.setItem(key('u2', 'z'), '7');
    const { result } = renderHook(() => useViewedPhotos());
    act(() => markPhotoViewed('a', 1000));
    expect(result.current).toEqual({ a: 1000 });
    act(() => useAuthStore.setState({ user: user('u2') }));
    expect(result.current).toEqual({ z: 7 });
    act(() => useAuthStore.setState({ user: null }));
    expect(result.current).toEqual({});
  });

  it('без входа отметка не пишется', () => {
    useAuthStore.setState({ user: null });
    markPhotoViewed('a', 1000);
    expect(localStorage.length).toBe(0);
  });

  it('битое значение пропускается, а не роняет чтение', () => {
    localStorage.setItem(key('u1', 'bad'), 'not-a-number');
    localStorage.setItem(key('u1', 'ok'), '42');
    const { result } = renderHook(() => useViewedPhotos());
    expect(result.current).toEqual({ ok: 42 });
  });

  it('сверх потолка забываются самые старые', () => {
    for (let i = 0; i < VIEWED_MAX; i++) localStorage.setItem(key('u1', `p${i}`), String(i + 1));
    const { result } = renderHook(() => useViewedPhotos());
    act(() => markPhotoViewed('newest', 1_000_000));
    const ids = Object.keys(result.current);
    expect(ids).toHaveLength(VIEWED_TRIM_TO);
    expect(result.current.newest).toBe(1_000_000);
    // Удалены первые (самые старые), в карте и в хранилище.
    expect(result.current.p0).toBeUndefined();
    expect(localStorage.getItem(key('u1', 'p0'))).toBeNull();
    const dropped = VIEWED_MAX + 1 - VIEWED_TRIM_TO;
    expect(result.current[`p${dropped - 1}`]).toBeUndefined();
    expect(result.current[`p${dropped}`]).toBe(dropped + 1);
  });

  describe('useMarkViewedAfterDwell', () => {
    it('отметка — только после секунды показа', () => {
      vi.useFakeTimers();
      renderHook(() => useMarkViewedAfterDwell('p1'));
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS - 1));
      expect(localStorage.getItem(key('u1', 'p1'))).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(localStorage.getItem(key('u1', 'p1'))).not.toBeNull();
    });

    it('смена фото раньше секунды — прежнее не отмечается', () => {
      vi.useFakeTimers();
      const { rerender } = renderHook(({ id }) => useMarkViewedAfterDwell(id), {
        initialProps: { id: 'p1' as string | null },
      });
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS - 100));
      rerender({ id: 'p2' });
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS - 100));
      expect(localStorage.getItem(key('u1', 'p1'))).toBeNull();
      expect(localStorage.getItem(key('u1', 'p2'))).toBeNull();
      rerender({ id: null });
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS * 5));
      expect(localStorage.length).toBe(0);
    });

    it('вкладка ушла в фон — отсчёт сброшен, вернулась — начат заново', () => {
      vi.useFakeTimers();
      renderHook(() => useMarkViewedAfterDwell('p1'));
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS - 100));
      visibility = 'hidden';
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS * 5));
      expect(localStorage.getItem(key('u1', 'p1'))).toBeNull();
      visibility = 'visible';
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS - 1));
      expect(localStorage.getItem(key('u1', 'p1'))).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(localStorage.getItem(key('u1', 'p1'))).not.toBeNull();
    });

    it('открыто в скрытой вкладке — не отмечается, пока её не покажут', () => {
      vi.useFakeTimers();
      visibility = 'hidden';
      renderHook(() => useMarkViewedAfterDwell('p1'));
      act(() => vi.advanceTimersByTime(VIEWED_DWELL_MS * 5));
      expect(localStorage.getItem(key('u1', 'p1'))).toBeNull();
    });
  });
});
