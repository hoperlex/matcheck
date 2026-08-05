import type {
  PublicSiteListResponse,
  PublicUploadResponse,
  PublicUploadStatus,
} from '@matcheck/contracts';

// HTTP-клиент публичной страницы /uploads.
//
// Отдельно от services/api.ts намеренно. Тот вешает Authorization, ходит с
// cookie и на 401 запускает refresh-retry — на странице без авторизации это в
// лучшем случае лишние запросы, а в худшем выкинет из системы менеджера,
// который открыл ссылку в той же вкладке, где залогинен.
//
// Публичные страницы импортируют ТОЛЬКО этот модуль — границу видно по
// импортам, без чтения кода.

const BASE = '/api/v1/public';

export class PublicApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PublicApiError';
  }
}

/**
 * Разбор ответа с учётом того, что до API можно и не доехать.
 *
 * nginx режет слишком большое тело сам и отвечает HTML-страницей 413, а при
 * перезапуске контейнера отдаёт HTML-502. Слепой res.json() дал бы
 * «Unexpected token <» вместо объяснимой ошибки.
 */
async function parse<T>(res: Response): Promise<T> {
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('application/json')) {
    if (res.status === 413) {
      throw new PublicApiError(
        413,
        'payload_too_large',
        'Слишком большой объём файлов. Отправьте их в два приёма.',
      );
    }
    throw new PublicApiError(
      res.status,
      'network',
      'Сервис временно недоступен. Попробуйте ещё раз через минуту.',
    );
  }
  const body = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new PublicApiError(
      res.status,
      body.error ?? 'error',
      body.message ?? `Ошибка ${res.status}`,
    );
  }
  return body;
}

function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    // Ни заголовка Authorization, ни cookie: страница анонимная.
    credentials: 'omit',
  });
}

export async function publicGetSites(): Promise<PublicSiteListResponse> {
  return parse<PublicSiteListResponse>(await publicFetch('/sites'));
}

export async function publicUploadDocuments(
  files: File[],
  fields: {
    siteId: string;
    expectedDate: string;
    /** Свободный комментарий к поставке; пустая строка = без комментария. */
    comment: string;
    /** Honeypot: всегда пустая строка у человека. */
    website: string;
  },
): Promise<PublicUploadResponse> {
  const form = new FormData();
  // Текстовые поля идут ДО файлов: сервер читает поток по частям и
  // разбирает форму по мере поступления.
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append('files', f, f.name);
  return parse<PublicUploadResponse>(await publicFetch('/upload-documents', {
    method: 'POST',
    body: form,
  }));
}

export async function publicGetUploadStatus(ticket: string): Promise<PublicUploadStatus> {
  return parse<PublicUploadStatus>(
    await publicFetch(`/upload-documents/${encodeURIComponent(ticket)}`),
  );
}
