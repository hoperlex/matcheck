// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../../stores/auth';
import { __resetPhotoViewedCacheForTests, markPhotoViewed } from '../../lib/photoViewed';
import { PhotoViewedCounter } from './PhotoViewedCounter';

const at = '2026-11-18T10:00:00.000Z';
const photos = [
  { id: 'a', uploadedAt: at },
  { id: 'b', uploadedAt: at },
  { id: 'c', uploadedAt: at },
  // Ещё загружается — в счёт не идёт ни в числитель, ни в знаменатель.
  { id: 'local', uploadedAt: null },
];

beforeEach(() => {
  localStorage.clear();
  __resetPhotoViewedCacheForTests();
  useAuthStore.setState({ user: { id: 'u1' } as unknown as UserDto });
});

afterEach(() => {
  cleanup();
  useAuthStore.setState({ user: null });
});

describe('PhotoViewedCounter', () => {
  it('ни одно не открывали — ничего; часть — «N из M»; все — «все просмотрены»', () => {
    markPhotoViewed('local', 1);
    const { container } = render(<PhotoViewedCounter photos={photos} />);
    expect(container.textContent).toBe('');

    act(() => markPhotoViewed('a', 1));
    act(() => markPhotoViewed('b', 2));
    expect(container.textContent).toBe('· просмотрено 2 из 3');

    act(() => markPhotoViewed('c', 3));
    expect(container.textContent).toContain('все просмотрены');
  });
});
