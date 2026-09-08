/**
 * Совет пользователю должен соответствовать причине.
 *
 * Мониторинг на бою видел сырой текст исключения («Failed to execute
 * 'transaction' on 'IDBDatabase': The database connection is closing») и не
 * понимал, что делать, — а сама ошибка гасилась в catch и в телеметрию не
 * попадала вовсе. Перезагрузка лечит ровно закрытое соединение: для квоты и
 * сбоя файла она бесполезна, поэтому текст там другой.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock('@sentry/react', () => ({ captureException: mocks.captureException }));

const { describePhotoCaptureError, reportPhotoCaptureError } = await import('./photoCaptureError');

const closingError = Object.assign(
  new Error(
    "Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.",
  ),
  { name: 'InvalidStateError' },
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('describePhotoCaptureError', () => {
  it('закрытое соединение — единственный случай, где помогает перезагрузка', () => {
    expect(describePhotoCaptureError(closingError)).toContain('Обновите страницу');
  });

  it('переполнение квоты — про место, а не про перезагрузку', () => {
    const err = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    const msg = describePhotoCaptureError(err);
    expect(msg).toContain('закончилось место');
    expect(msg).not.toContain('Обновите страницу');
  });

  it('прочие сбои — общий текст без ложного совета', () => {
    const msg = describePhotoCaptureError(new Error('canvas decode failed'));
    expect(msg).not.toContain('Обновите страницу');
    expect(msg).not.toContain('закончилось место');
  });

  it('не показывает пользователю технический текст исключения', () => {
    expect(describePhotoCaptureError(closingError)).not.toContain('IDBDatabase');
  });
});

describe('reportPhotoCaptureError', () => {
  it('отправляет исключение в Sentry с видом операции и этапом', () => {
    reportPhotoCaptureError(closingError, { operationKind: 'delivery', stage: 'after' });

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = mocks.captureException.mock.calls[0] as [unknown, { tags: unknown }];
    expect(err).toBe(closingError);
    expect(ctx.tags).toEqual({
      area: 'photo_capture',
      operationKind: 'delivery',
      stage: 'after',
    });
  });

  it('в теги не попадает ничего, кроме вида операции и этапа', () => {
    // Кадр может содержать документ с персональными данными, а имя файла бывает
    // говорящим — в отчёт не уходит ни то, ни другое.
    reportPhotoCaptureError(closingError, { operationKind: 'shipment', stage: 'before' });
    const [, ctx] = mocks.captureException.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(Object.keys(ctx)).toEqual(['tags']);
  });
});
