import { useEffect, useSyncExternalStore } from 'react';
import { useAuthStore } from '../stores/auth';

/**
 * Отметка «фото просмотрено» — подсказка менеджеру, какие кадры приёмки он уже
 * открывал. Живёт в localStorage этого браузера, у каждого пользователя своя;
 * на сервер не уходит.
 *
 * Ключ — на КАЖДОЕ фото: `matcheck.photoViewed.v1:<userId>:<photoId>` → время
 * в мс. Одна общая карта под одним ключом теряла бы отметки: две вкладки
 * читают карту, каждая добавляет своё фото и пишет карту целиком — победит
 * последняя, а блокировки между вкладками у localStorage нет. С ключом на
 * фото каждая запись трогает только своё.
 *
 * Снимок для React (useSyncExternalStore) — карта photoId → время. Собирается
 * один раз проходом по ключам пользователя, дальше правится по месту: своя
 * запись — сразу, чужая вкладка — по событию `storage`. Смена пользователя
 * приходит подпиской на useAuthStore: проверка внутри getSnapshot сама
 * перерисовку не вызвала бы.
 */

const PREFIX = 'matcheck.photoViewed.v1:';
/** Потолок записей на пользователя (~0,5 МБ): старее — забываются. */
export const VIEWED_MAX = 3000;
export const VIEWED_TRIM_TO = 2700;
/** Сколько кадр должен простоять на экране, чтобы считаться просмотренным. */
export const VIEWED_DWELL_MS = 1000;

export type ViewedMap = Readonly<Record<string, number>>;
const EMPTY: ViewedMap = Object.freeze({});

let cache: { userId: string; map: ViewedMap } | null = null;
const listeners = new Set<() => void>();
let detachExternal: (() => void) | null = null;

function currentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

function userPrefix(userId: string): string {
  return `${PREFIX}${userId}:`;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Доступ к хранилищу запрещён настройками браузера.
    return null;
  }
}

function parseTs(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readAll(userId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const ls = storage();
  if (!ls) return out;
  const prefix = userPrefix(userId);
  try {
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const ts = parseTs(ls.getItem(key));
      if (ts !== null) out[key.slice(prefix.length)] = ts;
    }
  } catch {
    // Хранилище недоступно посреди чтения — что успели, то и есть.
  }
  return out;
}

function emit(): void {
  for (const l of [...listeners]) l();
}

function getSnapshot(): ViewedMap {
  const userId = currentUserId();
  if (!userId) return EMPTY;
  if (!cache || cache.userId !== userId) cache = { userId, map: readAll(userId) };
  return cache.map;
}

function getServerSnapshot(): ViewedMap {
  return EMPTY;
}

function onStorage(e: StorageEvent): void {
  const ls = storage();
  if (e.storageArea && ls && e.storageArea !== ls) return;
  // key === null — хранилище очистили целиком (clear()).
  if (e.key === null) {
    cache = null;
    emit();
    return;
  }
  if (!e.key.startsWith(PREFIX)) return;
  const userId = currentUserId();
  if (!userId || !cache || cache.userId !== userId) {
    cache = null;
    emit();
    return;
  }
  const prefix = userPrefix(userId);
  if (!e.key.startsWith(prefix)) return;
  const photoId = e.key.slice(prefix.length);
  const ts = parseTs(e.newValue);
  const next: Record<string, number> = { ...cache.map };
  if (ts === null) delete next[photoId];
  else next[photoId] = ts;
  cache = { userId, map: next };
  emit();
}

function attachExternal(): () => void {
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  const unsubAuth = useAuthStore.subscribe((state, prev) => {
    if ((state.user?.id ?? null) !== (prev.user?.id ?? null)) {
      cache = null;
      emit();
    }
  });
  return () => {
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    unsubAuth();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!detachExternal) detachExternal = attachExternal();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detachExternal) {
      detachExternal();
      detachExternal = null;
    }
  };
}

/**
 * Отметить фото просмотренным (время — последнего просмотра). Без входа в
 * систему и без доступа к хранилищу — молча ничего: отметка лишь подсказка.
 */
export function markPhotoViewed(photoId: string, at: number = Date.now()): void {
  const userId = currentUserId();
  const ls = storage();
  if (!userId || !ls || !photoId) return;
  try {
    ls.setItem(userPrefix(userId) + photoId, String(at));
  } catch {
    // Квота: отметка не записалась — интерфейс просто её не покажет.
    return;
  }
  const next: Record<string, number> = { ...getSnapshot(), [photoId]: at };
  cache = { userId, map: trim(userId, next, ls) };
  emit();
}

/** Сверх потолка — удаляем самые старые отметки до VIEWED_TRIM_TO. */
function trim(userId: string, map: Record<string, number>, ls: Storage): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= VIEWED_MAX) return map;
  entries.sort((a, b) => a[1] - b[1]);
  const prefix = userPrefix(userId);
  for (const [photoId] of entries.slice(0, entries.length - VIEWED_TRIM_TO)) {
    try {
      // Другая вкладка могла удалить тот же ключ — повтор безвреден.
      ls.removeItem(prefix + photoId);
    } catch {
      // ignore
    }
    delete map[photoId];
  }
  return map;
}

/** Карта photoId → время просмотра текущего пользователя. */
export function useViewedPhotos(): ViewedMap {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Отметить фото, если оно простояло на экране VIEWED_DWELL_MS при видимой
 * вкладке. id = null — смотреть нечего (окно закрыто, оригинал ещё не
 * нарисован). Смена id или уход вкладки в фон отсчёт сбрасывают: пролистанный
 * мимо кадр и случайно открытое и сразу закрытое фото отметку не получают.
 */
export function useMarkViewedAfterDwell(photoId: string | null): void {
  useEffect(() => {
    if (!photoId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const start = () => {
      stop();
      if (document.visibilityState !== 'visible') return;
      timer = setTimeout(() => {
        timer = undefined;
        markPhotoViewed(photoId);
      }, VIEWED_DWELL_MS);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [photoId]);
}

/** Только для тестов: забыть кэш, будто модуль загружен заново. */
export function __resetPhotoViewedCacheForTests(): void {
  cache = null;
}
