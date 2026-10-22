/**
 * Текст ошибки на страницах авторизации должен называть причину.
 *
 * На перезапуске API при деплое nginx отдаёт 502, и вход показывал общее
 * «Ошибка входа» — человек решал, что ошибся в пароле, хотя сервер пароль не
 * проверял вовсе. Сброс пароля в ту же минуту говорил «Ссылка недействительна»
 * про рабочую ссылку.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { localizeApiError } from './errorMessages';

const FALLBACK = 'Ошибка входа';
const SERVER_UNAVAILABLE =
  'Сервер временно недоступен — возможно, идёт обновление. Повторите через минуту.';

describe('localizeApiError', () => {
  it('неверный пароль — по-прежнему по коду, а не по статусу', () => {
    const err = new ApiError(401, 'invalid_credentials', 'Invalid email or password');
    expect(localizeApiError(err, FALLBACK)).toBe('Неверный email или пароль');
  });

  it('502 от nginx с HTML-телом — сервер недоступен', () => {
    const err = new ApiError(502, 'http_error', 'HTTP 502');
    expect(localizeApiError(err, FALLBACK)).toBe(SERVER_UNAVAILABLE);
  });

  it('5xx с незнакомым кодом — сервер недоступен', () => {
    const err = new ApiError(503, 'service_unavailable', 'Service unavailable');
    expect(localizeApiError(err, FALLBACK)).toBe(SERVER_UNAVAILABLE);
  });

  it('таймаут клиента — отдельный текст', () => {
    const err = new ApiError(0, 'timeout', 'Превышено время ожидания запроса');
    expect(localizeApiError(err, FALLBACK)).toBe(
      'Превышено время ожидания ответа сервера. Повторите попытку.',
    );
  });

  it('429 с русским текстом бэкенда — этот текст', () => {
    const err = new ApiError(429, 'rate_limited', 'Слишком много попыток, подождите минуту');
    expect(localizeApiError(err, FALLBACK)).toBe('Слишком много попыток, подождите минуту');
  });

  it('4xx с незнакомым кодом — fallback вызывающего', () => {
    const err = new ApiError(400, 'validation_error', 'Bad request');
    expect(localizeApiError(err, FALLBACK)).toBe(FALLBACK);
  });

  it('сетевой TypeError — fallback: обрыв не отличить от нашей ошибки', () => {
    expect(localizeApiError(new TypeError('Failed to fetch'), FALLBACK)).toBe(FALLBACK);
  });
});
