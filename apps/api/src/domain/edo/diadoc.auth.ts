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
import { ZodError } from 'zod';
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
import {
  DIADOC_ENDPOINTS,
  DiadocAuthExpired,
  DiadocAuthRejected,
  diadocFetch,
  type DiadocEnvironment,
  type DiadocRequestSnapshot,
} from './diadoc.http.js';

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
  /**
   * Снимок готового запроса за токеном. Нужен диагностике: при отказе снаружи
   * виден только ответ, а вопрос стоит о запросе.
   */
  onRequest?: (snapshot: DiadocRequestSnapshot) => void;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
};

/**
 * Объясняет, что не так с сохранёнными реквизитами, НЕ раскрывая значений.
 *
 * Из ZodError берутся только имена полей: в нём может лежать и само значение,
 * а это секрет. Пустая строка до сюда доезжает штатно — схема обрезает пробелы
 * и требует непустое, поэтому «поле осталось пустым» выглядит как ошибка
 * разбора.
 */
function credentialsProblem(err: unknown): string {
  if (err instanceof ZodError) {
    const fields = [...new Set(err.issues.map((i) => i.path.join('.')).filter(Boolean))];
    return fields.length
      ? `реквизиты учётной записи не проходят проверку (${fields.join(', ')}) — впишите значения заново в карточке`
      : 'реквизиты учётной записи не проходят проверку — впишите значения заново в карточке';
  }
  return 'реквизиты учётной записи не читаются — впишите значения заново в карточке';
}

/**
 * Читает реквизиты, переводя любую неудачу в понятную человеку причину.
 *
 * Без этого ошибка СВОЕЙ карточки доходила до администратора как «Диадок
 * ответил в неожиданном формате» (ZodError попадает в общую ветку разбора
 * ответов), то есть отправляла разбираться не в ту сторону.
 */
function readCredentials(row: EdoAccountAuthRow): EdoCredentials {
  try {
    const raw = decryptField(row.credentialsEncrypted, buildAad('edo_accounts', row.id));
    return StoredEdoCredentialsSchema.parse(JSON.parse(raw));
  } catch (err) {
    throw new DiadocAuthMisconfigured(credentialsProblem(err));
  }
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
    this.refreshSource = state?.refreshToken ? 'auth_state' : 'credentials';
    if (state?.accessToken && state.accessTokenExpiresAt) {
      this.accessToken = state.accessToken;
      this.accessTokenExpiresAt = state.accessTokenExpiresAt;
    }
  }

  private readonly clientId: string;
  private readonly clientSecret: string;
  /** Какой из двух источников дал токен. Нужен диагностике, см. снимок. */
  private readonly refreshSource: 'auth_state' | 'credentials';

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
      onRequest: this.deps.onRequest
        ? (snapshot) => this.deps.onRequest?.({ ...snapshot, refreshTokenSource: this.refreshSource })
        : undefined,
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
 * Префикс заведомо негодного токена для пробы.
 *
 * Настоящий refresh-токен так выглядеть не может, поэтому ни в журнале, ни в
 * снимке его не спутать с боевым значением.
 */
const PROBE_TOKEN_PREFIX = 'probe-not-a-token-';

/**
 * Итог пробы аутентификации приложения.
 *
 * `client_accepted` — сервис проверил пару client_id + ключ и перешёл к
 * проверке гранта; `client_rejected` — отверг саму пару либо способ её
 * передачи; `inconclusive` — ответ не даёт основания ни для одного вывода, и
 * выдавать его за доказательство нельзя.
 */
export type ClientAuthProbe =
  | { outcome: 'client_accepted'; code: string }
  | { outcome: 'client_rejected'; code: string }
  | { outcome: 'inconclusive'; reason: string };

/**
 * Проверяет ТОЛЬКО аутентификацию приложения, не расходуя refresh-токен.
 *
 * Зачем она нужна. `invalid_client` по стандарту покрывает и неверную пару
 * ключей, и негодный способ её передачи, а Диадок тем же кодом отвечает, когда
 * токен выпущен под другое приложение. Различить эти случаи по одному ответу
 * нельзя — а различать нужно, потому что действия у них противоположные.
 *
 * Приём опирается на порядок проверок в OAuth: клиент аутентифицируется до
 * проверки гранта. Значит, подставив заведомо негодный `refresh_token`, мы
 * узнаём судьбу ключей и не тратим настоящий токен. Это важно: при каждом
 * удачном обмене Диадок выдаёт новый refresh-токен, а прежний перестаёт
 * действовать, поэтому «проверить ещё раз по-настоящему» — значит потерять
 * доступ, если проверка вдруг удастся, а её результат никто не сохранит.
 *
 * Запрос собирается тем же кодом и теми же реквизитами, что и штатный обмен:
 * отличается ровно одно значение.
 */
export async function probeClientAuth(
  deps: DiadocAuthDeps,
  account: EdoAccountAuthRow,
): Promise<ClientAuthProbe> {
  const credentials = readCredentials(account);
  if (credentials.authMode !== 'oidc_refresh') {
    return { outcome: 'inconclusive', reason: 'учётная запись не на схеме OIDC' };
  }

  const endpoints = DIADOC_ENDPOINTS[account.environment];
  const url = new URL('/connect/token', endpoints.identity);

  try {
    await diadocFetch({
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: `${PROBE_TOKEN_PREFIX}${crypto.randomUUID()}`,
      }).toString(),
      timeoutMs: TOKEN_REQUEST_TIMEOUT_MS,
      // Повторять пробу незачем: ответ детерминирован, а лишние обращения к
      // сервису авторизации с негодным токеном выглядят как перебор.
      maxRetries: 0,
      fetchImpl: deps.fetchImpl,
      onRequest: deps.onRequest
        ? (snapshot) => deps.onRequest?.({ ...snapshot, probe: true })
        : undefined,
    });
    // Сервис выдал токен по недействительному значению. Вывода о ключах из
    // этого делать нельзя — только зафиксировать странность.
    return { outcome: 'inconclusive', reason: 'сервис принял заведомо негодный токен' };
  } catch (err) {
    if (err instanceof DiadocAuthRejected) {
      if (err.code === 'invalid_client') return { outcome: 'client_rejected', code: err.code };
      if (err.code === 'invalid_grant') return { outcome: 'client_accepted', code: err.code };
      return { outcome: 'inconclusive', reason: `ответ сервиса: ${err.code}` };
    }
    return {
      outcome: 'inconclusive',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Отвергает сохранённую маску вместо значения.
 *
 * Такое уже случалось: браузер подставил в поле своё, форма сохранилась, и в
 * базу легло не то, что видел администратор. Маска уходит в сеть и возвращается
 * как `invalid_client` — то есть дефект ввода выглядит как отказ Диадока, и
 * разбирательство уходит не туда.
 *
 * На пустоту здесь не проверяем намеренно: хранимые реквизиты описаны схемой
 * `z.string().trim().min(1)`, поэтому пустое значение сюда не доходит — чтение
 * отвергает его раньше. Такая ветка была бы недостижимой.
 */
function assertNotMasked(label: string, value: string): void {
  if (/^[*•●·]+$/.test(value.trim())) {
    throw new DiadocAuthMisconfigured(
      `вместо значения «${label}» сохранена маска — впишите значение заново`,
    );
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
  // Проверяем ИМЕННО то, что уйдёт в запрос: refresh-токен берётся из
  // состояния, когда оно есть, и только иначе — из реквизитов.
  assertNotMasked('идентификатор приложения (client_id)', credentials.clientId);
  assertNotMasked('ключ приложения (client_secret)', credentials.clientSecret);
  assertNotMasked('refresh-токен', state?.refreshToken ?? credentials.refreshToken);
  return new OidcRefreshAuth(deps, account, credentials, state);
}
