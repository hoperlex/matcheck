/**
 * Машинные учётки внешних систем (docs/fin_auth.md §2, «portal-to-portal»).
 *
 * Схема: client_id + секрет → короткий machine JWT (10 минут, без refresh) →
 * Bearer на /api/v1/integration/*. В базе лежит только sha256 секрета: секрет
 * 256-битный случайный, перебор по хешу бессмыслен, bcrypt тут ничего не даёт.
 *
 * Что проверяется на КАЖДОМ запросе с токеном (а не только при выдаче): учётка
 * активна и не отозвана, поколение секрета совпадает с claim gen, адрес входит в
 * разрешённые сети. Поэтому отзыв и ротация действуют мгновенно, а не через
 * 10 минут жизни уже выданного токена.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { and, eq, isNull, lt, or, sql as drSql } from 'drizzle-orm';
import {
  API_SCOPES,
  SCOPE_ONEC_ACK,
  SCOPE_ONEC_READ,
  type ApiKeyDto,
  type ApiKeyStatus,
} from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { authEvents, serviceAccounts } from '../../db/schema.js';
import { sha256Hex } from './crypto.js';
import {
  MACHINE_TOKEN_TTL_SECONDS,
  signMachineToken,
  verifyMachineToken,
} from './jwt.js';

// Права и подписи живут в контрактах: их видит и вкладка «API-доступ».
export { SCOPE_ONEC_ACK, SCOPE_ONEC_READ };
export const KNOWN_SCOPES = API_SCOPES;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type ServiceAccountRow = typeof serviceAccounts.$inferSelect;

export type ServicePrincipal = {
  id: string;
  clientId: string;
  scopes: string[];
};

/** Новый секрет: 256 бит, префикс помогает узнать его в утечке и в сканерах. */
export function generateClientSecret(): string {
  return `mcs_${randomBytes(32).toString('base64url')}`;
}

export function hashClientSecret(secret: string): string {
  return sha256Hex(secret);
}

// Хеш, с которым сравнивается секрет неизвестного client_id: сравнение идёт
// всегда, и по времени ответа нельзя понять, существует ли учётка.
const DUMMY_HASH = sha256Hex('matcheck:no-such-client');

function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== 32 || bb.length !== 32) return false;
  return timingSafeEqual(ba, bb);
}

/** Запись сети «адрес[/биты]»; null — не разбирается. */
export function parseCidr(raw: string): { net: string; bits: number; family: 'ipv4' | 'ipv6' } | null {
  const [net, bitsRaw, extra] = raw.trim().split('/');
  if (!net || extra !== undefined) return null;
  const netFamily = isIP(net);
  if (netFamily === 0) return null;
  const max = netFamily === 4 ? 32 : 128;
  if (bitsRaw !== undefined && !/^\d{1,3}$/.test(bitsRaw)) return null;
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (bits < 0 || bits > max) return null;
  return { net, bits, family: netFamily === 4 ? 'ipv4' : 'ipv6' };
}

/**
 * Адрес в разрешённых сетях. NULL/пустой список — без ограничения.
 *
 * IPv4, пришедший как IPv4-mapped IPv6 (`::ffff:1.2.3.4`), сравнивается как
 * IPv4: так его отдаёт Node при dual-stack сокете. Неразборчивая запись CIDR —
 * отказ, а не «пропустить»: ошибка в настройке не должна открывать доступ.
 */
export function ipAllowed(ip: string, cidrs: readonly string[] | null): boolean {
  if (!cidrs || cidrs.length === 0) return true;
  const addr = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(addr);
  if (family === 0) return false;
  const list = new BlockList();
  for (const raw of cidrs) {
    const cidr = parseCidr(raw);
    if (!cidr) return false;
    list.addSubnet(cidr.net, cidr.bits, cidr.family);
  }
  return list.check(addr, family === 4 ? 'ipv4' : 'ipv6');
}

export type IssueTokenInput = {
  clientId: string;
  clientSecret: string;
  ip: string;
  userAgent: string | null;
};

export type IssueTokenResult =
  | { ok: true; accessToken: string; expiresIn: number; scopes: string[] }
  | { ok: false; reason: 'invalid_client' | 'inactive' | 'expired' | 'network' };

/** Срок действия ключа истёк. NULL — бессрочный. */
function isExpired(expiresAt: Date | null, now = Date.now()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now;
}

/**
 * Выдача machine-токена. Наружу любая неудача — одна ошибка invalid_client;
 * reason нужен журналу (auth_events), не ответу.
 */
export async function issueMachineToken(db: Db, input: IssueTokenInput): Promise<IssueTokenResult> {
  const [account] = await db
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.clientId, input.clientId))
    .limit(1);
  const secretOk = hashesEqual(
    hashClientSecret(input.clientSecret),
    account?.secretHash ?? DUMMY_HASH,
  );

  let result: IssueTokenResult;
  if (!account || !secretOk) {
    result = { ok: false, reason: 'invalid_client' };
  } else if (!account.isActive || account.revokedAt) {
    result = { ok: false, reason: 'inactive' };
  } else if (isExpired(account.expiresAt)) {
    result = { ok: false, reason: 'expired' };
  } else if (!ipAllowed(input.ip, account.allowedCidrs)) {
    result = { ok: false, reason: 'network' };
  } else {
    const accessToken = await signMachineToken({
      sub: account.id,
      scopes: account.scopes,
      gen: account.secretGeneration,
    });
    await db
      .update(serviceAccounts)
      .set({ lastTokenAt: new Date(), lastTokenIp: input.ip.slice(0, 64) })
      .where(eq(serviceAccounts.id, account.id));
    result = {
      ok: true,
      accessToken,
      expiresIn: MACHINE_TOKEN_TTL_SECONDS,
      scopes: account.scopes,
    };
  }

  // Аудит выдачи — требование fin_auth. client_id пишем только для
  // существующей учётки: перебор чужих имён не должен забивать журнал мусором,
  // но и следа «кто-то стучался» достаточно (ip + причина).
  try {
    await db.insert(authEvents).values({
      userId: null,
      event: result.ok ? 'machine_token_issued' : 'machine_token_denied',
      ip: input.ip.slice(0, 64),
      userAgent: input.userAgent,
      meta: {
        clientId: account ? account.clientId : null,
        ...(result.ok ? {} : { reason: result.reason }),
      },
    });
  } catch {
    // Журнал не должен ронять выдачу; отказ записи виден в логах БД.
  }
  return result;
}

/**
 * Принципал по Bearer-токену. null — любой отказ (подпись, срок, audience, тип,
 * учётка неактивна или отозвана, сменилось поколение секрета, чужая сеть).
 */
export async function resolveServicePrincipal(
  db: Db,
  token: string,
  ip: string,
): Promise<ServicePrincipal | null> {
  let claims;
  try {
    claims = await verifyMachineToken(token);
  } catch {
    return null;
  }
  const [account] = await db
    .select({
      id: serviceAccounts.id,
      clientId: serviceAccounts.clientId,
      scopes: serviceAccounts.scopes,
      isActive: serviceAccounts.isActive,
      revokedAt: serviceAccounts.revokedAt,
      secretGeneration: serviceAccounts.secretGeneration,
      allowedCidrs: serviceAccounts.allowedCidrs,
      expiresAt: serviceAccounts.expiresAt,
      lastUsedAt: serviceAccounts.lastUsedAt,
    })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, claims.sub))
    .limit(1);
  if (!account || !account.isActive || account.revokedAt) return null;
  // Срок — на каждом запросе: истёкший ключ перестаёт работать сразу, а не
  // когда истечёт уже выданный токен.
  if (isExpired(account.expiresAt)) return null;
  if (account.secretGeneration !== claims.gen) return null;
  if (!ipAllowed(ip, account.allowedCidrs)) return null;
  touchLastUsed(db, account.id, account.lastUsedAt);
  // Права — пересечение выданного в токене и текущего у учётки: сужение прав
  // учётки действует сразу, не дожидаясь истечения токена.
  const current = new Set(account.scopes);
  return {
    id: account.id,
    clientId: account.clientId,
    scopes: claims.scopes.filter((s) => current.has(s)),
  };
}

// ─── «Последний запрос» ────────────────────────────────────────────────────

/** Чаще раза в минуту время обращения не пишем: канал опрашивают постоянно. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Отметка последнего обращения — не чаще LAST_USED_RESOLUTION_MS.
 *
 * Свежая отметка, прочитанная тем же SELECT, что проверяет ключ, — и записи нет
 * вовсе. Иначе условный UPDATE: если два процесса решили писать одновременно,
 * второй ничего не изменит. Ответ не ждём и ошибку глотаем — отметка служебная и
 * не должна ни задерживать, ни ронять запрос 1С.
 */
function touchLastUsed(db: Db, id: string, lastUsedAt: Date | null): void {
  if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_RESOLUTION_MS) return;
  db.update(serviceAccounts)
    .set({ lastUsedAt: drSql`clock_timestamp()` })
    .where(
      and(
        eq(serviceAccounts.id, id),
        or(
          isNull(serviceAccounts.lastUsedAt),
          lt(
            serviceAccounts.lastUsedAt,
            drSql`clock_timestamp() - make_interval(secs => ${LAST_USED_RESOLUTION_MS / 1000})`,
          ),
        ),
      ),
    )
    .then(
      () => undefined,
      () => undefined,
    );
}

// ─── Управление ключами (вкладка «API-доступ» и scripts/service-accounts.ts) ──
//
// Все функции работают внутри транзакции вызывающего: страница пишет туда же
// запись журнала (auth_events), и сбой журнала откатывает само изменение.
// Секрет функции НЕ генерируют — его передаёт вызывающий. Так командная строка
// сохраняет прежний порядок «секрет → новый файл → база»: если файл записать
// не удалось, база не тронута и старый секрет продолжает работать.

export type ServiceAccountErrorCode =
  | 'not_found'
  | 'revoked'
  | 'generation_changed'
  | 'client_id_taken'
  | 'invalid_client_id'
  | 'invalid_scopes'
  | 'invalid_cidr';

export class ServiceAccountError extends Error {
  constructor(readonly code: ServiceAccountErrorCode, message: string) {
    super(message);
  }
}

const CLIENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** client_id для ключа из портала: «api-» + 48 случайных бит. */
export function generateClientId(): string {
  return `api-${randomBytes(6).toString('hex')}`;
}

export function validateScopes(scopes: readonly string[]): string[] {
  const unique = [...new Set(scopes)];
  const unknown = unique.filter((s) => !(KNOWN_SCOPES as readonly string[]).includes(s));
  if (unique.length === 0 || unknown.length > 0) {
    throw new ServiceAccountError(
      'invalid_scopes',
      unique.length === 0 ? 'нужно хотя бы одно право' : `неизвестные права: ${unknown.join(', ')}`,
    );
  }
  return unique;
}

/** null/пустой список — без ограничения; битая запись — ошибка, а не «пропустить». */
export function validateCidrs(cidrs: readonly string[] | null | undefined): string[] | null {
  if (!cidrs || cidrs.length === 0) return null;
  const list = cidrs.map((c) => c.trim()).filter(Boolean);
  const bad = list.filter((c) => parseCidr(c) === null);
  if (bad.length > 0) {
    throw new ServiceAccountError('invalid_cidr', `не сеть: ${bad.map((c) => `«${c}»`).join(', ')}`);
  }
  return list.length > 0 ? list : null;
}

/** Права по галочке «Разрешить подтверждение загрузки»; прочие права не трогаем. */
export function scopesWithAck(current: readonly string[], allowAck: boolean): string[] {
  const rest = current.filter((s) => s !== SCOPE_ONEC_ACK);
  const base = rest.includes(SCOPE_ONEC_READ) ? rest : [SCOPE_ONEC_READ, ...rest];
  return allowAck ? [...base, SCOPE_ONEC_ACK] : base;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export type CreateServiceAccountInput = {
  /** Задан — берётся как есть (командная строка); нет — генерируется. */
  clientId?: string;
  name: string;
  description?: string | null;
  scopes: readonly string[];
  allowedCidrs?: readonly string[] | null;
  expiresAt?: Date | null;
  createdByUserId?: string | null;
  secret: string;
};

export async function createServiceAccount(
  tx: Tx,
  input: CreateServiceAccountInput,
): Promise<ServiceAccountRow> {
  const scopes = validateScopes(input.scopes);
  const allowedCidrs = validateCidrs(input.allowedCidrs);
  if (input.clientId !== undefined && !CLIENT_ID_RE.test(input.clientId)) {
    throw new ServiceAccountError(
      'invalid_client_id',
      'client_id: латиница в нижнем регистре, цифры, _ и -, от 2 до 64 символов',
    );
  }
  const attempts = input.clientId !== undefined ? 1 : 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const clientId = input.clientId ?? generateClientId();
    try {
      // Точка сохранения: дубль client_id не должен обрывать транзакцию
      // вызывающего — после него ещё повтор и запись журнала.
      const [row] = await tx.transaction((sp) =>
        sp
          .insert(serviceAccounts)
          .values({
            clientId,
            name: input.name,
            description: input.description ?? null,
            scopes,
            allowedCidrs,
            expiresAt: input.expiresAt ?? null,
            createdByUserId: input.createdByUserId ?? null,
            secretHash: hashClientSecret(input.secret),
          })
          .returning(),
      );
      return row!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (attempt === attempts) {
        throw new ServiceAccountError('client_id_taken', `client_id «${clientId}» уже занят`);
      }
    }
  }
  throw new ServiceAccountError('client_id_taken', 'не удалось подобрать свободный client_id');
}

async function readForError(tx: Tx, id: string): Promise<ServiceAccountRow> {
  const [row] = await tx.select().from(serviceAccounts).where(eq(serviceAccounts.id, id)).limit(1);
  if (!row) throw new ServiceAccountError('not_found', 'ключа нет');
  return row;
}

function isRevokedRow(row: Pick<ServiceAccountRow, 'isActive' | 'revokedAt'>): boolean {
  return row.revokedAt !== null || !row.isActive;
}

/**
 * Новый секрет: поколение +1, выданные токены и старый секрет перестают
 * действовать сразу. expectedGeneration (страница) — защита от двойного нажатия
 * и одновременной ротации: условный UPDATE, второй получит generation_changed.
 */
export async function rotateServiceAccountSecret(
  tx: Tx,
  id: string,
  opts: { secret: string; expectedGeneration?: number },
): Promise<ServiceAccountRow> {
  const conditions = [
    eq(serviceAccounts.id, id),
    isNull(serviceAccounts.revokedAt),
    eq(serviceAccounts.isActive, true),
  ];
  if (opts.expectedGeneration !== undefined) {
    conditions.push(eq(serviceAccounts.secretGeneration, opts.expectedGeneration));
  }
  const [row] = await tx
    .update(serviceAccounts)
    .set({
      secretHash: hashClientSecret(opts.secret),
      secretGeneration: drSql`${serviceAccounts.secretGeneration} + 1`,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning();
  if (row) return row;
  const current = await readForError(tx, id);
  if (isRevokedRow(current)) throw new ServiceAccountError('revoked', 'ключ отозван');
  throw new ServiceAccountError(
    'generation_changed',
    'секрет уже заменён — обновите список и повторите',
  );
}

/**
 * Отзыв навсегда. Повторный отзыв строку не трогает: первоначальное revoked_at
 * сохраняется, changed=false — вызывающий не пишет второе событие в журнал.
 */
export async function revokeServiceAccount(
  tx: Tx,
  id: string,
): Promise<{ row: ServiceAccountRow; changed: boolean }> {
  const [row] = await tx
    .update(serviceAccounts)
    .set({ isActive: false, revokedAt: drSql`clock_timestamp()`, updatedAt: new Date() })
    .where(and(eq(serviceAccounts.id, id), isNull(serviceAccounts.revokedAt)))
    .returning();
  if (row) return { row, changed: true };
  return { row: await readForError(tx, id), changed: false };
}

export type UpdateServiceAccountPatch = {
  name?: string;
  description?: string | null;
  allowAck?: boolean;
  expiresAt?: Date | null;
  /** Только командная строка (set-cidr); страница сети не меняет. */
  allowedCidrs?: readonly string[] | null;
};

/** Правка только переданных полей. Отозванный ключ — revoked. */
export async function updateServiceAccount(
  tx: Tx,
  id: string,
  patch: UpdateServiceAccountPatch,
): Promise<{ row: ServiceAccountRow; changed: string[] }> {
  const [current] = await tx
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.id, id))
    .for('update')
    .limit(1);
  if (!current) throw new ServiceAccountError('not_found', 'ключа нет');
  if (isRevokedRow(current)) throw new ServiceAccountError('revoked', 'ключ отозван');

  const set: Partial<typeof serviceAccounts.$inferInsert> = {};
  const changed: string[] = [];
  if (patch.name !== undefined && patch.name !== current.name) {
    set.name = patch.name;
    changed.push('name');
  }
  if (patch.description !== undefined && (patch.description || null) !== current.description) {
    set.description = patch.description || null;
    changed.push('description');
  }
  if (patch.allowAck !== undefined) {
    const scopes = scopesWithAck(current.scopes, patch.allowAck);
    if (scopes.join(',') !== current.scopes.join(',')) {
      set.scopes = validateScopes(scopes);
      changed.push('scopes');
    }
  }
  if (patch.expiresAt !== undefined) {
    const before = current.expiresAt?.getTime() ?? null;
    const after = patch.expiresAt?.getTime() ?? null;
    if (before !== after) {
      set.expiresAt = patch.expiresAt;
      changed.push('expiresAt');
    }
  }
  if (patch.allowedCidrs !== undefined) {
    const cidrs = validateCidrs(patch.allowedCidrs);
    if ((cidrs ?? []).join(',') !== (current.allowedCidrs ?? []).join(',')) {
      set.allowedCidrs = cidrs;
      changed.push('allowedCidrs');
    }
  }
  if (changed.length === 0) return { row: current, changed };
  const [row] = await tx
    .update(serviceAccounts)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(serviceAccounts.id, id))
    .returning();
  return { row: row!, changed };
}

export async function findServiceAccountByClientId(
  db: Db | Tx,
  clientId: string,
): Promise<ServiceAccountRow | null> {
  const [row] = await db
    .select()
    .from(serviceAccounts)
    .where(eq(serviceAccounts.clientId, clientId))
    .limit(1);
  return row ?? null;
}

// ─── Вид для вкладки «API-доступ» ──────────────────────────────────────────

export function serviceAccountStatus(
  row: Pick<ServiceAccountRow, 'isActive' | 'revokedAt' | 'expiresAt'>,
  now = Date.now(),
): ApiKeyStatus {
  if (isRevokedRow(row)) return 'revoked';
  if (isExpired(row.expiresAt, now)) return 'expired';
  return 'active';
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** DTO ключа. Хеш секрета наружу не уходит никогда. */
export function toApiKeyDto(row: ServiceAccountRow, createdByName: string | null): ApiKeyDto {
  const used = [row.lastUsedAt, row.lastTokenAt].filter((d): d is Date => d !== null);
  const lastUsed = used.length > 0 ? new Date(Math.max(...used.map((d) => d.getTime()))) : null;
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    description: row.description,
    scopes: row.scopes,
    allowAck: row.scopes.includes(SCOPE_ONEC_ACK),
    allowedCidrs: row.allowedCidrs,
    status: serviceAccountStatus(row),
    createdAt: row.createdAt.toISOString(),
    createdByName,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    lastUsedAt: iso(lastUsed),
    lastTokenIp: row.lastTokenIp,
    secretGeneration: row.secretGeneration,
  };
}
