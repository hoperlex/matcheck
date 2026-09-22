/**
 * Что администратор видит, когда проверка доступа не удалась.
 *
 * Повод для теста конкретный: в первой боевой пробе на экран пришло «Проверка
 * доступа не удалась.» — фраза, из которой нельзя понять ничего, а настоящая
 * причина (ответ в Protocol Buffers вместо JSON) осталась только в логе
 * сервера. Диагностика превратилась в угадывание.
 *
 * При этом подробность не должна стать утечкой: в ошибках разбора лежат
 * полученные значения полей, то есть реквизиты организаций.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 0, EDO_POLL_LEASE_SEC: 900 }),
}));

const { describeFailure } = await import('../src/domain/edo/check-access.js');
const {
  DiadocAccessDenied,
  DiadocRateLimited,
  DiadocSubscriptionExpired,
} = await import('../src/domain/edo/diadoc.http.js');

describe('объяснение отказа', () => {
  it('известные отказы объясняются человеческим языком', () => {
    expect(describeFailure(new DiadocAccessDenied()).message).toMatch(/площадк/i);
    expect(describeFailure(new DiadocSubscriptionExpired()).message).toMatch(/подписк/i);
    expect(describeFailure(new DiadocRateLimited(1000)).error).toBe('rate_limited');
  });

  it('неопознанная ошибка доносит причину, а не общую фразу', () => {
    // Именно так выглядит разбор бинарного ответа как JSON.
    const err = new SyntaxError('Unexpected token \u0000 in JSON at position 0');
    const failure = describeFailure(err);
    expect(failure.message).toContain('Unexpected token');
    // Прежнее поведение: текст без причины. Больше не годится.
    expect(failure.message).not.toBe('Проверка доступа не удалась.');
  });

  it('ошибка разбора ответа не выносит наружу значения полей', () => {
    // В ZodError попадают полученные данные — реквизиты организаций из ответа.
    let zodError: unknown;
    try {
      z.object({ Inn: z.string() }).parse({ Inn: 7712345678 });
    } catch (e) {
      zodError = e;
    }
    const failure = describeFailure(zodError);
    expect(failure.error).toBe('unexpected_response');
    expect(failure.message).not.toContain('7712345678');
    expect(failure.message).toMatch(/неожиданном формате/i);
  });

  it('длинная ошибка обрезается, чтобы не раздувать поле состояния', () => {
    const failure = describeFailure(new Error('x'.repeat(1000)));
    expect(failure.message.length).toBeLessThan(400);
  });
});
