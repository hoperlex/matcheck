import { describe, it, expect } from 'vitest';
import { backoffMs, classifyUploadError, toErrorInfo } from './uploadRetryPolicy';

describe('classifyUploadError', () => {
  it('not_in_s3 → retriable (фото ещё не в S3, повтор поможет; НЕ удалять)', () => {
    expect(classifyUploadError({ status: 404, code: 'not_in_s3' })).toBe('retriable');
  });

  it('удалённая/недоступная операция → terminal', () => {
    expect(classifyUploadError({ status: 404, code: 'delivery_not_found' })).toBe('terminal');
    expect(classifyUploadError({ status: 404, code: 'shipment_not_found' })).toBe('terminal');
    expect(classifyUploadError({ status: 409, code: 'pending_deletion' })).toBe('terminal');
    expect(classifyUploadError({ status: 403, code: 'forbidden' })).toBe('terminal');
  });

  it('429 и 5xx → retriable', () => {
    expect(classifyUploadError({ status: 429, code: 'rate_limit_exceeded' })).toBe('retriable');
    expect(classifyUploadError({ status: 500, code: 'internal' })).toBe('retriable');
    expect(classifyUploadError({ status: 503 })).toBe('retriable');
  });

  it('неизвестный 404 (без not_in_s3) → unknown (рассинхрон версий/маршрут)', () => {
    expect(classifyUploadError({ status: 404, code: 'not_found' })).toBe('unknown');
    expect(classifyUploadError({ status: 404 })).toBe('unknown');
  });

  it('прочие 4xx → terminal', () => {
    expect(classifyUploadError({ status: 400, code: 'bad_request' })).toBe('terminal');
  });

  it('сеть / нет статуса (в т.ч. проваленный S3 PUT) → retriable', () => {
    expect(classifyUploadError({ network: true })).toBe('retriable');
    expect(classifyUploadError({})).toBe('retriable');
  });
});

describe('toErrorInfo', () => {
  it('ApiError-подобный объект → {status, code}', () => {
    expect(toErrorInfo({ status: 404, code: 'not_in_s3', message: 'x' })).toEqual({
      status: 404,
      code: 'not_in_s3',
    });
  });

  it('generic Error (S3 PUT fail) → network:true', () => {
    expect(toErrorInfo(new Error('S3 upload failed: 500'))).toEqual({ network: true });
  });
});

describe('backoffMs', () => {
  it('растёт с попытками и capped', () => {
    expect(backoffMs(1, 'retriable')).toBe(30_000);
    expect(backoffMs(2, 'retriable')).toBe(60_000);
    expect(backoffMs(3, 'retriable')).toBe(120_000);
    // потолок 30 мин
    expect(backoffMs(50, 'retriable')).toBe(30 * 60_000);
  });

  it('unknown имеет более высокий потолок, чем retriable', () => {
    expect(backoffMs(50, 'unknown')).toBe(6 * 3600_000);
    expect(backoffMs(50, 'unknown')).toBeGreaterThan(backoffMs(50, 'retriable'));
  });
});
