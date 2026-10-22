import { ApiError } from './api';

// Русские тексты по стабильному коду ошибки (ApiError.code = payload.error с
// бэкенда). Локализуем на фронте по КОДУ, а не переводим английские строки —
// коды стабильны, а тексты бэкенда (english) остаются контрактом для тестов/логов.
const CODE_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Неверный email или пароль',
  account_inactive: 'Аккаунт ещё не активирован администратором',
  account_locked:
    'Аккаунт временно заблокирован из-за множества неудачных попыток. Попробуйте позже.',
  email_taken: 'Этот email уже зарегистрирован',
  unauthorized: 'Требуется вход',
  forbidden: 'Недостаточно прав для этого действия',
};

// Причины слабого пароля (payload.details.issues у ошибки weak_password).
const PASSWORD_ISSUE_MESSAGES: Record<string, string> = {
  too_short: 'слишком короткий (минимум 8 символов)',
  too_few_classes: 'нужны минимум 3 класса символов (буквы, цифры, спецсимволы)',
  contains_email: 'не должен содержать email',
  low_entropy: 'слишком простой',
  pwned: 'встречается в утечках паролей',
};

const DEFAULT_FALLBACK = 'Что-то пошло не так. Попробуйте ещё раз.';

// Сервер не ответил или ответил 5xx — это не про введённые данные. Раньше такие
// ответы уходили в fallback вызывающего («Ошибка входа», «Ссылка
// недействительна»), и человек на перезапуске API при деплое (nginx отдаёт 502)
// решал, что ошибся в пароле или что ссылка протухла.
const TIMEOUT_MESSAGE = 'Превышено время ожидания ответа сервера. Повторите попытку.';
const SERVER_UNAVAILABLE_MESSAGE =
  'Сервер временно недоступен — возможно, идёт обновление. Повторите через минуту.';

function weakPasswordMessage(payload: unknown): string {
  const issues =
    payload && typeof payload === 'object' && 'details' in payload
      ? (payload as { details?: { issues?: unknown } }).details?.issues
      : null;
  if (Array.isArray(issues)) {
    const parts = issues
      .map((i) => (typeof i === 'string' ? PASSWORD_ISSUE_MESSAGES[i] : undefined))
      .filter((s): s is string => Boolean(s));
    if (parts.length > 0) return `Пароль не подходит: ${parts.join(', ')}.`;
  }
  return 'Пароль не отвечает требованиям безопасности.';
}

/**
 * Возвращает русский текст ошибки для показа пользователю. Маппит `ApiError.code`
 * на словарь; для `weak_password` разбирает причины; для rate-limit (429) отдаёт
 * уже русский `message` с бэкенда; на таймаут и 5xx — свои тексты «сервер не
 * ответил». Для всего остального — `fallback`, чтобы английский технический
 * текст никогда не попал в UI.
 *
 * Не-`ApiError` (сетевой `TypeError` при полном обрыве связи — api.ts
 * пробрасывает его как есть) тоже уходит в `fallback`: по нему не отличить
 * обрыв сети от ошибки в нашем же коде после ответа.
 */
export function localizeApiError(err: unknown, fallback: string = DEFAULT_FALLBACK): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.code === 'weak_password') return weakPasswordMessage(err.payload);
  const mapped = CODE_MESSAGES[err.code];
  if (mapped) return mapped;
  // Rate-limit и подобные ответы, где бэкенд уже прислал русский текст (не «HTTP N»).
  if (err.status === 429 && err.message && !/^HTTP\s/.test(err.message)) return err.message;
  if (err.code === 'timeout') return TIMEOUT_MESSAGE;
  if (err.status >= 500) return SERVER_UNAVAILABLE_MESSAGE;
  return fallback;
}
