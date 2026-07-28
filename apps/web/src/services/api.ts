import * as Sentry from '@sentry/react';
import type { UploadDocumentsResponse, ImportResult } from '@matcheck/contracts';
import { useAuthStore } from '../stores/auth';
import { refreshAccessToken } from './authRefresh';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
  }
}

export class ConflictError extends ApiError {
  constructor(
    public serverVersion: number,
    public server: unknown,
  ) {
    super(409, 'conflict', 'Concurrent update detected');
  }
}

const BASE = '/api/v1';

// Таймаут по умолчанию для JSON-запросов. Раньше запросы висели бесконечно:
// если fetch не завершался (зависший прокси/NAT, исчерпание пула HTTP/1.1),
// UI показывал вечный спиннер. null отключает таймаут для длинных операций
// (upload, sync, распознавание) — им бюджет задают явно.
const DEFAULT_TIMEOUT_MS = 20_000;

// Сообщение для транзиентных сбоев refresh — НЕ «Session expired» (сессия жива).
function transientRefreshMessage(reason: string): string {
  switch (reason) {
    case 'timeout':
      return 'Превышено время ожидания. Повторите попытку.';
    case 'rate_limit':
      return 'Слишком много запросов. Повторите чуть позже.';
    case 'server':
      return 'Сервер временно недоступен. Повторите попытку.';
    default:
      return 'Нет соединения с сервером. Повторите попытку.';
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { retried?: boolean; timeoutMs?: number | null } = {},
): Promise<T> {
  const { retried, timeoutMs, signal: externalSignal, ...fetchInit } = init;
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const token = useAuthStore.getState().accessToken;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  // Таймаут запроса: собственный AbortController, объединённый с внешним signal
  // (если вызывающий передал свой для отмены). budget=null → без таймаута
  // (upload/sync/распознавание). timedOut отличает наш таймаут от внешней отмены.
  const budget = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const timer =
    budget != null
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, budget)
      : null;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  };

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...fetchInit,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    // Наш таймаут — отдельный код 'timeout' (retry-предикаты его не ретраят и
    // отличают от 4xx/5xx). Внешняя отмена (AbortError) пробрасывается как есть.
    if (timedOut) throw new ApiError(0, 'timeout', 'Превышено время ожидания запроса');
    throw err;
  }
  cleanup();

  const canRefresh =
    !retried &&
    res.status === 401 &&
    path !== '/auth/login' &&
    path !== '/auth/register' &&
    path !== '/auth/refresh';

  if (canRefresh) {
    const r = await refreshAccessToken();
    if (r.ok) {
      useAuthStore.getState().setAccessToken(r.accessToken);
      return request<T>(path, { ...init, retried: true });
    }
    // Разлогиниваем ТОЛЬКО если сервер явно сказал «сессия мертва» (401 от
    // /auth/refresh). Транзиент (timeout/сеть/429/5xx) сессию не убивает и НЕ
    // выдаёт ложное «Session expired» — пробрасываем ошибку по причине,
    // следующий sync/refetch повторит, когда refresh снова пройдёт.
    if (r.sessionDead) {
      useAuthStore.getState().expireSession();
      throw new ApiError(401, 'unauthorized', 'Session expired');
    }
    throw new ApiError(
      0,
      r.reason === 'timeout' ? 'timeout' : r.reason,
      transientRefreshMessage(r.reason),
    );
  }

  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      serverVersion?: number;
      server?: unknown;
    };
    // Старый формат оптимистичного конкурентного апдейта (shipments/deliveries):
    // { error: 'conflict', serverVersion, server }. Все остальные 409 (например
    // duplicate_upd или has_references) пробрасываем как обычный ApiError —
    // вызывающий код сам разберёт payload.
    if (body.error === 'conflict' || body.serverVersion != null) {
      throw new ConflictError(body.serverVersion ?? 0, body.server);
    }
    throw new ApiError(409, body.error ?? 'conflict', body.message ?? 'Conflict', body);
  }

  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      /* ignore */
    }
    const msg =
      (payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : null) ?? `HTTP ${res.status}`;
    const code =
      (payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : null) ?? 'http_error';
    const err = new ApiError(res.status, code, msg, payload);
    // Репортим только серверные ошибки (5xx) — ожидаемые 4xx (401/403/валидация)
    // и 409 (обработаны выше) не шлём, чтобы не зашумлять. path без share-токена.
    if (res.status >= 500) {
      Sentry.captureException(err, {
        tags: { area: 'api' },
        extra: { path, status: res.status, code },
      });
    }
    throw err;
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// opts.timeoutMs: number — свой бюджет; null — без таймаута (длинные операции);
// omit — дефолт 20с. Нужен для распознавания (600с), sync почты/ЭДО, теста
// LLM-провайдера — иначе дефолт оборвал бы штатную длинную операцию.
type ReqOpts = { timeoutMs?: number | null };
export const api = {
  get: <T>(path: string, opts?: ReqOpts) => request<T>(path, { timeoutMs: opts?.timeoutMs }),
  post: <T>(path: string, body?: unknown, opts?: ReqOpts) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: opts?.timeoutMs,
    }),
  put: <T>(path: string, body?: unknown, opts?: ReqOpts) =>
    request<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: opts?.timeoutMs,
    }),
  patch: <T>(path: string, body?: unknown, opts?: ReqOpts) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      timeoutMs: opts?.timeoutMs,
    }),
  delete: <T>(path: string, opts?: ReqOpts) =>
    request<T>(path, { method: 'DELETE', timeoutMs: opts?.timeoutMs }),
};

/**
 * Скачивание файла с авторизацией. Возвращает Blob + предложенное имя файла
 * (из Content-Disposition; пустая строка, если сервер не прислал). Используется
 * для xlsx-экспорта, CSV и других бинарных загрузок, где обычный api.get<T>
 * не подходит (тот ждёт JSON).
 */
export async function apiDownload(path: string): Promise<{ blob: Blob; filename: string }> {
  const headers = new Headers();
  const token = useAuthStore.getState().accessToken;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    const r = await refreshAccessToken();
    if (r.ok) {
      useAuthStore.getState().setAccessToken(r.accessToken);
      const retryHeaders = new Headers();
      retryHeaders.set('Authorization', `Bearer ${r.accessToken}`);
      res = await fetch(`${BASE}${path}`, {
        headers: retryHeaders,
        credentials: 'include',
      });
    } else if (r.sessionDead) {
      useAuthStore.getState().expireSession();
      throw new ApiError(401, 'unauthorized', 'Session expired');
    } else {
      // Транзиент — сессия жива, не выдаём ложное «Session expired».
      throw new ApiError(
        0,
        r.reason === 'timeout' ? 'timeout' : r.reason,
        transientRefreshMessage(r.reason),
      );
    }
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { message?: string };
      if (payload?.message) msg = payload.message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, 'http_error', msg);
  }

  // Content-Disposition: attachment; filename="documents-inbound-2026-06-02.xlsx"
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  const filename = m?.[1] ?? '';
  const blob = await res.blob();
  return { blob, filename };
}

export async function apiUploadFile<T>(
  path: string,
  file: File,
  opts: {
    fieldName?: string;
    signal?: AbortSignal;
    fields?: Record<string, string>;
  } = {},
): Promise<T> {
  const fd = new FormData();
  // Поля формы — ДО файла: @fastify/multipart их корректно читает только
  // если они идут впереди файла в потоке.
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    fd.append(k, v);
  }
  fd.append(opts.fieldName ?? 'file', file, file.name);
  // timeoutMs:null — файлы до 10 МБ на медленной сети грузятся дольше 20с;
  // дефолтный таймаут оборвал бы штатную загрузку. Отмена — через opts.signal.
  return request<T>(path, { method: 'POST', body: fd, signal: opts.signal, timeoutMs: null });
}

/**
 * Загрузка пакета файлов одним POST — используется для Транспортной
 * накладной, где юзер прикладывает несколько фото листов (лицевая +
 * оборотная + сопроводительные). Сервер кладёт каждый файл как
 * attachment к одной записи source_documents и обрабатывает их вместе.
 */
export async function apiUploadFiles<T>(
  path: string,
  files: File[],
  opts: {
    fieldName?: string;
    signal?: AbortSignal;
    fields?: Record<string, string>;
  } = {},
): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? {})) {
    fd.append(k, v);
  }
  // Все файлы под одним именем поля — @fastify/multipart выдаёт их через
  // .files() итератор, порядок сохраняется.
  for (const f of files) {
    fd.append(opts.fieldName ?? 'files', f, f.name);
  }
  // timeoutMs:null — пакет файлов может грузиться дольше дефолта; отмена через signal.
  return request<T>(path, { method: 'POST', body: fd, signal: opts.signal, timeoutMs: null });
}

// ──────────── Единый вход «Загрузить документы» (router) ────────────

// Загрузка пачки любых документов одним POST → bundleId. Сервер сам
// классифицирует и роутит каждый файл; результат тянется по bundleId.
export async function apiUploadDocuments(
  files: File[],
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<UploadDocumentsResponse> {
  return apiUploadFiles<UploadDocumentsResponse>('/source-documents/upload-documents', files, {
    fields,
    signal,
  });
}

// Журнал решений по пачке (что классификатор определил, что создано).
export async function apiGetImportResult(bundleId: string): Promise<ImportResult> {
  return api.get<ImportResult>(`/source-documents/import-result/${bundleId}`);
}
