/**
 * Ошибка с явным HTTP-статусом. Только такие меняют код ответа в
 * errorHandler — намеренно узко.
 *
 * Почему не любой err.statusCode: ошибки валидации Fastify/zod несут
 * statusCode=400, и если бы обработчик их учитывал, невалидный запрос стал
 * бы отдавать 400 вместо нынешнего 500. Мобильный MutationProcessor на 4xx
 * делает Drop (мутация удаляется из очереди), а на 5xx — Backoff (остаётся
 * и ретраится). То есть смена 500→400 превратила бы «мутация висит» в
 * «данные приёмки молча пропали». Здесь этого не делаем.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  /**
   * Машиночитаемые подробности отказа — уходят в тело ответа рядом с
   * `error`/`message`, но только у 4xx (см. lib/error-handler.ts).
   *
   * Нужны там, где клиенту недостаточно текста: конфликт правки матрицы прав
   * возвращает список ячеек с фактическими значениями, и разбирать его из
   * человеческой фразы было бы нельзя.
   */
  readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

/**
 * Превышение rate-limit. Отдельный класс нужен ради `name`: errorHandler
 * отдаёт наружу именно его как поле `error`, а фронт локализует сообщения по
 * этому коду. Голый HttpError представился бы клиенту как «HttpError».
 *
 * Без такого класса @fastify/rate-limit вообще не мог отдать 429: он бросает
 * результат errorResponseBuilder как ошибку, а errorHandler признаёт статус
 * только у HttpError — простой объект превращался в 500 internal_error.
 */
export class RateLimitError extends HttpError {
  constructor(message: string) {
    super(429, message);
    this.name = 'rate_limit_exceeded';
  }
}
