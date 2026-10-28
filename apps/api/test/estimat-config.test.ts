/**
 * Настройки EstiMat: неверный токен или адрес выключают только интеграцию —
 * никаких исключений (env общий для трёх процессов, см. lib/env.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  describeTokenForLog,
  ESTIMAT_DEFAULT_BASE_URL,
  readEstimatConfig,
  tokenFingerprint,
} from '../src/domain/estimat/config.js';

const TOKEN = 'estm_abc12345.' + 's'.repeat(47);

describe('readEstimatConfig', () => {
  it('нормальный токен, адрес по умолчанию', () => {
    const cfg = readEstimatConfig({ ESTIMAT_API_TOKEN: TOKEN });
    expect(cfg).toMatchObject({ ok: true, token: TOKEN, baseUrl: ESTIMAT_DEFAULT_BASE_URL });
    expect(cfg.ok && cfg.fingerprint).toBe(tokenFingerprint(TOKEN));
    expect(cfg.ok && cfg.fingerprint).toHaveLength(16);
  });

  it('пробелы и перевод строки по краям обрезаются', () => {
    const cfg = readEstimatConfig({ ESTIMAT_API_TOKEN: `  ${TOKEN}\n` });
    expect(cfg).toMatchObject({ ok: true, token: TOKEN });
  });

  it('нет токена, нет префикса, пробел внутри — ok:false, а не исключение', () => {
    expect(readEstimatConfig({})).toMatchObject({ ok: false });
    expect(readEstimatConfig({ ESTIMAT_API_TOKEN: '   ' })).toMatchObject({ ok: false });
    expect(readEstimatConfig({ ESTIMAT_API_TOKEN: 'abc.def' })).toMatchObject({ ok: false });
    expect(readEstimatConfig({ ESTIMAT_API_TOKEN: 'estm_abc def' })).toMatchObject({ ok: false });
  });

  it('адрес: только https, только хост api.…, без параметров', () => {
    const at = (url: string) => readEstimatConfig({ ESTIMAT_API_TOKEN: TOKEN, ESTIMAT_API_BASE_URL: url });
    expect(at('http://api.estimat.su10.ru/api/external/v1')).toMatchObject({ ok: false });
    expect(at('https://estimat.su10.ru/api/external/v1')).toMatchObject({ ok: false });
    expect(at('https://api.estimat.su10.ru/api/external/v1?x=1')).toMatchObject({ ok: false });
    expect(at('не адрес')).toMatchObject({ ok: false });
    expect(at('https://api.estimat.su10.ru/api/external/v1/')).toMatchObject({
      ok: true,
      baseUrl: 'https://api.estimat.su10.ru/api/external/v1',
    });
  });
});

describe('describeTokenForLog', () => {
  it('только длина и состояние — значения нет', () => {
    expect(describeTokenForLog({})).toBe('estimat token: not set');
    const set = describeTokenForLog({ ESTIMAT_API_TOKEN: TOKEN });
    expect(set).toBe(`estimat token: set, len=${TOKEN.length}`);
    const bad = describeTokenForLog({ ESTIMAT_API_TOKEN: 'secret-value-without-prefix' });
    expect(bad).toBe('estimat token: invalid format, len=27');
    expect(bad).not.toContain('secret');
  });
});
