/**
 * «Проверить доступ»: что видит учётная запись и хватает ли ей прав.
 *
 * Зачем отдельная операция. Без неё администратору пришлось бы выяснять boxId
 * где-то на стороне и узнавать о нехватке прав уже по 403 в середине прохода.
 * Здесь же проверяются ровно те два условия, из-за которых опрос потом
 * разваливается:
 *
 *   1. Пользователь не заблокирован.
 *   2. У него доступ ко ВСЕМ документам ящика. При ограниченном доступе
 *      GetNewEvents требует указания подразделения, а GetMessage отвечает 403,
 *      если в сообщении есть хоть один недоступный документ. Такую учётную
 *      запись честнее отвергнуть сразу.
 *
 * Операция идёт под лизом: она обменивает refresh_token, а параллельный обмен
 * оставил бы одного из участников с токеном, который сервер уже отозвал.
 */
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/client.js';
import { edoAccounts } from '../../db/schema.js';
import { loadEnv } from '../../lib/env.js';
import type { EdoCheckResult } from '@matcheck/contracts';
import { createDiadocAuth, DiadocAuthConflict, DiadocAuthMisconfigured } from './diadoc.auth.js';
import { DiadocClient } from './diadoc.client.js';
import {
  DiadocAccessDenied,
  DiadocAuthExpired,
  DiadocAuthRejected,
  DiadocRateLimited,
  DiadocSubscriptionExpired,
  DiadocTransient,
} from './diadoc.http.js';
import { acquireEdoLease, releaseEdoLease } from './poll-lease.js';

/** Уровень доступа, при котором интеграция работает без оговорок. */
const REQUIRED_ACCESS_LEVEL = 'AllDocuments';

export type CheckFailure = {
  error: string;
  status: 409 | 502;
  message: string;
};

export type CheckOutcome = { value: EdoCheckResult } | CheckFailure;

/**
 * Превращает ошибку Диадока в то, что имеет смысл показать человеку.
 *
 * Тела ответов сюда не попадают: в них реквизиты организаций, а сообщение
 * уходит в интерфейс и в лог.
 */
export function describeFailure(err: unknown): CheckFailure {
  if (err instanceof DiadocAccessDenied) {
    return {
      error: 'access_denied',
      status: 409,
      message:
        'Диадок отказал в доступе. Проверьте, что площадка (боевая или тестовая) совпадает с той, где выдан ящик, и что у учётной записи есть права на него.',
    };
  }
  if (err instanceof DiadocSubscriptionExpired) {
    return {
      error: 'subscription_expired',
      status: 409,
      message: 'Доступ к API приостановлен: истёк срок действия подписки Диадока.',
    };
  }
  // Отказ сервиса авторизации. Коды протокола сами по себе ничего не говорят
  // администратору, поэтому каждый переводится в конкретное «что проверить».
  if (err instanceof DiadocAuthRejected) {
    const detail = err.description ? ` Ответ сервиса: ${err.description}.` : '';
    if (err.code === 'invalid_client') {
      return {
        error: 'auth_rejected',
        status: 409,
        message:
          `Диадок не принял пару client_id и ключ приложения (invalid_client). Проверьте, что ключ выпущен для этого же приложения, и что в Кабинете интегратора в разделе «Способ получения токенов» выбран AuthorizationCode — для работы по refresh-токену нужен именно он.${detail}`,
      };
    }
    if (err.code === 'invalid_grant') {
      return {
        error: 'auth_rejected',
        status: 409,
        message:
          `Refresh-токен недействителен (invalid_grant). Обычно это значит, что его отозвали, он выпущен для другого приложения или другой площадки, либо им не пользовались больше 30 дней. Выпустите новый в Кабинете интегратора.${detail}`,
      };
    }
    if (err.code === 'invalid_scope') {
      return {
        error: 'auth_rejected',
        status: 409,
        message:
          `У приложения нет нужного доступа (invalid_scope). При выпуске refresh-токена должен быть отмечен scope Diadoc.PublicAPI — для тестовой площадки Diadoc.PublicAPI.Staging.${detail}`,
      };
    }
    return {
      error: 'auth_rejected',
      status: 409,
      message: `Сервис авторизации отклонил запрос: ${err.code}.${detail}`,
    };
  }

  if (err instanceof DiadocAuthExpired) {
    return {
      error: 'auth_failed',
      status: 409,
      message:
        'Не удалось получить токен. Проверьте client_id, ключ приложения и refresh-токен — возможно, он отозван или ему больше 30 дней.',
    };
  }
  if (err instanceof DiadocAuthMisconfigured) {
    return { error: 'auth_misconfigured', status: 409, message: err.message };
  }
  if (err instanceof DiadocAuthConflict) {
    return {
      error: 'auth_conflict',
      status: 409,
      message: 'Состояние авторизации меняется параллельно. Повторите через минуту.',
    };
  }
  if (err instanceof DiadocRateLimited) {
    return {
      error: 'rate_limited',
      status: 502,
      message: 'Диадок ограничил частоту запросов. Повторите позже.',
    };
  }
  if (err instanceof DiadocTransient) {
    return { error: 'upstream_unavailable', status: 502, message: 'Диадок временно недоступен.' };
  }

  // Ответ пришёл, но разобрать его не удалось. Текст ошибки разбора наружу НЕ
  // отдаём: в нём полученные значения полей, то есть реквизиты организаций.
  if (err instanceof Error && err.name === 'ZodError') {
    return {
      error: 'unexpected_response',
      status: 502,
      message:
        'Диадок ответил в неожиданном формате — разобрать ответ не удалось. Подробности в журнале сервера.',
    };
  }

  // Всё остальное. Прежде здесь была фраза без причины, и по ней нельзя было
  // понять ничего: первая боевая проба показала «проверка доступа не удалась»,
  // а настоящая ошибка (ответ в Protocol Buffers вместо JSON) осталась только в
  // логе сервера. Текст исключения короткий и тел ответов не содержит —
  // diadocFetch их в ошибки не кладёт.
  const detail = err instanceof Error ? err.message : String(err);
  return {
    error: 'check_failed',
    status: 502,
    message: `Проверка доступа не удалась: ${detail.slice(0, 300)}`,
  };
}

export async function checkEdoAccess(
  db: Db,
  account: typeof edoAccounts.$inferSelect,
  log: FastifyBaseLogger,
): Promise<CheckOutcome> {
  const env = loadEnv();
  // requirePollEnabled: false — смысл проверки в том, чтобы убедиться в
  // доступах ДО включения опроса.
  const lease = await acquireEdoLease(db, {
    accountId: account.id,
    owner: crypto.randomUUID(),
    ttlSeconds: Math.min(env.EDO_POLL_LEASE_SEC, 120),
    requirePollEnabled: false,
  });
  if (!lease) {
    return {
      error: 'lease_taken',
      status: 409,
      message: 'Учётная запись сейчас опрашивается. Повторите через минуту.',
    };
  }

  try {
    const auth = createDiadocAuth({ db }, account);
    const client = new DiadocClient({ auth, environment: account.environment });

    const boxes = await client.getMyOrganizations();
    // Права проверяем по тому ящику, с которым будем работать; если он ещё не
    // выбран — по первому доступному, иначе проверять нечего.
    const boxIdForPermissions = account.boxId ?? boxes[0]?.boxId ?? null;

    let isBlocked = false;
    let documentAccessLevel: string | null = null;
    if (boxIdForPermissions) {
      const employee = await client.getMyEmployee(boxIdForPermissions);
      isBlocked = Boolean(employee.IsBlocked);
      documentAccessLevel =
        employee.Permissions?.DocumentAccessLevel ?? employee.DocumentAccessLevel ?? null;
    }

    await db
      .update(edoAccounts)
      .set({ lastOkAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(edoAccounts.id, account.id));

    return {
      value: {
        employee: {
          isBlocked,
          documentAccessLevel,
          hasRequiredAccess: !isBlocked && documentAccessLevel === REQUIRED_ACCESS_LEVEL,
        },
        boxes,
      },
    };
  } catch (err) {
    const failure = describeFailure(err);
    log.warn({ err, accountId: account.id }, 'edo check failed');
    await db
      .update(edoAccounts)
      .set({ lastError: failure.message, updatedAt: new Date() })
      .where(eq(edoAccounts.id, account.id));
    return failure;
  } finally {
    await releaseEdoLease(db, lease).catch(() => {});
  }
}
