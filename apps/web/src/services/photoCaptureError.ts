import * as Sentry from '@sentry/react';
import { isConnectionClosingError, type OperationKind } from '../lib/db';

/**
 * Разбор сбоя при добавлении кадра: что показать человеку и что отправить в
 * Sentry.
 *
 * Раньше в тост уходил сырой текст исключения («Failed to execute
 * 'transaction' on 'IDBDatabase': The database connection is closing»), а сама
 * ошибка гасилась в `catch` и в телеметрию не попадала вовсе — на боевую
 * жалобу мониторинга не было ни одного события.
 *
 * Совет «обновите страницу» верен ровно для закрытого соединения с локальной
 * базой. Переполнение квоты и сбой чтения/сжатия файла перезагрузка не лечит,
 * поэтому для них текст другой: иначе человек будет жать F5 по кругу.
 */
export function describePhotoCaptureError(err: unknown): string {
  if (isConnectionClosingError(err)) {
    return 'Не удалось добавить фото: браузер закрыл локальное хранилище. Обновите страницу и повторите.';
  }
  if (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'QuotaExceededError') {
    return 'Не удалось добавить фото: в браузере закончилось место. Освободите место и повторите.';
  }
  return 'Не удалось добавить фото. Попробуйте ещё раз или выберите другой файл.';
}

/**
 * Отправляет сбой в Sentry и возвращает текст для пользователя.
 *
 * В отчёт идут только вид операции и этап: ни файла, ни его имени, ни
 * идентификаторов людей — снимок может содержать документ с персональными
 * данными, а имя файла бывает говорящим.
 */
export function reportPhotoCaptureError(
  err: unknown,
  ctx: { operationKind: OperationKind; stage: 'before' | 'after' },
): string {
  Sentry.captureException(err, {
    tags: { area: 'photo_capture', operationKind: ctx.operationKind, stage: ctx.stage },
  });
  return describePhotoCaptureError(err);
}
