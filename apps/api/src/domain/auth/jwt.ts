import {
  generateKeyPair,
  exportPKCS8,
  exportSPKI,
  importPKCS8,
  importSPKI,
  SignJWT,
  jwtVerify,
} from 'jose';
import { loadEnv } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';

const ENV = loadEnv();
const ALG = 'EdDSA';

// jose returns CryptoKey | KeyObject depending on runtime — keep opaque.
type JoseKey = Parameters<typeof SignJWT.prototype.sign>[0];

type Keys = {
  privateKey: JoseKey;
  publicKey: JoseKey;
  privatePem: string;
  publicPem: string;
};

let cachedKeys: Keys | null = null;

export async function getJwtKeys(): Promise<Keys> {
  if (cachedKeys) return cachedKeys;

  if (ENV.JWT_PRIVATE_KEY_PEM && ENV.JWT_PUBLIC_KEY_PEM) {
    const privateKey = await importPKCS8(ENV.JWT_PRIVATE_KEY_PEM, ALG);
    const publicKey = await importSPKI(ENV.JWT_PUBLIC_KEY_PEM, ALG);
    cachedKeys = {
      privateKey,
      publicKey,
      privatePem: ENV.JWT_PRIVATE_KEY_PEM,
      publicPem: ENV.JWT_PUBLIC_KEY_PEM,
    };
    return cachedKeys;
  }

  if (ENV.NODE_ENV === 'production') {
    throw new Error('JWT_PRIVATE_KEY_PEM and JWT_PUBLIC_KEY_PEM must be set in production');
  }

  logger.warn('JWT keys not configured — generating ephemeral Ed25519 keypair for development');
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);
  cachedKeys = { privateKey, publicKey, privatePem, publicPem };
  return cachedKeys;
}

export type AccessTokenClaims = {
  sub: string;
  role: 'admin' | 'manager' | 'inspector_kpp' | 'contractor' | 'monitor' | 'observer';
  sid: string;
  aal: 'aal1' | 'aal2';
  // Issued-at (Unix-секунды). При подписи проставляется автоматически
  // (.setIssuedAt) и в claims не передаётся; заполняется при verify —
  // нужен для инвалидации сессий по времени выпуска (см. plugins/auth.ts).
  iat?: number;
};

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const { privateKey } = await getJwtKeys();
  return await new SignJWT({ role: claims.role, sid: claims.sid, aal: claims.aal })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuer(ENV.JWT_ISSUER)
    .setAudience(ENV.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ENV.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { publicKey } = await getJwtKeys();
  const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
    issuer: ENV.JWT_ISSUER,
    audience: ENV.JWT_AUDIENCE,
    algorithms: [ALG],
  });
  // Machine-токен внешней системы пользовательским не бывает ни при каких
  // настройках audience. Именно отказ по метке, а не требование метки у
  // пользовательских: уже выданные токены веба и планшетов typ не несут.
  if (protectedHeader.typ === MACHINE_TOKEN_TYP) {
    throw new Error('machine token is not a user access token');
  }
  return {
    sub: payload.sub as string,
    role: payload['role'] as AccessTokenClaims['role'],
    sid: payload['sid'] as string,
    aal: (payload['aal'] as AccessTokenClaims['aal']) ?? 'aal1',
    iat: payload.iat,
  };
}

// ─── Machine-токен внешней системы (docs/fin_auth.md §2) ──────────────────
//
// Отдельный audience и явная метка типа в заголовке (RFC 8725 §3.11): токен 1С
// не принимается пользовательской проверкой, а пользовательский — машинной,
// даже если кто-то выставит JWT_AUDIENCE равным машинному.

export const MACHINE_TOKEN_TYP = 'mc+jwt';
export const MACHINE_TOKEN_AUDIENCE = 'matcheck-integration';
export const MACHINE_TOKEN_TTL_SECONDS = 600;

export type MachineTokenClaims = {
  /** id строки service_accounts. */
  sub: string;
  scopes: string[];
  /** service_accounts.secret_generation на момент выдачи. */
  gen: number;
};

export async function signMachineToken(claims: MachineTokenClaims): Promise<string> {
  const { privateKey } = await getJwtKeys();
  return await new SignJWT({ scope: claims.scopes.join(' '), gen: claims.gen })
    .setProtectedHeader({ alg: ALG, typ: MACHINE_TOKEN_TYP })
    .setSubject(claims.sub)
    .setIssuer(ENV.JWT_ISSUER)
    .setAudience(MACHINE_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MACHINE_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

export async function verifyMachineToken(token: string): Promise<MachineTokenClaims> {
  const { publicKey } = await getJwtKeys();
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ENV.JWT_ISSUER,
    audience: MACHINE_TOKEN_AUDIENCE,
    algorithms: [ALG],
    typ: MACHINE_TOKEN_TYP,
  });
  const gen = payload['gen'];
  const scope = payload['scope'];
  if (typeof payload.sub !== 'string' || typeof gen !== 'number' || typeof scope !== 'string') {
    throw new Error('malformed machine token');
  }
  return { sub: payload.sub, gen, scopes: scope.split(' ').filter(Boolean) };
}
