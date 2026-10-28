import { createHash } from 'node:crypto';

/**
 * Настройки интеграции с EstiMat. Проверяются здесь, а не в схеме env: loadEnv
 * бросает на любой ошибке, а файл секретов общий для трёх процессов, — неверный
 * токен обязан выключать только интеграцию, а не API вместе с мобильным каналом.
 */
export const ESTIMAT_DEFAULT_BASE_URL = 'https://api.estimat.su10.ru/api/external/v1';

export type EstimatConfig =
  | { ok: true; token: string; baseUrl: string; fingerprint: string }
  | { ok: false; reason: string };

/** Первые 16 hex sha256 токена: «тот же токен или нет», без самого токена. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

export function readEstimatConfig(env: {
  ESTIMAT_API_TOKEN?: string;
  ESTIMAT_API_BASE_URL?: string;
}): EstimatConfig {
  const token = env.ESTIMAT_API_TOKEN?.trim() ?? '';
  if (!token) return { ok: false, reason: 'нет токена EstiMat' };
  // Внутренние пробелы и переводы строк — признак испорченной вставки, а не токена.
  if (!token.startsWith('estm_') || /\s/.test(token)) {
    return { ok: false, reason: 'токен EstiMat в неверном формате (ожидается estm_…)' };
  }

  const rawUrl = env.ESTIMAT_API_BASE_URL?.trim() || ESTIMAT_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'адрес EstiMat не разбирается' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'адрес EstiMat должен быть https' };
  // estimat.su10.ru — интерфейс для людей: вместо JSON отдаст страницу входа.
  if (!url.hostname.startsWith('api.')) {
    return { ok: false, reason: 'адрес EstiMat должен указывать на хост api.…' };
  }
  if (url.search || url.hash) return { ok: false, reason: 'в адресе EstiMat не должно быть параметров' };

  return {
    ok: true,
    token,
    baseUrl: url.toString().replace(/\/+$/, ''),
    fingerprint: tokenFingerprint(token),
  };
}

/** Строка для лога при старте: длина и состояние, без значения. */
export function describeTokenForLog(env: { ESTIMAT_API_TOKEN?: string }): string {
  const raw = env.ESTIMAT_API_TOKEN;
  if (!raw || !raw.trim()) return 'estimat token: not set';
  const cfg = readEstimatConfig({ ESTIMAT_API_TOKEN: raw });
  const len = raw.trim().length;
  return cfg.ok || !cfg.reason.startsWith('токен')
    ? `estimat token: set, len=${len}`
    : `estimat token: invalid format, len=${len}`;
}
