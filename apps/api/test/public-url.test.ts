import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Построение ссылок наружу. Два режима с разным уровнем доверия к адресу, и
 * этот тест закрепляет именно разницу между ними.
 *
 * Модуль читает env один раз при импорте, поэтому каждый набор поднимает его
 * заново через vi.resetModules().
 */
const req = { protocol: 'http', hostname: 'attacker.example' };

async function loadModule() {
  vi.resetModules();
  return import('../src/lib/public-url.js');
}

describe('buildPublicUrl — share-ссылки', () => {
  const original = process.env.PUBLIC_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = original;
  });

  it('берёт PUBLIC_BASE_URL и срезает хвостовой слэш', async () => {
    process.env.PUBLIC_BASE_URL = 'https://portal.test/';
    const { buildPublicUrl } = await loadModule();
    expect(buildPublicUrl(req, '/share/abc')).toBe('https://portal.test/share/abc');
  });

  it('без переменной падает обратно на хост запроса — поведение share не менялось', async () => {
    delete process.env.PUBLIC_BASE_URL;
    const { buildPublicUrl } = await loadModule();
    // Регресс на перенос чтения переменной из process.env в схему env: share
    // работал так с самого начала, и в dev/staging без PUBLIC_BASE_URL ссылки
    // обязаны продолжать строиться.
    expect(buildPublicUrl(req, '/share/abc')).toBe('http://attacker.example/share/abc');
  });
});

describe('buildTrustedUrl — ссылки на смену пароля', () => {
  const original = process.env.PUBLIC_BASE_URL;
  beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = original;
  });

  it('без PUBLIC_BASE_URL отказывается строить ссылку', async () => {
    const { buildTrustedUrl } = await loadModule();
    // Фолбэка на Host здесь нет намеренно: подделанный заголовок увёл бы
    // ссылку, задающую пароль, на чужой домен вместе с доступом к аккаунту.
    expect(() => buildTrustedUrl('/reset-password#tok')).toThrowError(/PUBLIC_BASE_URL/);
  });

  it('с переменной строит ссылку от доверенного домена', async () => {
    process.env.PUBLIC_BASE_URL = 'https://portal.test';
    const { buildTrustedUrl } = await loadModule();
    expect(buildTrustedUrl('/reset-password#tok')).toBe('https://portal.test/reset-password#tok');
  });
});
