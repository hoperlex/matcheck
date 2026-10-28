import { describeNetworkFailure, parseRetryAfterMs } from '../edo/diadoc.http.js';
import { redact } from '../edo/sbis/sbis.http.js';
import {
  capabilitiesSchema,
  errorBodySchema,
  orderDetailSchema,
  orderPageSchema,
  type EstimatCapabilities,
  type EstimatErrorBody,
  type EstimatOrderItemRaw,
  type OrderPage,
} from './estimat.types.js';

/**
 * Транспорт внешнего API EstiMat: только чтение, только разрешённые пути.
 * Ветвление по коду отказа (`error`) и `recovery`, а не по тексту и не по одному
 * HTTP-коду. Токен не попадает ни в одно сообщение об ошибке.
 */

export class EstimatError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly requestId: string | null;
  constructor(code: string, message: string, opts?: { status?: number | null; requestId?: string | null; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'EstimatError';
    this.code = code;
    this.status = opts?.status ?? null;
    this.requestId = opts?.requestId ?? null;
  }
}

/** Токен отклонён (api_token_*) или не выдано право (insufficient_scope): повторы бесполезны. */
export class EstimatAuthError extends EstimatError {
  constructor(code: string, message: string, opts?: { status?: number | null; requestId?: string | null }) {
    super(code, message, opts);
    this.name = 'EstimatAuthError';
  }
}

/** Курсор не принят — обход начинается заново. */
export class EstimatCursorError extends EstimatError {
  constructor(message: string, opts?: { status?: number | null; requestId?: string | null }) {
    super('invalid_cursor', message, opts);
    this.name = 'EstimatCursorError';
  }
}

/** Остановка процесса между запросами. */
export class EstimatAborted extends Error {
  constructor() {
    super('обход EstiMat остановлен');
    this.name = 'EstimatAborted';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const SERVER_RETRIES = 3;
const RATE_LIMIT_ATTEMPTS = 5;
const MAX_ERROR_BODY = 64 * 1024;
const PAGE_LIMIT = 100;

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Разрешённые пути относительно базы. Всё прочее — ошибка программы, а не сети. */
function isAllowedPath(rel: string): boolean {
  if (rel === '/supplier-orders' || rel === '/capabilities' || rel === '/openapi.json') return true;
  const m = /^\/supplier-orders\/([^/]+)$/.exec(rel);
  return !!m && UUID_SEGMENT.test(m[1]!);
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Пауза, которую прерывает остановка процесса. */
export const abortableSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new EstimatAborted());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new EstimatAborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export type EstimatClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: Sleep;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Вызывается перед каждой паузой (повтор после 429/503/500/сети): через него
   * обход обновляет heartbeat, чтобы долгое ожидание не сочли зависанием.
   */
  onWait?: (ms: number, reason: string) => Promise<void> | void;
  /** false — на rate_limited/database_busy не ждать, а сразу отказ (состав по требованию). */
  retryRateLimit?: boolean;
};

function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function backoffMs(attempt: number): number {
  return Math.round(1000 * Math.pow(3, attempt) * (0.8 + Math.random() * 0.4));
}

function withJitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

async function readErrorBody(res: Response): Promise<EstimatErrorBody | null> {
  try {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_ERROR_BODY) return null;
    const parsed = errorBodySchema.safeParse(JSON.parse(new TextDecoder().decode(buf)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function missingScopes(details: unknown): string | null {
  if (details && typeof details === 'object' && 'missing' in details) {
    const m = (details as { missing: unknown }).missing;
    if (Array.isArray(m)) return m.map(String).join(', ');
    if (typeof m === 'string') return m;
  }
  return null;
}

export function createEstimatClient(opts: EstimatClientOptions) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? abortableSleep;
  const secrets = [opts.token];
  const safe = (text: string) => clip(redact(text, secrets));

  async function wait(ms: number, reason: string): Promise<void> {
    await opts.onWait?.(ms, reason);
    await sleep(ms, opts.signal);
  }

  async function sendOnce(url: URL, auth: boolean): Promise<Response> {
    if (opts.signal?.aborted) throw new EstimatAborted();
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) headers.Authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw new EstimatAborted();
      throw err;
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      // Редирект — почти всегда страница входа интерфейса вместо API.
      throw new EstimatError('redirect', `EstiMat ответил перенаправлением (${res.status}) — проверьте адрес API`, {
        status: res.status,
      });
    }
    return res;
  }

  async function getJson(rel: string, query: Record<string, string> | null, auth = true): Promise<unknown> {
    if (!isAllowedPath(rel)) throw new Error(`EstiMat: путь не разрешён: ${rel}`);
    const url = new URL(opts.baseUrl + rel);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let serverAttempt = 0;
    let rateAttempt = 0;
    // maxAttempts — «сколько попыток операции имеет смысл всего»: запоминаем
    // самый строгий из присланных, а не только последний.
    let rateLimit = RATE_LIMIT_ATTEMPTS;
    for (;;) {
      let res: Response;
      try {
        res = await sendOnce(url, auth);
      } catch (err) {
        if (err instanceof EstimatError || err instanceof EstimatAborted) throw err;
        const what = describeNetworkFailure(err);
        if (serverAttempt >= SERVER_RETRIES) {
          throw new EstimatError('network', `EstiMat недоступен: ${safe(what)}`, { cause: err });
        }
        await wait(backoffMs(serverAttempt++), `сеть: ${what}`);
        continue;
      }

      if (res.ok) {
        const type = res.headers.get('content-type') ?? '';
        if (!type.toLowerCase().includes('application/json')) {
          await res.body?.cancel().catch(() => {});
          throw new EstimatError(
            'bad_content_type',
            `EstiMat ответил не JSON (${safe(type) || 'без типа'}) — проверьте, что адрес ведёт на api.…`,
            { status: res.status },
          );
        }
        try {
          return await res.json();
        } catch (err) {
          throw new EstimatError('bad_json', 'EstiMat прислал неразборчивый JSON', { status: res.status, cause: err });
        }
      }

      const body = await readErrorBody(res);
      const code = body?.error ?? `http_${res.status}`;
      const requestId = body?.requestId ?? null;
      const message = safe(body?.message ?? `HTTP ${res.status}`);
      const meta = { status: res.status, requestId };

      if (code === 'rate_limited' || code === 'database_busy' || (!body && (res.status === 429 || res.status === 503))) {
        rateLimit = Math.max(1, Math.min(body?.recovery?.maxAttempts ?? rateLimit, rateLimit));
        if (opts.retryRateLimit === false || rateAttempt + 1 >= rateLimit) {
          throw new EstimatError(code, `EstiMat занят: ${message}`, meta);
        }
        rateAttempt++;
        const header = res.headers.get('retry-after');
        const ms = header
          ? parseRetryAfterMs(header)
          : body?.recovery?.retryAfterSec !== undefined
            ? Math.min(body.recovery.retryAfterSec * 1000, 120_000)
            : parseRetryAfterMs(null);
        await wait(withJitter(ms), code);
        continue;
      }
      if (code.startsWith('api_token_') || res.status === 401) {
        throw new EstimatAuthError(code, `EstiMat отклонил токен (${code}): ${message}`, meta);
      }
      if (code === 'insufficient_scope' || res.status === 403) {
        const missing = missingScopes(body?.details);
        throw new EstimatAuthError(
          code,
          `токену EstiMat не выдано право${missing ? ` ${safe(missing)}` : ''}: ${message}`,
          meta,
        );
      }
      if (code === 'invalid_cursor') throw new EstimatCursorError(`EstiMat не принял курсор: ${message}`, meta);
      if (code === 'internal_error' || res.status >= 500) {
        if (serverAttempt >= SERVER_RETRIES) throw new EstimatError(code, `сбой EstiMat: ${message}`, meta);
        await wait(backoffMs(serverAttempt++), code);
        continue;
      }
      throw new EstimatError(code, `EstiMat отказал (${code}): ${message}`, meta);
    }
  }

  function contractError(what: string, issue: string): EstimatError {
    return new EstimatError('contract', `ответ EstiMat (${what}) не совпал с контрактом: ${safe(issue)}`);
  }

  return {
    /** Страница заказов. Курсор передаётся целиком и без изменений. */
    async listSupplierOrders(cursor: string | null): Promise<OrderPage> {
      const query: Record<string, string> = { limit: String(PAGE_LIMIT) };
      if (cursor !== null) query.cursor = cursor;
      const parsed = orderPageSchema.safeParse(await getJson('/supplier-orders', query));
      if (!parsed.success) throw contractError('страница заказов', parsed.error.issues[0]?.message ?? '');
      return parsed.data;
    },

    /** Состав заказа: позиции из GET /supplier-orders/{id}. */
    async getSupplierOrderItems(id: string): Promise<EstimatOrderItemRaw[]> {
      const parsed = orderDetailSchema.safeParse(await getJson(`/supplier-orders/${id}`, null));
      if (!parsed.success) throw contractError('заказ', parsed.error.issues[0]?.message ?? '');
      return parsed.data.data.items;
    },

    /** Действующие права токена и объект, до которого он сужен. */
    async capabilities(): Promise<EstimatCapabilities> {
      const parsed = capabilitiesSchema.safeParse(await getJson('/capabilities', null));
      if (!parsed.success) throw contractError('capabilities', parsed.error.issues[0]?.message ?? '');
      return parsed.data.data;
    },

    /** Версия контракта из спецификации (без токена). */
    async openapiVersion(): Promise<string | null> {
      const doc = (await getJson('/openapi.json', null, false)) as { info?: { version?: unknown } };
      return typeof doc?.info?.version === 'string' ? doc.info.version : null;
    },
  };
}

export type EstimatClient = ReturnType<typeof createEstimatClient>;
