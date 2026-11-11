/**
 * Изоляция machine-токена от пользовательского — каждая проверка отдельно.
 *
 * audience и метка типа дублируют друг друга, и тест «пользовательский JWT в
 * канал не пускают» проходит, даже если одну из них снять. Поэтому здесь —
 * токены нашим же ключом, у которых совпадает ровно одно из двух: снятие любой
 * проверки роняет свой тест.
 */
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  getJwtKeys,
  MACHINE_TOKEN_AUDIENCE,
  MACHINE_TOKEN_TYP,
  signMachineToken,
  verifyAccessToken,
  verifyMachineToken,
} from '../src/domain/auth/jwt.js';
import { loadEnv } from '../src/lib/env.js';

const ENV = loadEnv();

async function forge(opts: { typ?: string; aud: string; claims?: Record<string, unknown> }) {
  const { privateKey } = await getJwtKeys();
  return new SignJWT({ scope: 'onec.deliveries:read', gen: 1, role: 'admin', sid: 's', aal: 'aal1', ...opts.claims })
    .setProtectedHeader({ alg: 'EdDSA', ...(opts.typ ? { typ: opts.typ } : {}) })
    .setSubject('11111111-1111-4111-8111-111111111111')
    .setIssuer(ENV.JWT_ISSUER)
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('machine-токен', () => {
  it('настоящий проходит машинную проверку', async () => {
    const t = await signMachineToken({ sub: 'x', scopes: ['onec.deliveries:read'], gen: 3 });
    expect(await verifyMachineToken(t)).toEqual({ sub: 'x', scopes: ['onec.deliveries:read'], gen: 3 });
  });

  it('машинный audience без метки типа — отказ (стережёт проверку typ)', async () => {
    await expect(verifyMachineToken(await forge({ aud: MACHINE_TOKEN_AUDIENCE }))).rejects.toThrow();
  });

  it('метка типа с пользовательским audience — отказ (стережёт проверку aud)', async () => {
    await expect(
      verifyMachineToken(await forge({ aud: ENV.JWT_AUDIENCE, typ: MACHINE_TOKEN_TYP })),
    ).rejects.toThrow();
  });

  it('пользовательская проверка отвергает метку mc+jwt даже при пользовательском audience', async () => {
    await expect(
      verifyAccessToken(await forge({ aud: ENV.JWT_AUDIENCE, typ: MACHINE_TOKEN_TYP })),
    ).rejects.toThrow();
  });

  it('пользовательский токен без метки по-прежнему проходит (живые сессии не задеты)', async () => {
    const claims = await verifyAccessToken(await forge({ aud: ENV.JWT_AUDIENCE }));
    expect(claims.role).toBe('admin');
  });

  it('без поколения или прав — отказ', async () => {
    await expect(
      verifyMachineToken(await forge({ aud: MACHINE_TOKEN_AUDIENCE, typ: MACHINE_TOKEN_TYP, claims: { gen: 'x' } })),
    ).rejects.toThrow();
  });
});
