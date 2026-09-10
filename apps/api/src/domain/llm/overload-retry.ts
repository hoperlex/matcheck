/**
 * Повтор запроса к LLM-провайдеру, когда тот отвечает «я перегружен».
 *
 * Зачем. Запросы уходят не напрямую в OpenRouter, а через промежуточный прокси
 * (адрес хранится в `llm_provider_credentials.api_base_url`), и очередь у него
 * ОБЩАЯ с чужими сервисами. Отсюда штатные, не связанные с нами отказы:
 * `503 {"error":{"code":"queue_full","message":"proxy queue is full, retry
 * later"}}` и шлюзовые 502 от nginx. Единичный такой ответ ронял целые
 * операции: на бою 10.09 он откатил постраничную сборку пакета, и пять УПД
 * склеились в одну карточку (приёмка 14601).
 *
 * Что здесь НЕ повторяется, и почему:
 *  - успешный ответ и любой 4xx кроме 429 — это валидный ответ провайдера,
 *    его разбирает вызывающий;
 *  - брошенное исключение (в том числе таймаут `AbortSignal.timeout`) — повтор
 *    удвоил бы и без того долгое ожидание, а воркер работает с CONCURRENCY=1,
 *    где каждая лишняя секунда задерживает всю очередь.
 *
 * Бюджет ожидания жёсткий по той же причине: две паузы, не длиннее
 * OVERLOAD_MAX_DELAY_MS каждая и не больше OVERLOAD_TOTAL_BUDGET_MS суммарно.
 * Если провайдер просит ждать дольше бюджета — не ждём вовсе, а отдаём его
 * ответ вызывающему: пусть операция честно откатится, чем задание зависнет.
 */

/** Всего попыток, включая первую. */
export const OVERLOAD_MAX_ATTEMPTS = 3;
/** База экспоненциальной задержки, когда провайдер не прислал Retry-After. */
export const OVERLOAD_BASE_MS = 1_500;
/** Потолок одной паузы. */
export const OVERLOAD_MAX_DELAY_MS = 10_000;
/** Потолок суммы пауз за все повторы. */
export const OVERLOAD_TOTAL_BUDGET_MS = 20_000;

/** Статусы, которые провайдер отдаёт при перегрузке, а не по существу запроса. */
export function isOverloadStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * `Retry-After` в миллисекундах: заголовок бывает и числом секунд, и HTTP-датой.
 * Отрицательное и нечисловое значение — как отсутствующее.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const ms = at - now;
  return ms > 0 ? ms : null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Задержка перед повтором: просьба провайдера имеет приоритет, иначе
 * экспонента с ПОЛНЫМ джиттером.
 *
 * Джиттер здесь не косметика: очередь у прокси общая, и синхронный повтор всех
 * ждущих клиентов ровно через N секунд снова забил бы её разом.
 */
export function overloadDelayMs(args: {
  attempt: number;
  retryAfterMs: number | null;
  baseMs?: number;
  random?: () => number;
}): number {
  const baseMs = args.baseMs ?? OVERLOAD_BASE_MS;
  if (args.retryAfterMs != null) return Math.min(args.retryAfterMs, OVERLOAD_MAX_DELAY_MS);
  const rand = args.random ?? Math.random;
  const ceiling = Math.min(baseMs * Math.pow(2, args.attempt - 1), OVERLOAD_MAX_DELAY_MS);
  return Math.round(ceiling * (0.5 + rand() * 0.5));
}

/**
 * Оборвалось соединение — повторять можно; истёк наш таймаут — нельзя.
 *
 * Разница принципиальная. Обрыв (`fetch failed` от undici, ECONNRESET,
 * отказ DNS) приходит быстро и часто относится к одному узлу пула, поэтому
 * следующая попытка почти бесплатна. Истёкший `AbortSignal.timeout` означает,
 * что бюджет ожидания УЖЕ потрачен целиком: повтор удвоил бы его, а воркер
 * работает с CONCURRENCY=1, где это задерживает всю очередь.
 *
 * На бою обрыв стоил дорого: 04.09.2026 «классификация страниц не удалась:
 * fetch failed» откатила сборку, и две УПД из одного PDF слиплись в один
 * документ.
 */
export function isRetriableNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortError — отмена, TimeoutError — наш собственный дедлайн.
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  const code = (err as { code?: string }).code ?? cause?.code;
  // Коды, где ожидание уже произошло (ETIMEDOUT, *_TIMEOUT), намеренно НЕ
  // повторяем — по той же причине, что и собственный таймаут.
  if (code) {
    return ['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
  }
  return /fetch failed/i.test(err.message);
}

/**
 * Оборачивает один вызов провайдера повтором при перегрузке или обрыве связи.
 *
 * `attempt` обязан каждый раз делать НОВЫЙ fetch: тело ответа прошлой попытки
 * здесь вычитывается и отбрасывается, иначе соединение останется висеть.
 * `sleep` и `random` инжектируются ради тестов.
 */
export async function llmFetchWithOverloadRetry(
  attempt: () => Promise<Response>,
  opts: {
    maxAttempts?: number;
    baseMs?: number;
    totalBudgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    onRetry?: (info: { attempt: number; status: number | null; delayMs: number }) => void;
  } = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? OVERLOAD_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? defaultSleep;
  const totalBudgetMs = opts.totalBudgetMs ?? OVERLOAD_TOTAL_BUDGET_MS;
  let spentMs = 0;

  for (let i = 1; ; i++) {
    let res: Response;
    try {
      res = await attempt();
    } catch (err) {
      if (!isRetriableNetworkError(err) || i >= maxAttempts) throw err;
      const delayMs = overloadDelayMs({
        attempt: i,
        retryAfterMs: null,
        baseMs: opts.baseMs,
        random: opts.random,
      });
      if (spentMs + delayMs > totalBudgetMs) throw err;
      opts.onRetry?.({ attempt: i, status: null, delayMs });
      await sleep(delayMs);
      spentMs += delayMs;
      continue;
    }
    if (!isOverloadStatus(res.status) || i >= maxAttempts) return res;

    const delayMs = overloadDelayMs({
      attempt: i,
      retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
      baseMs: opts.baseMs,
      random: opts.random,
    });
    // Ждать дольше остатка бюджета — значит задержать очередь ради шанса,
    // которого может не быть. Отдаём ответ как есть.
    if (spentMs + delayMs > totalBudgetMs) return res;

    // Тело перегруженного ответа нам не нужно, но его нужно потребить.
    await res.text().catch(() => undefined);
    opts.onRetry?.({ attempt: i, status: res.status, delayMs });
    await sleep(delayMs);
    spentMs += delayMs;
  }
}
