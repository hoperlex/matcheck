/**
 * Единственная точка выхода в API Диадока.
 *
 * Зачем отдельный слой. Интеграция объявлена read-only: мы забираем входящие
 * документы и не подписываем, не отправляем и не меняем ничего на стороне
 * Диадока. Держать это обещание «на честном слове» нельзя — достаточно одного
 * неосторожного вызова, чтобы от имени организации ушёл юридически значимый
 * документ. Поэтому запрещающий список здесь не рекомендация, а механизм:
 * каждый запрос обязан совпасть с записью в ALLOWED_ROUTES по СОЧЕТАНИЮ метода,
 * точного хоста и пути. Проверка по подстроке пути не годится: `/V3/Sign`
 * прекрасно живёт внутри произвольного URL.
 *
 * Второе назначение — матрица ошибок. У части ответов Диадока повтор бессмыслен
 * и вреден: 403 (токен и ящик с разных площадок либо нет прав) и 402
 * (закончилась подписка) повтором не лечатся, а ретраи только жгут квоту и
 * прячут причину от человека.
 */
import { loadEnv } from '../../lib/env.js';

export type DiadocEnvironment = 'production' | 'staging';

/**
 * Адреса и scope по площадкам.
 *
 * Хранить базовый URL в БД как свободную строку нельзя: админка стала бы
 * управляемым источником адреса исходящего запроса, то есть SSRF-вектором.
 * Поэтому в учётной записи лежит только имя площадки, а адреса — здесь.
 *
 * Запросы авторизации уходят НЕ в Диадок, а на identity.kontur.ru — это прямо
 * оговорено в документации, и путать их адреса нельзя.
 *
 * ВНИМАНИЕ: хост тестовой площадки подтверждается на этапе spike (Э1). По
 * документации площадка определяется scope токена, а не адресом API; если
 * выяснится иначе — правится одна константа.
 */
export const DIADOC_ENDPOINTS: Record<
  DiadocEnvironment,
  { api: string; identity: string; scope: string }
> = {
  production: {
    api: 'https://diadoc-api.kontur.ru',
    identity: 'https://identity.kontur.ru',
    scope: 'Diadoc.PublicAPI',
  },
  staging: {
    api: 'https://diadoc-api.kontur.ru',
    identity: 'https://identity.kontur.ru',
    scope: 'Diadoc.PublicAPI.Staging',
  },
};

/** Метод + хост + путь. Ничего, кроме перечисленного, наружу не уходит. */
type AllowedRoute = { method: 'GET' | 'POST'; host: string; path: string };

const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  // Авторизация — на identity, не на Диадок.
  { method: 'POST', host: 'identity.kontur.ru', path: '/connect/token' },
  // Диагностика доступа.
  { method: 'GET', host: 'diadoc-api.kontur.ru', path: '/GetMyOrganizations' },
  { method: 'GET', host: 'diadoc-api.kontur.ru', path: '/GetMyEmployee' },
  // Чтение ленты и содержимого.
  { method: 'GET', host: 'diadoc-api.kontur.ru', path: '/V8/GetNewEvents' },
  { method: 'GET', host: 'diadoc-api.kontur.ru', path: '/V6/GetMessage' },
  { method: 'GET', host: 'diadoc-api.kontur.ru', path: '/V4/GetEntityContent' },
  // Резервный разбор формализованного титула (за флагом EDO_PARSE_TITLE_FALLBACK).
  { method: 'POST', host: 'diadoc-api.kontur.ru', path: '/ParseTitleXml' },
];

export function isAllowedRequest(method: string, url: URL): boolean {
  return ALLOWED_ROUTES.some(
    (r) => r.method === method && r.host === url.hostname && r.path === url.pathname,
  );
}

/** Запрос не прошёл разрешающий список. Это дефект кода, а не сбой сети. */
export class DiadocRequestNotAllowed extends Error {
  constructor(method: string, url: URL) {
    super(`Diadoc: запрос ${method} ${url.hostname}${url.pathname} не разрешён (read-only режим)`);
    this.name = 'DiadocRequestNotAllowed';
  }
}

/**
 * Ниже — отказы ТРАНСПОРТА. Важное свойство: они не относятся к конкретному
 * документу, поэтому не должны расходовать бюджет попыток его разбора. Проход
 * прекращается, курсор остаётся на месте, следующий заход повторит с того же
 * места.
 */
export class DiadocRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Diadoc: превышен лимит запросов, повтор через ${Math.round(retryAfterMs / 1000)} с`);
    this.name = 'DiadocRateLimited';
  }
}

export class DiadocTransient extends Error {
  constructor(message: string) {
    super(`Diadoc: временный сбой — ${message}`);
    this.name = 'DiadocTransient';
  }
}

/** 401: токен просрочен или повреждён. Лечится одной переавторизацией. */
export class DiadocAuthExpired extends Error {
  constructor(message = 'токен отклонён') {
    super(`Diadoc: ${message}`);
    this.name = 'DiadocAuthExpired';
  }
}

/**
 * 403: доступа к ящику нет либо токен и ящик с разных площадок. Повтор
 * бессмыслен — нужен человек, поэтому опрос учётной записи останавливается.
 */
export class DiadocAccessDenied extends Error {
  constructor(message = 'нет доступа к ящику (проверьте площадку и права учётной записи)') {
    super(`Diadoc: ${message}`);
    this.name = 'DiadocAccessDenied';
  }
}

/** 402: закончилась подписка. Постоянная ошибка учётной записи. */
export class DiadocSubscriptionExpired extends Error {
  constructor() {
    super('Diadoc: доступ приостановлен (402) — истёк срок действия подписки');
    this.name = 'DiadocSubscriptionExpired';
  }
}

/** 404/410: документа больше нет. Терминально для ЭТОЙ сущности, не для прохода. */
export class DiadocGone extends Error {
  constructor(readonly status: number) {
    super(`Diadoc: содержимое недоступно (HTTP ${status})`);
    this.name = 'DiadocGone';
  }
}

/**
 * Сервис авторизации отклонил выдачу токена.
 *
 * По OAuth2 такие отказы приходят кодом 400 с телом `{error, error_description}`,
 * и именно в этом теле лежит ответ на вопрос «что не так с ключами». Тело
 * ответов Диадока мы наружу не показываем — там реквизиты организаций, — но у
 * identity.kontur.ru в теле только коды протокола, и прятать их значит
 * оставлять администратора один на один с «HTTP 400».
 */
export class DiadocAuthRejected extends Error {
  constructor(
    readonly code: string,
    readonly description: string | null,
  ) {
    super(`Diadoc: сервис авторизации отклонил запрос (${code}${description ? `: ${description}` : ''})`);
    this.name = 'DiadocAuthRejected';
  }
}

/** Тело ответа превысило лимит. Бросается ДО того, как оно прочитано целиком. */
export class DiadocPayloadTooLarge extends Error {
  constructor(readonly limitBytes: number) {
    super(`Diadoc: размер содержимого превысил ${limitBytes} байт`);
    this.name = 'DiadocPayloadTooLarge';
  }
}

const DEFAULT_RETRY_AFTER_MS = 30_000;
/** Верхняя граница ожидания по Retry-After: дольше держать проход смысла нет. */
const MAX_RETRY_AFTER_MS = 120_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry-After приходит в секундах либо датой; заголовка может не быть вовсе.
 * Джиттер обязателен: без него несколько процессов, получив 429 одновременно,
 * вернутся тоже одновременно и повторят отказ.
 */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const asNumber = Number(header.trim());
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(asNumber * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    return Math.min(Math.max(asDate - now, 0), MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function withJitter(ms: number): number {
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

/**
 * Достаёт код ошибки из ответа сервиса авторизации.
 *
 * Возвращает `null`, если тело не разобралось: отказ от этого не перестаёт быть
 * отказом, и терять его из-за неожиданного формата нельзя. Описание обрезаем —
 * оно идёт в интерфейс и в поле состояния учётной записи.
 */
async function readOidcError(
  res: Response,
): Promise<{ code: string; description: string | null } | null> {
  try {
    const body = (await res.json()) as { error?: unknown; error_description?: unknown };
    if (typeof body?.error !== 'string' || !body.error) return null;
    const description =
      typeof body.error_description === 'string' ? body.error_description.slice(0, 200) : null;
    return { code: body.error, description };
  } catch {
    return null;
  }
}

export type DiadocFetchOptions = {
  method: 'GET' | 'POST';
  url: URL;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
};

/**
 * Выполняет запрос с разбором матрицы ошибок и повторами там, где они уместны.
 *
 * Тела ответов в исключения не попадают: в них лежат реквизиты организаций и
 * содержимое документов, а сообщения ошибок уходят в логи и в интерфейс.
 */
export async function diadocFetch(opts: DiadocFetchOptions): Promise<Response> {
  const { method, url, headers, body, timeoutMs } = opts;
  if (!isAllowedRequest(method, url)) throw new DiadocRequestNotAllowed(method, url);

  const maxRetries = opts.maxRetries ?? loadEnv().EDO_HTTP_MAX_RETRIES;
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;

  let lastTransient: string | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Сеть или таймаут: повторяем, пока есть попытки.
      lastTransient = err instanceof Error ? err.name : 'network error';
      if (attempt >= maxRetries) throw new DiadocTransient(lastTransient);
      await sleep(withJitter(500 * Math.pow(3, attempt)));
      continue;
    }

    if (res.ok) return res;

    switch (res.status) {
      case 401:
        throw new DiadocAuthExpired();
      case 402:
        throw new DiadocSubscriptionExpired();
      case 403:
        throw new DiadocAccessDenied();
      case 404:
      case 410:
        throw new DiadocGone(res.status);
      case 429: {
        const waitMs = parseRetryAfterMs(res.headers.get('Retry-After'));
        if (attempt >= maxRetries) throw new DiadocRateLimited(waitMs);
        await sleep(withJitter(waitMs));
        continue;
      }
      default:
        if (res.status >= 500) {
          lastTransient = `HTTP ${res.status}`;
          if (attempt >= maxRetries) throw new DiadocTransient(lastTransient);
          await sleep(withJitter(500 * Math.pow(3, attempt)));
          continue;
        }
        // Прочие 4xx — дефект запроса, повтор не поможет. Показывать ли тело,
        // решает ХОСТ, а не код ответа: это единственный признак, который
        // нельзя перепутать. У сервиса авторизации в теле коды протокола —
        // без них отказ неотличим от любого другого; у Диадока в теле данные
        // организаций, поэтому оттуда берём только заголовок с кодом ошибки.
        if (url.hostname === 'identity.kontur.ru') {
          const parsed = await readOidcError(res);
          if (parsed) throw new DiadocAuthRejected(parsed.code, parsed.description);
        }
        {
          const code = res.headers.get('X-Diadoc-ErrorCode');
          throw new Error(
            `Diadoc: запрос отклонён (HTTP ${res.status}${code ? `, ${code}` : ''})`,
          );
        }
    }
  }

  throw new DiadocTransient(lastTransient ?? 'исчерпаны попытки');
}

/**
 * Читает тело ПОТОКОВО и обрывает чтение, как только превышен лимит.
 *
 * Именно потоково, а не `arrayBuffer()` с проверкой длины после: к моменту
 * такой проверки память уже израсходована, то есть защита срабатывала бы уже
 * после ущерба. Content-Length проверяем тоже, но полагаться только на него
 * нельзя — при chunked-ответе заголовка нет.
 */
export async function readBodyWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new DiadocPayloadTooLarge(maxBytes);
  }

  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new DiadocPayloadTooLarge(maxBytes);
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    await res.body.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, total);
}
