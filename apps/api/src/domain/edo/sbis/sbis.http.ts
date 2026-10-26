/**
 * Единственная точка выхода в API СБИС (Saby).
 *
 * Как и у Диадока, интеграция только читает: ни одного документа от имени
 * организации отсюда уйти не должно. Обещание держится механизмом, а не
 * дисциплиной: запрос обязан совпасть с разрешающим списком по сочетанию
 * метода, хоста и пути, а вызов JSON-RPC — ещё и по имени метода СБИС. У СБИС
 * все методы идут на один адрес `/service/?srv=1`, поэтому списка адресов мало:
 * `СБИС.ЗаписатьДокумент` пришёл бы туда же, что и чтение.
 *
 * Модуль не читает окружение: все параметры передаются явно. Так его можно
 * запускать из скрипта пробы без конфигурации портала.
 *
 * Справка: https://saby.ru/help/integration/api/auth/service/,
 * https://saby.ru/help/integration/api/error_code (1AA — повторить, 1FA и
 * любой другой код — фатально).
 */
import { describeNetworkFailure } from '../diadoc.http.js';

export const SBIS_API_HOST = 'online.sbis.ru';

export const SBIS_URLS = {
  /** Вход по ключам приложения: JSON, не JSON-RPC. */
  oauth: `https://${SBIS_API_HOST}/oauth/service/`,
  /** Вход логином и паролем: JSON-RPC `СБИС.Аутентифицировать`. */
  auth: `https://${SBIS_API_HOST}/auth/service/`,
  /** Все методы API. */
  service: `https://${SBIS_API_HOST}/service/?srv=1`,
} as const;

/** Хосты, с которых СБИС отдаёт файлы по ссылкам из ответов. */
export const SBIS_FILE_HOSTS: ReadonlySet<string> = new Set([
  'disk.sbis.ru',
  'disk.saby.ru',
  'cdn-disk.sbis.ru',
  'cdn-disk.saby.ru',
]);

/** POST-адреса: путь и строка запроса сравниваются целиком. */
const ALLOWED_POST: readonly { path: string; search: string }[] = [
  { path: '/oauth/service/', search: '' },
  { path: '/auth/service/', search: '' },
  { path: '/service/', search: '?srv=1' },
];

/**
 * Методы JSON-RPC по адресам. Только чтение: список организаций, лента
 * изменений, чтение документа. Всё, что пишет, отправляет или подписывает,
 * сюда не входит и до сети не дойдёт.
 */
const ALLOWED_RPC: Readonly<Record<string, ReadonlySet<string>>> = {
  '/service/': new Set([
    'СБИС.СписокНашихОрганизаций',
    'СБИС.СписокИзменений',
    'СБИС.ПрочитатьДокумент',
  ]),
  '/auth/service/': new Set(['СБИС.Аутентифицировать']),
};

export function isAllowedSbisRequest(method: string, url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (method === 'POST') {
    return (
      url.hostname === SBIS_API_HOST &&
      ALLOWED_POST.some((r) => r.path === url.pathname && r.search === url.search)
    );
  }
  if (method === 'GET') return SBIS_FILE_HOSTS.has(url.hostname);
  return false;
}

export function isAllowedSbisRpc(url: URL, rpcMethod: string): boolean {
  return ALLOWED_RPC[url.pathname]?.has(rpcMethod) ?? false;
}

/** Запрос не прошёл разрешающий список. Дефект кода или чужой хост ссылки, не сбой сети. */
export class SbisRequestNotAllowed extends Error {
  constructor(readonly what: string) {
    super(`СБИС: ${what} не разрешён (только чтение)`);
    this.name = 'SbisRequestNotAllowed';
  }
}

/** Сеть, 5xx без ответа JSON-RPC, нефатальная ошибка 1AA. Повтор уместен. */
export class SbisTransient extends Error {
  constructor(
    readonly detail: string,
    readonly endpoint: string | null = null,
    opts: { cause?: unknown } = {},
  ) {
    super(`СБИС: временный сбой — ${detail}${endpoint ? ` (${endpoint})` : ''}`, opts);
    this.name = 'SbisTransient';
  }
}

/** Вход не удался: ключи или пароль отклонены. Текст СБИС — после маски. */
export class SbisAuthRejected extends Error {
  constructor(readonly detail: string) {
    super(`СБИС: вход отклонён — ${detail}`);
    this.name = 'SbisAuthRejected';
  }
}

/** 401: токен или сессия не приняты. */
export class SbisAuthExpired extends Error {
  constructor(readonly detail: string | null = null) {
    super(`СБИС: авторизация не принята (HTTP 401)${detail ? ` — ${detail}` : ''}`);
    this.name = 'SbisAuthExpired';
  }
}

/**
 * 403. На файле это может быть и просроченная ссылка, и отказ в доступе, и не тот
 * заголовок — по одному коду их не различить, поэтому вывод делает вызывающий.
 */
export class SbisAccessDenied extends Error {
  constructor(readonly endpoint: string) {
    super(`СБИС: доступ запрещён (HTTP 403, ${endpoint})`);
    this.name = 'SbisAccessDenied';
  }
}

/** 404/410: ресурса нет. */
export class SbisGone extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`СБИС: ресурс недоступен (HTTP ${status}, ${endpoint})`);
    this.name = 'SbisGone';
  }
}

/** Ошибка JSON-RPC, повтором не лечится (1FA или код без класса). */
export class SbisRpcError extends Error {
  constructor(
    readonly rpcMethod: string,
    readonly code: string | null,
    readonly classCode: string | null,
    readonly detail: string,
  ) {
    super(`СБИС: ${rpcMethod} — ${detail}${classCode ? ` [${classCode}]` : ''}`);
    this.name = 'SbisRpcError';
  }
}

/**
 * Запрос отменён вызывающим (остановка воркера). Не повторяется: проход
 * закрывается как `stopped`, лиз отпускается, курсор остаётся на прежней странице.
 */
export class SbisAborted extends Error {
  constructor() {
    super('СБИС: запрос отменён — процесс останавливается');
    this.name = 'SbisAborted';
  }
}

/** Прочий отказ HTTP: дефект запроса. */
export class SbisHttpError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
  ) {
    super(`СБИС: запрос отклонён (HTTP ${status}, ${endpoint})`);
    this.name = 'SbisHttpError';
  }
}

/** Тело больше лимита. Бросается до того, как оно прочитано целиком. */
export class SbisPayloadTooLarge extends Error {
  constructor(readonly limitBytes: number) {
    super(`СБИС: размер ответа превысил ${limitBytes} байт`);
    this.name = 'SbisPayloadTooLarge';
  }
}

/** Адрес для сообщений: хост и путь, без строки запроса — в ней у ссылок на файлы подпись. */
export function sbisEndpointOf(url: URL): string {
  return `${url.hostname}${url.pathname}`;
}

/**
 * Вырезает значения секретов из текста. Ответ СБИС на неверные ключи повторяет
 * ID приложения, а текст ошибки уходит в отчёт и в консоль.
 */
export function redact(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  const values = secrets
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join('***');
  return out;
}

function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
/** Справка: нефатальную ошибку повторять не раньше чем через 5 с. */
const NON_FATAL_DELAY_MS = 5_000;
/** Ответ JSON-RPC: список изменений на 50 документов укладывается с большим запасом. */
export const DEFAULT_RPC_MAX_BYTES = 20 * 1024 * 1024;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  return Math.round(500 * Math.pow(3, attempt) * (0.85 + Math.random() * 0.3));
}

export type SbisTransportOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Что повторять. Вход повторяется только при сетевом сбое: у СБИС лимит 300
   * входов в минуту с адреса, и повторы на отказах приближали бы блокировку.
   */
  retryOn?: 'network' | 'network_and_server';
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
  /** Значения, которые нельзя показать в тексте ошибок. */
  secrets?: readonly (string | null | undefined)[];
  /** Отмена извне (остановка воркера): складывается с таймаутом запроса, повторов нет. */
  signal?: AbortSignal;
};

export type SbisFetchOptions = SbisTransportOptions & {
  method: 'GET' | 'POST';
  url: URL;
  headers?: Record<string, string>;
  body?: string;
};

/** Одна отправка: разрешающий список, таймаут, отказ от редиректов. */
async function sendOnce(opts: SbisFetchOptions): Promise<Response> {
  if (opts.signal?.aborted) throw new SbisAborted();
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      redirect: 'manual',
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw new SbisAborted();
    throw err;
  }
  // Редирект увёл бы запрос мимо разрешающего списка: хост проверен только у
  // исходного адреса.
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new SbisRequestNotAllowed(`редирект с ${sbisEndpointOf(opts.url)}`);
  }
  return res;
}

/** Достаёт строку ошибки из ответа шлюза или сервиса входа: `{"error": "…"}`. */
async function readGatewayError(res: Response, secrets: SbisTransportOptions['secrets']): Promise<string | null> {
  try {
    const text = (await readSbisBody(res, 64 * 1024)).toString('utf8');
    let message: unknown = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      message = parsed?.error ?? text;
    } catch {
      // Не JSON — показываем текст как есть, после маски.
    }
    if (typeof message !== 'string') message = JSON.stringify(message);
    const out = clip(redact(message as string, secrets ?? []));
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Запрос с повторами там, где они уместны. Для GET файлов и входа по ключу;
 * JSON-RPC идёт через `sbisRpc`, у которого ошибка лежит в теле.
 */
export async function sbisFetch(opts: SbisFetchOptions): Promise<Response> {
  const { method, url } = opts;
  if (!isAllowedSbisRequest(method, url)) {
    throw new SbisRequestNotAllowed(`запрос ${method} ${url.protocol}//${sbisEndpointOf(url)}`);
  }
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryServer = (opts.retryOn ?? 'network_and_server') === 'network_and_server';
  const sleep = opts.sleep ?? defaultSleep;
  const endpoint = sbisEndpointOf(url);

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await sendOnce(opts);
    } catch (err) {
      if (err instanceof SbisRequestNotAllowed || err instanceof SbisAborted) throw err;
      if (attempt >= maxRetries) {
        throw new SbisTransient(describeNetworkFailure(err), endpoint, { cause: err });
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.ok) return res;

    if (res.status === 401) throw new SbisAuthExpired(await readGatewayError(res, opts.secrets));
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new SbisAccessDenied(endpoint);
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      throw new SbisGone(res.status, endpoint);
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      if (!retryServer || attempt >= maxRetries) {
        throw new SbisTransient(`HTTP ${res.status}`, endpoint);
      }
      await sleep(backoffMs(attempt));
      continue;
    }
    // Сервис входа отвечает 400 с текстом отказа: без него «HTTP 400» ничего не говорит.
    if (res.status === 400 && url.pathname === '/oauth/service/') {
      throw new SbisAuthRejected((await readGatewayError(res, opts.secrets)) ?? 'HTTP 400');
    }
    await res.body?.cancel().catch(() => {});
    throw new SbisHttpError(res.status, endpoint);
  }
}

function asTransientBodyFailure(err: unknown, url: URL | null): SbisTransient {
  return new SbisTransient(
    `ответ оборвался при чтении: ${describeNetworkFailure(err)}`,
    url ? sbisEndpointOf(url) : null,
    { cause: err },
  );
}

/**
 * Читает тело потоково и обрывает чтение, как только превышен лимит (копия
 * подхода `readBodyWithLimit` из diadoc.http.ts — та бросает классы Диадока).
 */
export async function readSbisBody(res: Response, maxBytes: number, url: URL | null = null): Promise<Buffer> {
  const declared = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new SbisPayloadTooLarge(maxBytes);
  }
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch (err) {
        throw asTransientBodyFailure(err, url);
      }
      const { done, value } = step;
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new SbisPayloadTooLarge(maxBytes);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    await res.body.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}

/** Код вида 00000000-0000-0000-0000-1AA000001000: класс — первые три знака хвоста. */
const ERROR_CODE_RE = /0{8}-0{4}-0{4}-0{4}-(1[0-9a-f]{11})/i;

/**
 * Класс ошибки JSON-RPC по расширенному коду. Где именно он лежит в объекте
 * ошибки, справка не пишет, поэтому ищем по всему объекту.
 */
export function rpcErrorClass(error: unknown): { code: string | null; retry: boolean } {
  let text: string;
  try {
    text = JSON.stringify(error) ?? '';
  } catch {
    text = '';
  }
  const match = ERROR_CODE_RE.exec(text);
  if (!match) return { code: null, retry: false };
  const code = match[1]!.toUpperCase();
  // Справка: 1AA — достаточно повторить; 1FA и любой другой код — фатально.
  return { code, retry: code.startsWith('1AA') };
}

function rpcErrorDetail(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const e = error as { message?: unknown; details?: unknown };
  const parts = [e.message, e.details].filter((p): p is string => typeof p === 'string' && !!p.trim());
  const unique = [...new Set(parts.map((p) => p.trim()))];
  return unique.join(' — ') || 'ошибка без описания';
}

export type SbisRpcOptions = SbisTransportOptions & {
  url?: URL;
  rpcMethod: string;
  params: unknown;
  headers?: Record<string, string>;
  maxBytes?: number;
};

/**
 * Вызов JSON-RPC 2.0. Ошибка приходит объектом в теле (обычно с HTTP 500),
 * поэтому тело читается при любом коде, кроме отказов шлюза.
 */
export async function sbisRpc(opts: SbisRpcOptions): Promise<unknown> {
  const url = opts.url ?? new URL(SBIS_URLS.service);
  if (!isAllowedSbisRequest('POST', url)) {
    throw new SbisRequestNotAllowed(`запрос POST ${url.protocol}//${sbisEndpointOf(url)}`);
  }
  if (!isAllowedSbisRpc(url, opts.rpcMethod)) {
    throw new SbisRequestNotAllowed(`метод ${opts.rpcMethod}`);
  }
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryServer = (opts.retryOn ?? 'network_and_server') === 'network_and_server';
  const sleep = opts.sleep ?? defaultSleep;
  const endpoint = sbisEndpointOf(url);
  const body = JSON.stringify({ jsonrpc: '2.0', method: opts.rpcMethod, params: opts.params, id: 0 });
  const fetchOpts: SbisFetchOptions = {
    ...opts,
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json-rpc;charset=utf-8', ...opts.headers },
    body,
  };

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await sendOnce(fetchOpts);
    } catch (err) {
      if (err instanceof SbisRequestNotAllowed || err instanceof SbisAborted) throw err;
      if (attempt >= maxRetries) {
        throw new SbisTransient(describeNetworkFailure(err), endpoint, { cause: err });
      }
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.status === 401) throw new SbisAuthExpired(await readGatewayError(res, opts.secrets));
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new SbisAccessDenied(endpoint);
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => {});
      throw new SbisGone(res.status, endpoint);
    }

    const raw = await readSbisBody(res, opts.maxBytes ?? DEFAULT_RPC_MAX_BYTES, url);
    let parsed: { result?: unknown; error?: unknown } | null = null;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as { result?: unknown; error?: unknown };
    } catch {
      parsed = null;
    }

    if (parsed && parsed.error != null) {
      const cls = rpcErrorClass(parsed.error);
      const detail = clip(redact(rpcErrorDetail(parsed.error), opts.secrets ?? []));
      if (cls.retry && retryServer && attempt < maxRetries) {
        await sleep(Math.max(NON_FATAL_DELAY_MS, backoffMs(attempt)));
        continue;
      }
      if (cls.retry) throw new SbisTransient(`${detail} [${cls.code}]`, endpoint);
      const code = (parsed.error as { code?: unknown }).code;
      throw new SbisRpcError(opts.rpcMethod, code == null ? null : String(code), cls.code, detail);
    }

    if (res.status >= 500 || !parsed) {
      if (!retryServer || attempt >= maxRetries) {
        throw new SbisTransient(res.ok ? 'ответ не JSON' : `HTTP ${res.status}`, endpoint);
      }
      await sleep(backoffMs(attempt));
      continue;
    }
    if (!res.ok) throw new SbisHttpError(res.status, endpoint);
    return parsed.result;
  }
}
