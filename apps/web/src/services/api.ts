import { useAuthStore } from '../stores/auth';

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

let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const j = (await r.json()) as { accessToken: string };
        return j.accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

async function request<T>(
  path: string,
  init: RequestInit & { retried?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  const token = useAuthStore.getState().accessToken;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    signal: init.signal,
  });

  if (res.status === 401 && !init.retried) {
    const newToken = await doRefresh();
    if (newToken) {
      useAuthStore.getState().setAccessToken(newToken);
      return request<T>(path, { ...init, retried: true });
    }
    useAuthStore.getState().expireSession();
    throw new ApiError(401, 'unauthorized', 'Session expired');
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
    throw new ApiError(res.status, code, msg, payload);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * Скачивание файла с авторизацией. Возвращает Blob + предложенное имя файла
 * (из Content-Disposition; пустая строка, если сервер не прислал). Используется
 * для xlsx-экспорта, CSV и других бинарных загрузок, где обычный api.get<T>
 * не подходит (тот ждёт JSON).
 */
export async function apiDownload(
  path: string,
): Promise<{ blob: Blob; filename: string }> {
  const headers = new Headers();
  const token = useAuthStore.getState().accessToken;
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let res = await fetch(`${BASE}${path}`, {
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    const newToken = await doRefresh();
    if (newToken) {
      useAuthStore.getState().setAccessToken(newToken);
      const retryHeaders = new Headers();
      retryHeaders.set('Authorization', `Bearer ${newToken}`);
      res = await fetch(`${BASE}${path}`, {
        headers: retryHeaders,
        credentials: 'include',
      });
    } else {
      useAuthStore.getState().expireSession();
      throw new ApiError(401, 'unauthorized', 'Session expired');
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
  return request<T>(path, { method: 'POST', body: fd, signal: opts.signal });
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
  return request<T>(path, { method: 'POST', body: fd, signal: opts.signal });
}
