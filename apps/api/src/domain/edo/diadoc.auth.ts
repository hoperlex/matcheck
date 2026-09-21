/**
 * Авторизация в Диадоке по OpenID Connect (Refresh Token Flow).
 *
 * Почему именно этот алгоритм. Client Credentials Диадок не поддерживает: для
 * выпуска токенов нужен первичный пользовательский контекст. Refresh Token Flow
 * документация прямо называет подходящим для роботизированных приложений —
 * человек один раз получает refresh_token в Кабинете интегратора под сервисной
 * учётной записью, дальше приложение работает само.
 *
 * ГЛАВНАЯ ОПАСНОСТЬ этого модуля — потеря refresh_token. Он живёт 30 дней,
 * счётчик продлевается при каждом использовании, а восстановить его можно
 * только руками через браузер. Поэтому здесь три правила, каждое из которых
 * существует ради конкретного способа его потерять:
 *
 *   1. Если в ответе пришёл НОВЫЙ refresh_token, он сохраняется ДО того, как мы
 *      воспользуемся полученным access_token. Иначе падение между «обменяли» и
 *      «сохранили» оставит в базе токен, который сервер уже отозвал.
 *   2. Запись идёт через compare-and-swap по auth_state_version. Ноль
 *      обновлённых строк означает, что состояние поменял кто-то другой, и тогда
 *      мы НЕ перетираем его своим, а прекращаем работу.
 *   3. Обмен выполняется под лизом учётной записи (его берёт вызывающий код).
 *      Два параллельных обмена одного токена закончились бы тем, что один из
 *      них остался бы с отозванным значением.
 */
import { eq, and, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { edoAccounts } from '../../db/schema.js';
import { buildAad, decryptField, encryptToString } from '../auth/crypto.js';
import {
  EdoAuthStateSchema,
  StoredEdoCredentialsSchema,
  type EdoAuthState,
  type EdoCredentials,
} from '@matcheck/contracts';
import { DIADOC_ENDPOINTS, DiadocAuthExpired, diadocFetch, type DiadocEnvironment } from './diadoc.http.js';

/** Запас до истечения access_token: обновляем заранее, а не в последний миг. */
const ACCESS_TOKEN_SAFETY_MS = 60 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

/** Состояние учётной записи изменил кто-то другой — свою запись отменяем. */
export class DiadocAuthConflict extends Error {
  constructor() {
    super(
      'Diadoc: состояние авторизации изменено параллельно — проход прекращён, чтобы не потерять refresh_token',
    );
    this.name = 'DiadocAuthConflict';
  }
}

/** Учётная запись настроена так, что работать нечем. */
export class DiadocAuthMisconfigured extends Error {
  constructor(message: string) {
    super(`Diadoc: ${message}`);
    this.name = 'DiadocAuthMisconfigured';
  }
}

export type EdoAccountAuthRow = {
  id: string;
  authMode: 'oidc_refresh' | 'developer_key';
  environment: DiadocEnvironment;
  credentialsEncrypted: string;
  authStateEncrypted: string | null;
  authStateVersion: number;
};

export interface DiadocAuth {
  /** Готовый заголовок Authorization. Обновляет токен, когда пора. */
  header(): Promise<string>;
  /** Сбросить кеш после 401: следующий header() переавторизуется. */
  invalidate(): void;
}

export type DiadocAuthDeps = {
  db: Db;
  now?: () => number;
  fetchImpl?: typeof fetch;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
};

function readCredentials(row: EdoAccountAuthRow): EdoCredentials {
  const raw = decryptField(row.credentialsEncrypted, buildAad('edo_accounts', row.id));
  return StoredEdoCredentialsSchema.parse(JSON.parse(raw));
}

function readAuthState(row: EdoAccountAuthRow): EdoAuthState | null {
  if (!row.authStateEncrypted) return null;
  const raw = decryptField(row.authStateEncrypted, buildAad('edo_accounts', row.id));
  return EdoAuthStateSchema.parse(JSON.parse(raw));
}

/**
 * Сохраняет состояние авторизации, если его никто не менял.
 *
 * Возвращает новую версию либо бросает DiadocAuthConflict. Версия нужна
 * вызывающему, чтобы следующий обмен тоже шёл по актуальному значению.
 */
async function saveAuthStateCas(
  db: Db,
  accountId: string,
  expectedVersion: number,
  state: EdoAuthState,
  refreshTokenUsedAt: Date,
): Promise<number> {
  const encrypted = encryptToString(JSON.stringify(state), buildAad('edo_accounts', accountId));
  const updated = await db
    .update(edoAccounts)
    .set({
      authStateEncrypted: encrypted,
      authStateVersion: expectedVersion + 1,
      refreshTokenUsedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(edoAccounts.id, accountId),
        sql`${edoAccounts.authStateVersion} = ${expectedVersion}`,
      ),
    )
    .returning({ version: edoAccounts.authStateVersion });

  if (updated.length === 0) throw new DiadocAuthConflict();
  return expectedVersion + 1;
}

/**
 * Авторизация по OIDC.
 *
 * Экземпляр живёт в пределах одного прохода: кеш access_token в памяти
 * сокращает обращения к identity, но состоянием истины остаётся база.
 */
class OidcRefreshAuth implements DiadocAuth {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private version: number;
  private refreshToken: string;

  constructor(
    private readonly deps: DiadocAuthDeps,
    private readonly account: EdoAccountAuthRow,
    credentials: Extract<EdoCredentials, { authMode: 'oidc_refresh' }>,
    state: EdoAuthState | null,
  ) {
    this.clientId = credentials.clientId;
    this.clientSecret = credentials.clientSecret;
    this.version = account.authStateVersion;
    // Первичный refresh_token лежит в credentials; всё, что пришло позже, — в
    // состоянии. Состояние приоритетнее: оно и есть актуальное значение.
    this.refreshToken = state?.refreshToken ?? credentials.refreshToken;
    if (state?.accessToken && state.accessTokenExpiresAt) {
      this.accessToken = state.accessToken;
      this.accessTokenExpiresAt = state.accessTokenExpiresAt;
    }
  }

  private readonly clientId: string;
  private readonly clientSecret: string;

  invalidate(): void {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async header(): Promise<string> {
    const now = this.deps.now?.() ?? Date.now();
    if (this.accessToken && this.accessTokenExpiresAt - now > ACCESS_TOKEN_SAFETY_MS) {
      return `Bearer ${this.accessToken}`;
    }
    await this.exchange(now);
    return `Bearer ${this.accessToken}`;
  }

  private async exchange(now: number): Promise<void> {
    const endpoints = DIADOC_ENDPOINTS[this.account.environment];
    const url = new URL('/connect/token', endpoints.identity);

    const res = await diadocFetch({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      }).toString(),
      timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
      fetchImpl: this.deps.fetchImpl,
    });

    const body = (await res.json()) as TokenResponse;
    if (!body.access_token) {
      throw new DiadocAuthExpired('сервер не вернул access_token');
    }

    const expiresInMs = (body.expires_in ?? 86_400) * 1000;
    const nextState: EdoAuthState = {
      // Новый refresh приходит не всегда: в Refresh Token Flow сервер может
      // вернуть тот же самый. Подставляем прежний только если нового нет.
      refreshToken: body.refresh_token ?? this.refreshToken,
      accessToken: body.access_token,
      accessTokenExpiresAt: now + expiresInMs,
    };

    // ВАЖЕН ПОРЯДОК: сначала сохранить, потом пользоваться. Между обменом и
    // записью сервер уже считает прежний refresh_token недействительным.
    this.version = await saveAuthStateCas(
      this.deps.db,
      this.account.id,
      this.version,
      nextState,
      new Date(now),
    );

    this.refreshToken = nextState.refreshToken;
    this.accessToken = nextState.accessToken ?? null;
    this.accessTokenExpiresAt = nextState.accessTokenExpiresAt ?? 0;
  }
}

/**
 * Собирает механизм авторизации для учётной записи.
 *
 * Вызывающий обязан держать лиз учётной записи: обмен refresh_token не терпит
 * параллельных попыток.
 */
export function createDiadocAuth(deps: DiadocAuthDeps, account: EdoAccountAuthRow): DiadocAuth {
  const credentials = readCredentials(account);

  if (credentials.authMode !== 'oidc_refresh') {
    // Ключи разработчика старого образца новым интеграциям не выдают, поэтому
    // кода под них нет. Значение в схеме существует, чтобы появление такой
    // учётной записи не требовало миграции.
    throw new DiadocAuthMisconfigured(
      'учётная запись настроена на ключ разработчика — эта схема не реализована, используйте OIDC',
    );
  }

  const state = readAuthState(account);
  return new OidcRefreshAuth(deps, account, credentials, state);
}
