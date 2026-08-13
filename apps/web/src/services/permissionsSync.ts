// Загрузка прав текущего пользователя (GET /api/v1/me/permissions).
//
// Голый fetch, а не services/api.ts — намеренно. api.ts на 403 будет дёргать
// ре-синк прав (права могли сузиться), и импорт в обратную сторону замкнул бы
// цикл api → permissionsSync → api. Тот же приём и по той же причине, что в
// authRefresh.ts.
//
// Здесь нет ни одного решения «что показать пользователю»: модуль отдаёт
// дискриминированный union, а записывает результат в стор вызывающий. Это
// нужно для главного инварианта фичи — отсутствие данных НЕ равно отсутствию
// прав (см. shared/utils/permissions.ts).

import type { MePermissionsResponse, UserDto } from '@matcheck/contracts';
import { useAuthStore } from '../stores/auth';
import { usePermissionsStore } from '../stores/permissions';
import { buildPermissionSet, type PermissionSet } from '../shared/utils/permissions';

const URL = '/api/v1/me/permissions';
const TIMEOUT_MS = 10_000;

export type PermissionsResult =
  | { ok: true; payload: MePermissionsResponse }
  // Причина различается только для логов: реакция на все неудачи одна —
  // остаться на дефолтах и повторить позже.
  | { ok: false; reason: 'unauthorized' | 'timeout' | 'network' | 'server' | 'invalid_response' };

let inFlight: Promise<PermissionsResult> | null = null;

async function doFetch(): Promise<PermissionsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const token = useAuthStore.getState().accessToken;
    const res = await fetch(URL, {
      credentials: 'include',
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (res.status === 401) return { ok: false, reason: 'unauthorized' };
    // 404 (старый API без этого маршрута) попадает сюда же: работаем по
    // дефолтам, как будто матрицы нет вовсе.
    if (!res.ok) return { ok: false, reason: 'server' };
    const payload = (await res.json()) as MePermissionsResponse;
    if (!payload?.userId || !payload.pages) return { ok: false, reason: 'invalid_response' };
    return { ok: true, payload };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return { ok: false, reason: aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Запросить права. Все вызовы, пришедшие пока запрос в полёте, получают один
 * промис: polling, focus-обновление и ре-синк после 403 иначе легко сходятся в
 * три одновременных запроса.
 */
export function fetchPermissions(): Promise<PermissionsResult> {
  if (!inFlight) {
    inFlight = doFetch().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/**
 * Решение «писать ли ответ в стор» — чистая функция, потому что ломается она
 * молча.
 *
 * Запрос мог стартовать под одним пользователем, а завершиться под другим
 * (разлогин + вход в соседней вкладке, восстановление сессии). Запись чужих
 * прав не упадёт и не залогируется — человек просто увидит не своё меню.
 * Поэтому сверяем ответ с тем, КОМУ он предназначался, и с тем, кто в сторе
 * сейчас.
 *
 * @param payload   ответ сервера
 * @param expected  пользователь, для которого запрос делался (null — не знаем)
 * @param current   пользователь в сторе на момент записи (null — вышли)
 */
export function permissionsToApply(
  payload: MePermissionsResponse,
  expected: Pick<UserDto, 'id'> | null,
  current: Pick<UserDto, 'id'> | null,
): PermissionSet | null {
  if (!current) return null;
  if (payload.userId !== current.id) return null;
  if (expected && payload.userId !== expected.id) return null;
  return buildPermissionSet(payload);
}

/**
 * Загрузить права и записать их в стор, если они всё ещё актуальны.
 *
 * `user` передаётся явно: во время восстановления сессии в сторе его ещё нет
 * (он появляется после ответа /auth/me), и сверка со стором молча отбросила бы
 * законный ответ.
 */
export async function syncPermissions(user?: Pick<UserDto, 'id'> | null): Promise<void> {
  const result = await fetchPermissions();
  if (!result.ok) return;
  const current = useAuthStore.getState().user;
  const perms = permissionsToApply(result.payload, user ?? null, current ?? null);
  if (!perms) return;
  usePermissionsStore.getState().set(current!.id, perms);
  await refreshUserIfAuthzChanged(result.payload, current ?? null);
}

/**
 * Роль или скоуп пользователя изменились на сервере — перечитать /auth/me.
 *
 * Права приезжают опросом, а роль, siteId и привязка к подрядчику живут в
 * auth-store и заполняются один раз при входе. Без этой сверки получалось
 * смешанное состояние: меню уже от новой роли, а ролевые ветки и скоуп — от
 * старой, до перезагрузки страницы.
 *
 * Сравнивать по одной роли недостаточно: смена объекта у инспектора роль не
 * меняет, а видимость меняет, — поэтому сервер отдаёт отпечаток целиком.
 * Старый API поля не присылает: тогда сверять нечего и поведение прежнее.
 *
 * Ошибку глотаем: не смогли перечитать — останемся на прежних данных до
 * следующего опроса, это не повод ронять синхронизацию прав.
 */
async function refreshUserIfAuthzChanged(
  payload: MePermissionsResponse,
  current: UserDto | null,
): Promise<void> {
  const revision = payload.authzRevision;
  if (!revision || !current) return;
  const known = [current.role, current.siteId ?? '-', current.contractorCustomerId ?? '-'].join(
    ':',
  );
  if (revision === known) return;

  try {
    const me = await fetchMe();
    // Пользователь мог смениться, пока запрос был в полёте.
    if (!me || useAuthStore.getState().user?.id !== me.id) return;
    useAuthStore.getState().setUser(me);
    // Скоуп изменился — данные на экране собраны под старую видимость.
    onAuthzChangedHandlers.forEach((fn) => fn());
  } catch {
    /* см. комментарий выше */
  }
}

/** Голый fetch по тем же причинам, что и у прав: api.ts замкнул бы цикл. */
async function fetchMe(): Promise<UserDto | null> {
  const token = useAuthStore.getState().accessToken;
  const res = await fetch('/api/v1/auth/me', {
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) return null;
  return (await res.json()) as UserDto;
}

const onAuthzChangedHandlers = new Set<() => void>();

/**
 * Подписка на смену роли или скоупа. Нужна, чтобы сбросить кеш запросов:
 * списки, справочники и счётчики собраны под прежнюю видимость и после смены
 * объекта показывали бы чужие данные до истечения их staleTime.
 */
export function onAuthzChanged(fn: () => void): () => void {
  onAuthzChangedHandlers.add(fn);
  return () => onAuthzChangedHandlers.delete(fn);
}
