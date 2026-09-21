/**
 * Авторизация в Диадоке: обмен refresh_token и его сохранение.
 *
 * Здесь проверяется не «работает ли запрос», а единственный способ навсегда
 * потерять доступ к ящику. refresh_token живёт 30 дней, сервер отзывает прежнее
 * значение в момент обмена, а восстановить его можно только руками через
 * браузер. Отсюда три проверки:
 *
 *   1. новый токен записан ДО того, как мы воспользовались access_token;
 *   2. запись идёт compare-and-swap, и проигравший НЕ перетирает чужое;
 *   3. при сбое записи наверх летит исключение, а не «продолжаем как ни в чём».
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 0, EDO_XML_MAX_BYTES: 1024 }),
}));

// Шифрование здесь не предмет проверки: подменяем на прозрачное, чтобы тест не
// зависел от ключей окружения.
vi.mock('../src/domain/auth/crypto.js', () => ({
  buildAad: (t: string, id: string) => `${t}:${id}`,
  encryptToString: (plain: string) => plain,
  decryptField: (cipher: string) => cipher,
}));

const { createDiadocAuth, DiadocAuthConflict } = await import(
  '../src/domain/edo/diadoc.auth.js'
);

type UpdateCall = { values: Record<string, unknown>; version: number };

/**
 * Мини-имитация drizzle: нас интересует ровно одно — прошло ли обновление по
 * ожидаемой версии. Настоящая база для этого не нужна, а её отсутствие делает
 * тест быстрым и детерминированным.
 */
function makeDb(opts: { currentVersion: number; calls: UpdateCall[] }) {
  return {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            // Условие CAS зашито в запрос; здесь воспроизводим его результат:
            // строка обновляется, только если версия совпала.
            const expected = (values.authStateVersion as number) - 1;
            opts.calls.push({ values, version: expected });
            return expected === opts.currentVersion ? [{ version: expected + 1 }] : [];
          },
        }),
      }),
    }),
  } as never;
}

const account = {
  id: '11111111-1111-1111-1111-111111111111',
  authMode: 'oidc_refresh' as const,
  environment: 'production' as const,
  credentialsEncrypted: JSON.stringify({
    authMode: 'oidc_refresh',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'refresh-старый',
  }),
  authStateEncrypted: null,
  authStateVersion: 3,
};

describe('обмен refresh_token', () => {
  it('сохраняет новый токен ДО того, как вернёт access_token', async () => {
    const order: string[] = [];
    const calls: UpdateCall[] = [];
    const db = makeDb({ currentVersion: 3, calls });
    const originalUpdate = (db as unknown as { update: () => unknown }).update;
    (db as unknown as { update: () => unknown }).update = () => {
      order.push('save');
      return (originalUpdate as () => unknown)();
    };

    const fetchImpl = vi.fn(async () => {
      order.push('exchange');
      return new Response(
        JSON.stringify({
          access_token: 'access-новый',
          expires_in: 86400,
          refresh_token: 'refresh-новый',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const auth = createDiadocAuth(
      { db, fetchImpl: fetchImpl as unknown as typeof fetch },
      account,
    );
    const header = await auth.header();
    order.push('use');

    expect(header).toBe('Bearer access-новый');
    // Порядок принципиален: между обменом и записью прежний refresh уже отозван.
    expect(order).toEqual(['exchange', 'save', 'use']);
    expect(calls[0]?.values.authStateEncrypted).toContain('refresh-новый');
    expect(calls[0]?.values.refreshTokenUsedAt).toBeInstanceOf(Date);
  });

  it('оставляет прежний refresh, если сервер не прислал новый', async () => {
    const calls: UpdateCall[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 }),
    );
    const auth = createDiadocAuth(
      { db: makeDb({ currentVersion: 3, calls }), fetchImpl: fetchImpl as unknown as typeof fetch },
      account,
    );
    await auth.header();
    expect(calls[0]?.values.authStateEncrypted).toContain('refresh-старый');
  });

  it('при проигранном CAS прекращает работу и не перетирает чужое состояние', async () => {
    const calls: UpdateCall[] = [];
    // В базе версия уже другая: кто-то обменял токен параллельно.
    const db = makeDb({ currentVersion: 7, calls });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'a', expires_in: 3600, refresh_token: 'r2' }),
          { status: 200 },
        ),
    );
    const auth = createDiadocAuth(
      { db, fetchImpl: fetchImpl as unknown as typeof fetch },
      account,
    );
    await expect(auth.header()).rejects.toBeInstanceOf(DiadocAuthConflict);
  });

  it('использует токен из состояния, а не первичный из секретов', async () => {
    const calls: UpdateCall[] = [];
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), {
        status: 200,
      });
    });
    const auth = createDiadocAuth(
      {
        db: makeDb({ currentVersion: 3, calls }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      {
        ...account,
        authStateEncrypted: JSON.stringify({ refreshToken: 'refresh-из-состояния' }),
      },
    );
    await auth.header();
    // Тело urlencoded, поэтому сравниваем разобранный параметр, а не подстроку.
    const sent = new URLSearchParams(bodies[0] ?? '');
    expect(sent.get('refresh_token')).toBe('refresh-из-состояния');
    expect(sent.get('client_id')).toBe('client-1');
  });

  it('живой access_token из состояния не вызывает лишнего обмена', async () => {
    const calls: UpdateCall[] = [];
    const fetchImpl = vi.fn();
    const auth = createDiadocAuth(
      {
        db: makeDb({ currentVersion: 3, calls }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      {
        ...account,
        authStateEncrypted: JSON.stringify({
          refreshToken: 'r',
          accessToken: 'ещё-живой',
          accessTokenExpiresAt: Date.now() + 10 * 60 * 60 * 1000,
        }),
      },
    );
    expect(await auth.header()).toBe('Bearer ещё-живой');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('invalidate() заставляет получить токен заново', async () => {
    const calls: UpdateCall[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'свежий', expires_in: 3600 }), {
          status: 200,
        }),
    );
    const auth = createDiadocAuth(
      {
        db: makeDb({ currentVersion: 3, calls }),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      {
        ...account,
        authStateEncrypted: JSON.stringify({
          refreshToken: 'r',
          accessToken: 'протухший-по-мнению-сервера',
          accessTokenExpiresAt: Date.now() + 10 * 60 * 60 * 1000,
        }),
      },
    );
    auth.invalidate();
    expect(await auth.header()).toBe('Bearer свежий');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
