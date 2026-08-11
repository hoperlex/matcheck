import * as Sentry from '@sentry/react';
import type {
  UploadDocumentsResponse,
  ImportResult,
  ExtraOnlyBundleListResponse,
} from '@matcheck/contracts';
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

// Подписчики на отказ по матрице прав (403 permission_denied). Регистрация —
// из permissionsScheduler.ts; здесь только вызов, чтобы api.ts не зависел ни
// от стора прав, ни от их загрузки.
type ForbiddenListener = (info: { path: string; code: string }) => void;
const forbiddenListeners = new Set<ForbiddenListener>();

export function onForbidden(listener: ForbiddenListener): () => void {
  forbiddenListeners.add(listener);
  return () => forbiddenListeners.delete(listener);
}

function notifyForbidden(info: { path: string; code: string }): void {
  for (const listener of forbiddenListeners) {
    try {
      listener(info);
    } catch {
      // Подписчик не должен ломать обработку ответа: исходную ошибку API
      // вызывающий обязан получить в любом случае.
    }
  }
}

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
    // Отказ по матрице прав: сообщаем подписчикам, чтобы они перезагрузили
    // права — раз сервер отказал, наша копия устарела прямо сейчас. Через
    // callback, а не прямым импортом: permissionsSync ходит голым fetch именно
    // для того, чтобы не замкнуть цикл api → permissionsSync → api.
    if (res.status === 403 && code === 'permission_denied') {
      notifyForbidden({ path, code });
    }
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

  const filename = parseContentDispositionFilename(
    res.headers.get('Content-Disposition') ?? '',
  );
  const blob = await res.blob();
  return { blob, filename };
}

/** Сохранить полученный Blob на диск под именем `filename`. */
export function saveBlobAsFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Имя файла из Content-Disposition. Пустая строка — сервер имени не прислал
 * (или прислал непригодное), тогда вызывающий подставляет своё.
 *
 * Форм две, и порядок важен: `filename*=UTF-8''%D0%A1.pdf` (RFC 5987) несёт
 * не-ASCII и приоритетнее, `filename="…"` — ASCII-совместимый запасной
 * вариант. Наивная регулярка по `filename` цепляла бы у первой формы хвост
 * `*=UTF-8''…` целиком: результат непустой, поэтому fallback вызывающего не
 * срабатывал и файл сохранялся с мусорным именем.
 */
export function parseContentDispositionFilename(cd: string): string {
  const ext = /filename\*=\s*[^']*'[^']*'([^;]+)/i.exec(cd);
  if (ext?.[1]) {
    try {
      // Битый процент-эскейп (%ZZ) — не повод падать: ниже есть обычная форма.
      return decodeURIComponent(ext[1].trim());
    } catch {
      /* пробуем filename= */
    }
  }
  const plain = /filename=\s*"([^"]*)"|filename=\s*([^;]+)/i.exec(cd);
  return (plain?.[1] ?? plain?.[2] ?? '').trim();
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
 * Загрузка фото операции через API-прокси: кадр и миниатюра одним POST на
 * /photos/{id}/content. Прямой PUT в S3 из браузера не проходит preflight —
 * у бакета нет CORS-правила для origin портала.
 *
 * Почему не подходят загрузчики выше: apiUploadFile умеет ровно один файл, а
 * apiUploadFiles кладёт все файлы под одно имя поля и знает только жёстко
 * заданное второе имя `extraFiles` (семантика загрузки УПД).
 *
 * timeoutMs конечный, а не null: retryPendingUploads держит Web Lock и ждёт
 * uploadPhoto последовательно, поэтому зависший запрос остановил бы весь цикл
 * ретраев. 120 с с запасом хватает на ~1,6 МБ даже на медленной мобильной сети,
 * а таймаут классифицируется как retriable и попадёт в обычный backoff.
 */
export async function apiUploadPhoto<T>(
  path: string,
  main: Blob,
  thumb?: Blob | null,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const fd = new FormData();
  fd.append('file', main, 'photo.jpg');
  if (thumb) fd.append('thumb', thumb, 'thumb.jpg');
  return request<T>(path, {
    method: 'POST',
    body: fd,
    signal: opts.signal,
    timeoutMs: 120_000,
  });
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
    /** Файлы зоны «Дополнительные документы»: сохранить, но не распознавать. */
    extraFiles?: File[];
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
  // Режим обработки едет ИМЕНЕМ части: текстовые поля сервер читает раньше
  // файлов, поэтому пофайловый признак отдельным полем не выразить.
  for (const f of opts.extraFiles ?? []) {
    fd.append('extraFiles', f, f.name);
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
  extraFiles?: File[],
): Promise<UploadDocumentsResponse> {
  return apiUploadFiles<UploadDocumentsResponse>('/source-documents/upload-documents', files, {
    fields,
    signal,
    extraFiles,
  });
}

// Скачивание дополнительного файла поставки из карточки документа. Не ссылка
// на S3, а поток через API: presigned URL отдал бы файл inline (браузер показал
// бы jpg/pdf вкладкой), а карточке нужно именно сохранение на диск.
export async function apiDownloadExtraFile(
  documentId: string,
  itemId: string,
): Promise<{ blob: Blob; filename: string }> {
  return apiDownload(`/source-documents/${documentId}/extra/${itemId}/raw`);
}

// То же для комплекта без распознанных документов: карточки у него нет.
export async function apiGetBundleExtraFileUrl(
  bundleId: string,
  itemId: string,
): Promise<{ url: string; filename: string; mimeType: string | null }> {
  return api.get(`/source-bundles/${bundleId}/extra/${itemId}/url`);
}

// Комплекты, из которых не появилось ни одного документа.
export async function apiGetExtraOnlyBundles(params: {
  limit?: number;
  offset?: number;
} = {}): Promise<ExtraOnlyBundleListResponse> {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.offset != null) qs.set('offset', String(params.offset));
  const suffix = qs.toString() ? `?${qs}` : '';
  return api.get<ExtraOnlyBundleListResponse>(`/source-bundles/extra-only${suffix}`);
}

// Журнал решений по пачке (что классификатор определил, что создано).
export async function apiGetImportResult(bundleId: string): Promise<ImportResult> {
  return api.get<ImportResult>(`/source-documents/import-result/${bundleId}`);
}
