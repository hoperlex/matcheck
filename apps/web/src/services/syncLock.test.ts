import { describe, it, expect, vi, afterEach } from 'vitest';
import { runExclusive, tryRunExclusive } from './syncLock';

/**
 * Лок сериализует два независимых пути записи комментария: узкий PATCH и
 * offline-upsert из очереди мутаций. Ключевое свойство — лок держится на ВСЮ
 * переданную цепочку (HTTP + reconciliation IndexedDB + обновление кеша), а не
 * до первого await: иначе фоновый sync вклинится между ответом сервера и
 * записью в IDB и затрёт правку.
 *
 * В node-окружении navigator.locks нет, поэтому по умолчанию проверяется
 * fallback-путь; ветка Web Locks покрыта отдельно через подмену navigator.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runExclusive — ждущий режим', () => {
  it('второй вызов не начинается, пока не завершился первый', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const first = runExclusive(async () => {
      events.push('first:start');
      await firstDone;
      events.push('first:end');
    });
    const second = runExclusive(async () => {
      events.push('second:start');
    });

    await tick();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('держит лок до конца всей цепочки, а не до первого await', async () => {
    const events: string[] = [];

    const first = runExclusive(async () => {
      events.push('patch');
      await tick(); // «ответ сервера»
      await tick(); // «reconcile IDB»
      events.push('reconcile');
    });
    const second = runExclusive(async () => {
      events.push('sync');
    });

    await Promise.all([first, second]);
    // sync не должен попасть между patch и reconcile
    expect(events).toEqual(['patch', 'reconcile', 'sync']);
  });

  it('возвращает результат fn', async () => {
    await expect(runExclusive(async () => 42)).resolves.toBe(42);
  });

  it('исключение освобождает лок — следующий вызов проходит', async () => {
    await expect(
      runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(runExclusive(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('tryRunExclusive — пропуск при занятом локе', () => {
  it('пропускает fn, если лок занят, и не ждёт освобождения', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = runExclusive(async () => {
      await held;
    });
    await tick();

    const fn = vi.fn(async () => {});
    await expect(tryRunExclusive(fn)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();

    release();
    await holder;
  });

  it('выполняет fn на свободном локе', async () => {
    const fn = vi.fn(async () => {});
    await expect(tryRunExclusive(fn)).resolves.toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('ветка Web Locks (межвкладочная)', () => {
  it('использует navigator.locks, когда он доступен', async () => {
    const request = vi.fn(
      async (
        _name: string,
        optionsOrCb: unknown,
        maybeCb?: (lock: unknown) => Promise<unknown>,
      ) => {
        const cb = (maybeCb ?? optionsOrCb) as (lock: unknown) => Promise<unknown>;
        return cb({ name: 'matcheck-sync', mode: 'exclusive' });
      },
    );
    vi.stubGlobal('navigator', { locks: { request } });

    await expect(runExclusive(async () => 'via-web-locks')).resolves.toBe('via-web-locks');
    expect(request).toHaveBeenCalledWith('matcheck-sync', expect.any(Function));
  });

  it('tryRunExclusive запрашивает лок с ifAvailable и уважает отказ', async () => {
    const request = vi.fn(
      async (
        _name: string,
        _options: { ifAvailable?: boolean },
        cb: (lock: unknown) => Promise<unknown>,
      ) => cb(null), // лок занят другой вкладкой
    );
    vi.stubGlobal('navigator', { locks: { request } });

    const fn = vi.fn(async () => {});
    await expect(tryRunExclusive(fn)).resolves.toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      'matcheck-sync',
      { ifAvailable: true },
      expect.any(Function),
    );
  });
});
