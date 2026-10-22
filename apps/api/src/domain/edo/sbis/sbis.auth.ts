/**
 * Вход в СБИС.
 *
 * Основной способ — ключи приложения: `POST /oauth/service/` с тремя значениями
 * из карточки стороннего приложения. Справка
 * (https://saby.ru/help/integration/api/auth/service/) требует все три:
 * `app_client_id` («ID приложения»), `app_secret` («Защищённый ключ») и
 * `secret_key` («Сервисный ключ»). В ответе гарантирован только `token`, он
 * идёт в заголовок `X-SBISAccessToken`. Сессии (`sid`) этот способ не обещает,
 * поэтому подмены заголовка на `X-SBISSessionID` в этом режиме нет.
 *
 * Запасной способ — логин и пароль сервисного пользователя:
 * `СБИС.Аутентифицировать` → строка сессии → `X-SBISSessionID`. Для фоновой
 * работы хуже: бывает подтверждение по SMS, сессий не больше пяти.
 *
 * Вход повторяется один раз и только при сетевом сбое: у СБИС лимит 300 входов
 * в минуту с адреса, за превышение — блокировка на 20 минут.
 */
import {
  SBIS_URLS,
  SbisAuthRejected,
  readSbisBody,
  sbisFetch,
  sbisRpc,
  type SbisTransportOptions,
} from './sbis.http.js';

export type SbisKeyCredentials = { appClientId: string; appSecret: string; secretKey: string };
export type SbisPasswordCredentials = { login: string; password: string };

export type SbisSession = {
  mode: 'key' | 'password';
  headers: Record<string, string>;
  /** Всё, что нельзя показать в тексте ошибок: ключи, пароль, токен. */
  secrets: string[];
};

type AuthDeps = Pick<SbisTransportOptions, 'fetchImpl' | 'sleep' | 'timeoutMs'>;

const LOGIN_RETRY: Pick<SbisTransportOptions, 'maxRetries' | 'retryOn'> = {
  maxRetries: 1,
  retryOn: 'network',
};

/** Каких значений не хватает для входа по ключу — по именам переменных, без значений. */
export function missingKeyFields(creds: Partial<SbisKeyCredentials>): string[] {
  const missing: string[] = [];
  if (!creds.appClientId?.trim()) missing.push('SBIS_APP_CLIENT_ID («ID подключения»)');
  if (!creds.appSecret?.trim()) missing.push('SBIS_APP_SECRET («Защищённый ключ»)');
  if (!creds.secretKey?.trim()) missing.push('SBIS_SECRET_KEY («Сервисный ключ»)');
  return missing;
}

export async function loginByKey(creds: SbisKeyCredentials, deps: AuthDeps = {}): Promise<SbisSession> {
  const missing = missingKeyFields(creds);
  if (missing.length) throw new Error(`СБИС: для входа по ключу не заданы ${missing.join(', ')}`);
  const appClientId = creds.appClientId.trim();
  const appSecret = creds.appSecret.trim();
  const secretKey = creds.secretKey.trim();
  const secrets = [appClientId, appSecret, secretKey];

  const url = new URL(SBIS_URLS.oauth);
  const res = await sbisFetch({
    ...deps,
    ...LOGIN_RETRY,
    secrets,
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_client_id: appClientId, app_secret: appSecret, secret_key: secretKey }),
  });
  const raw = await readSbisBody(res, 64 * 1024, url);
  let token: unknown;
  try {
    token = (JSON.parse(raw.toString('utf8')) as { token?: unknown })?.token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || !token.trim()) {
    throw new SbisAuthRejected('в ответе нет поля token');
  }
  return {
    mode: 'key',
    headers: { 'X-SBISAccessToken': token.trim() },
    secrets: [...secrets, token.trim()],
  };
}

export async function loginByPassword(
  creds: SbisPasswordCredentials,
  deps: AuthDeps = {},
): Promise<SbisSession> {
  const login = creds.login?.trim();
  const password = creds.password ?? '';
  if (!login || !password) throw new Error('СБИС: для входа по логину не заданы SBIS_LOGIN и SBIS_PASSWORD');
  const secrets = [login, password];

  const result = await sbisRpc({
    ...deps,
    ...LOGIN_RETRY,
    secrets,
    url: new URL(SBIS_URLS.auth),
    rpcMethod: 'СБИС.Аутентифицировать',
    params: { Параметр: { Логин: login, Пароль: password } },
    maxBytes: 64 * 1024,
  });
  if (typeof result !== 'string' || !result.trim()) {
    throw new SbisAuthRejected('в ответе нет идентификатора сессии');
  }
  return {
    mode: 'password',
    headers: { 'X-SBISSessionID': result.trim() },
    secrets: [...secrets, result.trim()],
  };
}
