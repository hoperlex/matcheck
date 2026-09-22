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

const { describeFailure, describeClientProbe, shouldProbeClientAuth } = await import(
  '../src/domain/edo/check-access.js'
);
const {
  DiadocAccessDenied,
  DiadocAuthRejected,
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

  it('коды отказа авторизации переводятся в «что проверить»', () => {
    // Сам по себе invalid_client администратору ничего не говорит: причин
    // три, и они в разных местах Кабинета интегратора.
    const client = describeFailure(new DiadocAuthRejected('invalid_client', null));
    expect(client.message).toMatch(/AuthorizationCode/);
    expect(client.message).toMatch(/ключ приложения/i);

    const grant = describeFailure(new DiadocAuthRejected('invalid_grant', null));
    expect(grant.message).toMatch(/30 дней|отозвал/i);

    const scope = describeFailure(new DiadocAuthRejected('invalid_scope', null));
    expect(scope.message).toMatch(/Diadoc\.PublicAPI/);
  });

  it('незнакомый код показывается как есть, вместе с пояснением сервиса', () => {
    const failure = describeFailure(
      new DiadocAuthRejected('unsupported_grant_type', 'grant type not allowed'),
    );
    expect(failure.message).toContain('unsupported_grant_type');
    expect(failure.message).toContain('grant type not allowed');
  });

  it('длинная ошибка обрезается, чтобы не раздувать поле состояния', () => {
    const failure = describeFailure(new Error('x'.repeat(1000)));
    expect(failure.message.length).toBeLessThan(400);
  });
});

describe('проба аутентификации приложения', () => {
  it('запускается только на invalid_client', async () => {
    // Остальные коды уже однозначны, и лишнее обращение к сервису авторизации
    // ничего к ним не добавит.
    expect(shouldProbeClientAuth(new DiadocAuthRejected('invalid_client', null))).toBe(true);
    expect(shouldProbeClientAuth(new DiadocAuthRejected('invalid_grant', null))).toBe(false);
    expect(shouldProbeClientAuth(new DiadocAuthRejected('invalid_scope', null))).toBe(false);
    expect(shouldProbeClientAuth(new DiadocRateLimited(1000))).toBe(false);
    expect(shouldProbeClientAuth(new Error('что угодно'))).toBe(false);
  });

  it('принятые ключи переводят разговор на refresh-токен', () => {
    const text = describeClientProbe({ outcome: 'client_accepted', code: 'invalid_grant' });
    expect(text).toMatch(/refresh-токен/i);
    expect(text).toMatch(/новый|обменян/i);
    // Про ключи приложения говорить больше нечего — они приняты.
    expect(text).not.toMatch(/ключ API/i);
  });

  it('отвергнутые ключи снимают подозрение с токена', () => {
    const text = describeClientProbe({ outcome: 'client_rejected', code: 'invalid_client' });
    expect(text).toMatch(/ни при чём/i);
    expect(text).toMatch(/client_secret/);
  });

  it('невнятный ответ пробы не выдаётся за вывод', () => {
    // Ни одна из версий отсюда не следует, и текст обязан это признавать.
    const text = describeClientProbe({ outcome: 'inconclusive', reason: 'таймаут' });
    expect(text).toMatch(/ответа не дала/i);
    expect(text).toContain('таймаут');
    expect(text).not.toMatch(/значит|следовательно/i);
  });
});
