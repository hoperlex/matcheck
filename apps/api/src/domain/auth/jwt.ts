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
  role: 'admin' | 'manager' | 'inspector_kpp' | 'contractor';
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
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: ENV.JWT_ISSUER,
    audience: ENV.JWT_AUDIENCE,
    algorithms: [ALG],
  });
  return {
    sub: payload.sub as string,
    role: payload['role'] as AccessTokenClaims['role'],
    sid: payload['sid'] as string,
    aal: (payload['aal'] as AccessTokenClaims['aal']) ?? 'aal1',
    iat: payload.iat,
  };
}
