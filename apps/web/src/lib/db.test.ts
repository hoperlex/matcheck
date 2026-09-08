/**
 * Соединение с локальной базой браузер может закрыть под нами: эвикт по
 * квоте, «очистить данные сайта», апгрейд из вкладки со старым бандлом.
 * Раньше вкладка об этом не узнавала — `dbPromise` кэшировал мёртвый хэндл до
 * конца своей жизни, и пользователь получал «Не удалось добавить фото: The
 * database connection is closing» на каждой попытке до перезагрузки страницы.
 *
 * Тесты стерегут восстановление целиком: сброс кэша во всех трёх точках
 * (blocking, отказ открытия, повтор операции) и границу повтора — то, что
 * повторяется ТОЛЬКО закрывающееся соединение.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from './db';

const DB_NAME = 'matcheck';

/** Свежий модуль на каждый тест: кэш соединения живёт в модульной переменной. */
async function loadDb(): Promise<typeof DbModule> {
  vi.resetModules();
  return await import('./db');
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onblocked = () => resolve(); // соединение закроется по versionchange
    req.onerror = () => reject(req.error);
  });
}

/** Ошибка ровно в той формулировке, которую даёт Chrome на закрытом соединении. */
function closingError(): Error {
  return Object.assign(
    new Error("Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing."),
    { name: 'InvalidStateError' },
  );
}

beforeEach(async () => {
  await deleteDb();
});

describe('isConnectionClosingError', () => {
  it('узнаёт закрывающееся соединение по формулировке браузера', async () => {
    const { isConnectionClosingError } = await loadDb();
    expect(isConnectionClosingError(closingError())).toBe(true);
  });

  it('не считает переполнение квоты поводом для повтора', async () => {
    // Повтор здесь бессмыслен: места не прибавится, а пользователь узнает об
    // ошибке позже, чем мог бы.
    const { isConnectionClosingError } = await loadDb();
    const quota = Object.assign(new Error('The quota has been exceeded.'), {
      name: 'QuotaExceededError',
    });
    expect(isConnectionClosingError(quota)).toBe(false);
  });

  it('не повторяет прочие InvalidStateError — обращение к удалённому объекту', async () => {
    const { isConnectionClosingError } = await loadDb();
    const other = Object.assign(new Error('A request was placed against a transaction'), {
      name: 'InvalidStateError',
    });
    expect(isConnectionClosingError(other)).toBe(false);
  });
});

describe('withDb', () => {
  it('повторяет операцию один раз и уже на новом соединении', async () => {
    const { db, withDb } = await loadDb();
    const before = await db();

    const seen: unknown[] = [];
    let calls = 0;
    const result = await withDb(async (dbi) => {
      calls += 1;
      seen.push(dbi);
      if (calls === 1) throw closingError();
      return 'готово';
    });

    expect(result).toBe('готово');
    expect(calls).toBe(2);
    expect(seen[0]).toBe(before);
    // Главное: повтор идёт с ДРУГИМ хэндлом. Повтор на том же соединении
    // упал бы снова — ровно это и происходило до правки.
    expect(seen[1]).not.toBe(before);
  });

  it('не повторяет переполнение квоты', async () => {
    const { withDb } = await loadDb();
    let calls = 0;
    const quota = Object.assign(new Error('The quota has been exceeded.'), {
      name: 'QuotaExceededError',
    });

    await expect(
      withDb(async () => {
        calls += 1;
        throw quota;
      }),
    ).rejects.toThrow('quota');
    expect(calls).toBe(1);
  });

  it('пробрасывает ошибку, если и повтор не удался', async () => {
    const { withDb } = await loadDb();
    let calls = 0;
    await expect(
      withDb(async () => {
        calls += 1;
        throw closingError();
      }),
    ).rejects.toThrow('connection is closing');
    expect(calls).toBe(2);
  });
});

describe('жизненный цикл соединения', () => {
  it('по versionchange закрывает своё соединение и забывает его', async () => {
    const { db } = await loadDb();
    const first = await db();
    await first.put('settings', { key: 'k', value: 1 });

    // «Другая вкладка» удаляет базу: открытое соединение получает
    // versionchange, и idb зовёт наш blocking.
    await deleteDb();
    await new Promise((r) => setTimeout(r, 0));

    const second = await db();
    expect(second).not.toBe(first);
    // Новое соединение рабочее — а старое закрыто нами же в blocking.
    await second.put('settings', { key: 'k2', value: 2 });
    expect(await second.get('settings', 'k2')).toEqual({ key: 'k2', value: 2 });
    await expect(first.get('settings', 'k2')).rejects.toThrow();
  });

  it('не кэширует отказ открытия навсегда', async () => {
    // Вкладка со старым бандлом подняла версию выше нашей: openDB отклоняется
    // VersionError. Без сброса кэша вкладка до перезагрузки отдавала бы одну и
    // ту же отклонённую попытку, даже когда мешавшее соединение уже закрылось.
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 99);
      req.onupgradeneeded = () => undefined;
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const { db } = await loadDb();
    await expect(db()).rejects.toThrow();

    newer.close();
    await deleteDb();

    const conn = await db();
    expect(conn.version).toBe(4);
  });
});
