// Повтор транзиентных сбоев S3 и чтение по presigned URL для стрим-прокси.
//
// Модуль намеренно без env и клиента aws4fetch: интеграционные тесты подменяют
// `s3.signer.js` целиком (vi.mock без оригинала), и обвязка, живущая там,
// исчезла бы из маршрутов под тестом. Отсюда её моки не задевают.

// Провайдер (s3.cloud.ru) резолвится в ПУЛ IP, и отдельный узел бывает болен:
// 03.07 узел .30 не принимал соединения, 06.10 узел .31 отвечал 502 и зависал
// примерно на трети запросов. Повтор полезен, потому что такие отказы
// непостоянны. Другой узел он НЕ гарантирует: undici держит keep-alive-пул
// соединений к origin, новое соединение (и новый DNS-резолв) появляется после
// сетевого обрыва, а после HTTP 502 соединение может переиспользоваться и
// повтор уйдёт на тот же узел.
//
// Повторяем ТОЛЬКО транзиентное: брошенное сетевое исключение (ConnectTimeout/
// ECONNRESET/EAI_AGAIN/«fetch failed», наш таймаут) и шлюзовые 502/503/504. На
// успехе и на прочих 4xx (включая 404) не повторяем — это валидный ответ,
// который обрабатывает вызывающий.
const S3_MAX_ATTEMPTS = 3;
const S3_RETRY_BASE_MS = 200;

/**
 * Сколько стрим-прокси ждёт ЗАГОЛОВКИ ответа S3 на одну попытку. Нормальный
 * ответ приходит за доли секунды; зависший узел без этого держал бы сокет до
 * таймаутов undici (10 с на соединение, 300 с на заголовки). Тело под этот
 * дедлайн не попадает: большой PDF к медленному клиенту не должен обрываться.
 */
export const S3_STREAM_HEADERS_TIMEOUT_MS = 8000;

function isTransientS3Status(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Освобождает тело ответа, которое не будем читать. Undici требует прочитать
 * или отменить неиспользуемое тело: иначе соединение возвращается в пул
 * недетерминированно (по сборке мусора), и во время сбоя S3 копятся лишние
 * соединения. Ошибку отмены глотаем — тело могло быть уже прочитано.
 */
export async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // уже прочитано или закрыто — освобождать нечего
  }
}

export type S3RetryHooks = {
  /** Перед паузой, когда повтор точно будет. */
  onRetry?: (info: { attempt: number; status?: number; err?: unknown }) => void;
  /** Ровно один раз по итогу: вернули ответ (`status`) или бросили (`err`). */
  onFinish?: (info: { attempts: number; status?: number; err?: unknown }) => void;
};

/** Хук — это логирование: его сбой не должен ломать саму операцию. */
function notify<T>(hook: ((info: T) => void) | undefined, info: T): void {
  try {
    hook?.(info);
  } catch {
    // проглатываем намеренно
  }
}

/**
 * Оборачивает одну S3-операцию (`() => getClient().fetch(...)`) ретраем.
 * Экспортируется ради юнит-тестов: `attempt`/`sleep` инжектируются.
 */
export async function s3FetchWithRetry(
  attempt: () => Promise<Response>,
  opts: {
    maxAttempts?: number;
    baseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } & S3RetryHooks = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? S3_MAX_ATTEMPTS;
  const baseMs = opts.baseMs ?? S3_RETRY_BASE_MS;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let i = 1; i <= maxAttempts; i++) {
    let res: Response;
    try {
      res = await attempt();
    } catch (err) {
      lastErr = err;
      if (i >= maxAttempts) {
        notify(opts.onFinish, { attempts: i, err });
        throw err;
      }
      notify(opts.onRetry, { attempt: i, err });
      await sleep(baseMs * Math.pow(3, i - 1)); // 200мс, 600мс, …
      continue;
    }
    // Шлюзовой 5xx — транзиентный, повторяем; на последней попытке отдаём
    // ответ вызывающему (он бросит осмысленную «HTTP 5xx»-ошибку).
    if (isTransientS3Status(res.status) && i < maxAttempts) {
      lastErr = new Error(`S3 transient HTTP ${res.status}`);
      await discardBody(res);
      notify(opts.onRetry, { attempt: i, status: res.status });
      await sleep(baseMs * Math.pow(3, i - 1));
      continue;
    }
    notify(opts.onFinish, { attempts: i, status: res.status });
    return res;
  }
  throw lastErr instanceof Error ? lastErr : new Error('S3 fetch failed after retries');
}

/** Минимум от логгера Fastify/pino, нужный обвязке. */
export type S3StreamLog = { warn: (obj: object, msg: string) => void };

/**
 * GET по presigned URL для маршрутов, которые стримят файл из S3 клиенту.
 *
 * Каждая попытка заводит свой AbortController: общий сигнал пришёл бы во вторую
 * попытку уже прерванным. Таймер снимается сразу после `await fetch` — fetch
 * резолвится на заголовках, и дальше тело стримится без нашего дедлайна
 * (простой между чанками ограничивает bodyTimeout undici). Таймаут прерывает
 * с DOMException `TimeoutError`, как `AbortSignal.timeout`, — вызывающие
 * отличают его от прочих сбоев.
 *
 * Логи: `S3 transient, retrying` — на каждую повторную попытку;
 * `S3 retry finished` — один раз на запрос, у которого был повтор. «Спасённые»
 * считаются по второму: финальный статус 200/206/304.
 */
export async function fetchPresignedForStream(
  url: string,
  opts: {
    headers?: Record<string, string>;
    log: S3StreamLog;
    logContext: Record<string, unknown>;
    headersTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<Response> {
  const timeoutMs = opts.headersTimeoutMs ?? S3_STREAM_HEADERS_TIMEOUT_MS;
  return s3FetchWithRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(
        () =>
          controller.abort(
            new DOMException(`S3 не прислал заголовки за ${timeoutMs} мс`, 'TimeoutError'),
          ),
        timeoutMs,
      );
      try {
        return await fetch(url, { headers: opts.headers, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    },
    {
      sleep: opts.sleep,
      onRetry: ({ attempt, status, err }) =>
        opts.log.warn({ ...opts.logContext, attempt, status, err }, 'S3 transient, retrying'),
      onFinish: ({ attempts, status, err }) => {
        if (attempts > 1) {
          opts.log.warn({ ...opts.logContext, attempts, status, err }, 'S3 retry finished');
        }
      },
    },
  );
}
