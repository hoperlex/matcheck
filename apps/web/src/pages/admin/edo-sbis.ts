/**
 * Учётка СБИС в админке: разбор организации из `boxId` и тела запросов.
 *
 * У СБИС нет ящика: `boxId` хранит ссылку на организацию `вид:ИНН:КПП:филиал`
 * (`legal:7736255508:774550001:`), её же сервер отдаёт в «Проверить доступ»
 * полем `ref`. Формат задаёт сервер (apps/api/src/domain/edo/sbis/sbis.org-ref.ts);
 * здесь — только чтение для подписи.
 */
import type {
  EdoAccountDto,
  EdoSbisAccountCreate,
  EdoSbisCredentialsPatch,
} from '@matcheck/contracts';

export const SBIS_PROVIDER = 'sbis';

export function isSbisAccount(account: Pick<EdoAccountDto, 'provider'>): boolean {
  return account.provider === SBIS_PROVIDER;
}

export type SbisOrgRef = {
  kind: 'legal' | 'person';
  inn: string;
  kpp: string | null;
  branch: string | null;
};

export function parseSbisOrgRef(value: string | null | undefined): SbisOrgRef | null {
  const parts = (value ?? '').split(':');
  if (parts.length !== 4) return null;
  const [kind, inn, kpp, branch] = parts as [string, string, string, string];
  if (kind !== 'legal' && kind !== 'person') return null;
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return null;
  return { kind, inn, kpp: kpp || null, branch: branch || null };
}

/** «ИНН … · КПП … · филиал …»; не ссылка СБИС — null. */
export function sbisOrgLabel(boxId: string | null | undefined): string | null {
  const org = parseSbisOrgRef(boxId);
  if (!org) return null;
  return [
    `ИНН ${org.inn}`,
    org.kpp ? `КПП ${org.kpp}` : null,
    org.branch ? `филиал ${org.branch}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export type SbisKeysForm = {
  name: string;
  appClientId?: string;
  appSecret?: string;
  secretKey?: string;
};

/**
 * Тело создания учётки. Пробелы по краям срезаются: ключи копируют из
 * карточки приложения Saby, и лишний пробел из буфера обмена дал бы отказ
 * входа, неотличимый от неверного ключа.
 */
export function sbisCreateBody(v: SbisKeysForm): EdoSbisAccountCreate {
  return {
    provider: 'sbis',
    name: v.name.trim(),
    isActive: true,
    credentials: {
      authMode: 'sbis_service_key',
      appClientId: (v.appClientId ?? '').trim(),
      appSecret: (v.appSecret ?? '').trim(),
      secretKey: (v.secretKey ?? '').trim(),
    },
  };
}

export type SbisAccountPatch = {
  name: string;
  isActive: boolean;
  sbisCredentials?: EdoSbisCredentialsPatch;
};

/**
 * Тело правки. Пустой ключ — «не менял»: сохранённые ключи наружу не отдаются,
 * и подтвердить прежнее значение человек не может. Без единого нового ключа
 * поле не отправляется вовсе — сервер отказал бы пустой правке ключей.
 */
export function sbisPatchBody(v: SbisKeysForm & { isActive: boolean }): SbisAccountPatch {
  const keys: EdoSbisCredentialsPatch = {};
  const appClientId = v.appClientId?.trim();
  const appSecret = v.appSecret?.trim();
  const secretKey = v.secretKey?.trim();
  if (appClientId) keys.appClientId = appClientId;
  if (appSecret) keys.appSecret = appSecret;
  if (secretKey) keys.secretKey = secretKey;
  return {
    name: v.name.trim(),
    isActive: v.isActive,
    ...(Object.keys(keys).length > 0 ? { sbisCredentials: keys } : {}),
  };
}
