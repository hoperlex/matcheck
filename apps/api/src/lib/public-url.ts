import { loadEnv } from './env.js';
import { HttpError } from './http-error.js';

const env = loadEnv();

/**
 * Построение ссылок, которые уходят людям наружу.
 *
 * Два режима намеренно разведены по уровню доверия к адресу.
 *
 * `buildPublicUrl` — для share-ссылок на приёмку: при отсутствии
 * PUBLIC_BASE_URL падает обратно на протокол и хост запроса. Так это работало
 * с самого появления share, и ссылка там даёт лишь read-only просмотр одной
 * карточки — подмена Host обесценивает саму ссылку, но ничем не угрожает.
 *
 * `buildTrustedUrl` — для ссылок на смену пароля. Фолбэка на Host нет вовсе:
 * такая ссылка задаёт пароль к учётной записи, и подделанный заголовок увёл бы
 * её на чужой домен вместе с доступом к аккаунту. Нет переменной — нет ссылки.
 */

function normalizedBase(): string | null {
  const base = env.PUBLIC_BASE_URL?.trim();
  return base ? base.replace(/\/$/, '') : null;
}

export function buildPublicUrl(
  req: { protocol: string; hostname: string },
  path: string,
): string {
  const base = normalizedBase();
  return base ? `${base}${path}` : `${req.protocol}://${req.hostname}${path}`;
}

export function buildTrustedUrl(path: string): string {
  const base = normalizedBase();
  if (!base) {
    // 500, а не 400: это дефект конфигурации сервера, а не запроса админа.
    // Текст без подробностей наружу не утекает — сообщения HttpError видит
    // только вызывающий администратор.
    throw new HttpError(
      500,
      'PUBLIC_BASE_URL не настроен — без него нельзя выдать ссылку на смену пароля',
    );
  }
  return `${base}${path}`;
}
