/**
 * Отпечаток секрета: сверить сохранённое с оригиналом, не раскрывая его.
 *
 * Зачем он появился. Настройка подключения упёрлась в `invalid_client`, и
 * единственной непроверяемой версией осталось «в базе лежит не тот ключ».
 * Длина эту версию не закрывает: два разных ключа одной длины по ней
 * неразличимы. Отпечаток закрывает — и при этом не выносит наружу значение.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({
    APP_FIELD_ENCRYPTION_KEYS: '{"v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION: 'v1',
  }),
}));

const { sha256Hex } = await import('../src/domain/auth/crypto.js');

/** То же, что делает роут учётных записей ЭДО. */
const fingerprint = (value: string) => sha256Hex(value).slice(0, 8);

describe('отпечаток секрета', () => {
  const secret = 'ZGlhZG9jLXNlY3JldC1rZXktNDQtc2ltdm9sb3Y';

  it('совпадает с sha256, посчитанным независимо', () => {
    // Ровно то, что администратор выполнит у себя:
    //   printf %s 'ЗНАЧЕНИЕ' | sha256sum | cut -c1-8
    const expected = createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
    expect(fingerprint(secret)).toBe(expected);
  });

  it('не содержит самого секрета', () => {
    const fp = fingerprint(secret);
    expect(fp).toHaveLength(8);
    expect(secret).not.toContain(fp);
    expect(fp).not.toContain(secret.slice(0, 8));
  });

  it('различает значения одной длины', () => {
    // Главный смысл: именно этого не умеет длина.
    const a = 'a'.repeat(44);
    const b = `${'a'.repeat(43)}b`;
    expect(a.length).toBe(b.length);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('ловит невидимый пробел на конце', () => {
    expect(fingerprint(secret)).not.toBe(fingerprint(`${secret} `));
  });

  it('устойчив: одно и то же значение даёт один отпечаток', () => {
    expect(fingerprint(secret)).toBe(fingerprint(secret));
  });
});
