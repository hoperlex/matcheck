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

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}
