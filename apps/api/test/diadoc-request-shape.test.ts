/**
 * Форма запроса за токеном: то, что портал реально отправляет.
 *
 * Повод. Подключение отвечает `invalid_client` без пояснения, и такой отказ
 * Контур возвращает в том числе на неверно оформленный запрос — не только на
 * недействующие реквизиты. Одинаковый отказ у портала и у ручной команды
 * доказывает воспроизводимость, но не корректность: если обе стороны собирают
 * запрос одинаково неверно, ответы совпадут.
 *
 * Поэтому здесь проверяется не «работает», а состав и кодирование: адрес,
 * метод, формат тела, отсутствие лишнего `Authorization` и то, что значения
 * доходят до сервера ровно такими, какими были.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 0, EDO_XML_MAX_BYTES: 1024 }),
}));

vi.mock('../src/domain/auth/crypto.js', () => ({
  buildAad: (t: string, id: string) => `${t}:${id}`,
  encryptToString: (plain: string) => plain,
  decryptField: (cipher: string) => cipher,
}));

const { createDiadocAuth, probeClientAuth } = await import(
  '../src/domain/edo/diadoc.auth.js'
);
const { buildRequestSnapshot } = await import('../src/domain/edo/diadoc.http.js');

/** Значения нарочно злые: ровно на таких ломается ручная сборка строки тела. */
const TRICKY = {
  clientId: 'ci_su-10',
  clientSecret: 'a+b/c=d%e f&g',
  refreshToken: 'tok+en/with=special%chars and spaces',
};

function makeDb() {
  return {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => [{ version: (values.authStateVersion as number) ?? 1 }],
        }),
      }),
    }),
  } as never;
}

const account = {
  id: '11111111-1111-1111-1111-111111111111',
  authMode: 'oidc_refresh' as const,
  environment: 'production' as const,
  credentialsEncrypted: JSON.stringify({ authMode: 'oidc_refresh', ...TRICKY }),
  authStateEncrypted: null,
  authStateVersion: 0,
};

/** Выполняет обмен токена и возвращает то, что ушло бы в сеть. */
async function captureTokenRequest() {
  let sent: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: URL, init?: RequestInit) => {
    sent = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;

  const snapshots: unknown[] = [];
  const auth = createDiadocAuth(
    { db: makeDb(), fetchImpl, onRequest: (s) => snapshots.push(s) },
    account,
  );
  await auth.header();
  return { sent: sent!, snapshots };
}

describe('состав запроса за токеном', () => {
  it('адрес, метод и формат тела соответствуют схеме Контура', async () => {
    const { sent } = await captureTokenRequest();
    expect(sent.url).toBe('https://identity.kontur.ru/connect/token');
    expect(sent.init.method).toBe('POST');
    expect((sent.init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
    // Тело — форма, а не JSON: по документации JSON и multipart дают invalid_client.
    expect(String(sent.init.body)).not.toMatch(/^\s*[{[]/);
  });

  it('заголовка Authorization в запросе за токеном нет', async () => {
    // В выбранной схеме реквизиты идут в теле, и лишний Authorization Контур
    // называет отдельной причиной отказа. У ОСТАЛЬНЫХ вызовов API он
    // обязателен — там через него идёт токен доступа.
    const { sent } = await captureTokenRequest();
    const names = Object.keys(sent.init.headers as Record<string, string>).map((n) =>
      n.toLowerCase(),
    );
    expect(names).not.toContain('authorization');
    expect(names).toEqual(['content-type']);
  });

  it('отправляются ровно четыре параметра, без лишних и без пропусков', async () => {
    const { sent } = await captureTokenRequest();
    const params = [...new URLSearchParams(String(sent.init.body)).keys()].sort();
    expect(params).toEqual(['client_id', 'client_secret', 'grant_type', 'refresh_token']);
  });
});

describe('кодирование значений', () => {
  it('спецсимволы доходят неискажёнными', async () => {
    // Ручная склейка строки через & сломала бы ровно это: + стал бы пробелом,
    // & разорвал бы значение, % дал бы неверную escape-последовательность.
    const { sent } = await captureTokenRequest();
    const decoded = new URLSearchParams(String(sent.init.body));
    expect(decoded.get('grant_type')).toBe('refresh_token');
    expect(decoded.get('client_id')).toBe(TRICKY.clientId);
    expect(decoded.get('client_secret')).toBe(TRICKY.clientSecret);
    expect(decoded.get('refresh_token')).toBe(TRICKY.refreshToken);
  });

  it('в сыром теле спецсимволы экранированы, а не оставлены как есть', async () => {
    const { sent } = await captureTokenRequest();
    const raw = String(sent.init.body);
    // Плюс внутри значения обязан быть экранирован: иначе сервер прочтёт пробел.
    expect(raw).toContain('%2B');
    expect(raw).not.toContain('a+b/c=d%e f&g');
  });
});

describe('снимок запроса не раскрывает секреты', () => {
  it('в снимке нет ни ключа, ни токена, ни client_id целиком', async () => {
    const { snapshots } = await captureTokenRequest();
    const dump = JSON.stringify(snapshots);
    expect(dump).not.toContain(TRICKY.clientSecret);
    expect(dump).not.toContain(TRICKY.refreshToken);
    expect(dump).not.toContain(TRICKY.clientId);
  });

  it('снимок описывает форму запроса: значения только у безопасных полей', async () => {
    const { snapshots } = await captureTokenRequest();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      method: 'POST',
      url: 'https://identity.kontur.ru/connect/token',
      contentType: 'application/x-www-form-urlencoded',
      hasAuthorization: false,
      bodyKind: 'form',
      grantType: 'refresh_token',
    });
    const params = (snapshots[0] as { params: { name: string; length: number }[] }).params;
    expect(params.map((p) => p.name).sort()).toEqual([
      'client_id',
      'client_secret',
      'grant_type',
      'refresh_token',
    ]);
    // Длина и отпечаток есть у каждого — по ним видно пустое, обрезанное и
    // подменённое значение.
    expect(params.every((p) => p.length > 0)).toBe(true);
  });

  it('тело в JSON распознаётся как неверный формат', () => {
    // Такой снимок сразу объяснил бы invalid_client, не гадая о ключах.
    const snapshot = buildRequestSnapshot(
      'POST',
      new URL('https://identity.kontur.ru/connect/token'),
      { 'Content-Type': 'application/json' },
      JSON.stringify({ grant_type: 'refresh_token' }),
    );
    expect(snapshot.bodyKind).toBe('json');
    expect(snapshot.contentType).toBe('application/json');
  });
});

/** Ответ сервиса авторизации: отказ с кодом OAuth, как он приходит на самом деле. */
function rejectingFetch(code: string) {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: code }), { status: 400 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

const fingerprintOf = (
  snapshot: unknown,
  name: string,
): string | undefined =>
  (snapshot as { params: { name: string; fingerprint: string }[] }).params.find(
    (p) => p.name === name,
  )?.fingerprint;

describe('источник refresh-токена виден в снимке', () => {
  it('при пустом состоянии токен берётся из реквизитов', async () => {
    const { snapshots } = await captureTokenRequest();
    expect(snapshots[0]).toMatchObject({ refreshTokenSource: 'credentials' });
  });

  it('при непустом состоянии — из него, и в запрос уходит именно оно', async () => {
    // Состояние приоритетнее реквизитов, и по снимку это должно быть видно:
    // иначе «в базе лежит верный ключ» и «верный ключ ушёл в запрос» неразличимы.
    const stored = 'rotated-token-from-auth-state';
    let sent: RequestInit | undefined;
    const fetchImpl = (async (_url: URL, init?: RequestInit) => {
      sent = init;
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;

    const snapshots: unknown[] = [];
    const auth = createDiadocAuth(
      { db: makeDb(), fetchImpl, onRequest: (s) => snapshots.push(s) },
      { ...account, authStateEncrypted: JSON.stringify({ refreshToken: stored }) },
    );
    await auth.header();

    expect(snapshots[0]).toMatchObject({ refreshTokenSource: 'auth_state' });
    expect(new URLSearchParams(String(sent?.body)).get('refresh_token')).toBe(stored);
  });
});

describe('проба аутентификации приложения', () => {
  it('идёт теми же ключами, но с другим refresh-токеном', async () => {
    // Смысл пробы в том, что различие ровно одно. Если бы она подставляла свои
    // client_id или ключ, её ответ ничего не говорил бы о боевых реквизитах.
    const { snapshots: normal } = await captureTokenRequest();
    const probeSnapshots: unknown[] = [];
    await probeClientAuth(
      { db: makeDb(), fetchImpl: rejectingFetch('invalid_grant').fetchImpl,
        onRequest: (s) => probeSnapshots.push(s) },
      account,
    );

    expect(probeSnapshots).toHaveLength(1);
    expect(probeSnapshots[0]).toMatchObject({
      method: 'POST',
      url: 'https://identity.kontur.ru/connect/token',
      contentType: 'application/x-www-form-urlencoded',
      hasAuthorization: false,
      bodyKind: 'form',
      grantType: 'refresh_token',
      probe: true,
    });
    expect(fingerprintOf(probeSnapshots[0], 'client_id')).toBe(fingerprintOf(normal[0], 'client_id'));
    expect(fingerprintOf(probeSnapshots[0], 'client_secret')).toBe(
      fingerprintOf(normal[0], 'client_secret'),
    );
    // Настоящий токен во второй раз не отправляется: иначе проба расходовала бы
    // то, ради сохранности чего она и придумана.
    expect(fingerprintOf(probeSnapshots[0], 'refresh_token')).not.toBe(
      fingerprintOf(normal[0], 'refresh_token'),
    );
  });

  it('invalid_grant означает, что ключи приложения приняты', async () => {
    const probe = await probeClientAuth(
      { db: makeDb(), fetchImpl: rejectingFetch('invalid_grant').fetchImpl },
      account,
    );
    expect(probe).toEqual({ outcome: 'client_accepted', code: 'invalid_grant', method: 'post' });
  });

  it('invalid_client означает, что дело не в refresh-токене', async () => {
    const probe = await probeClientAuth(
      { db: makeDb(), fetchImpl: rejectingFetch('invalid_client').fetchImpl },
      account,
    );
    expect(probe).toEqual({ outcome: 'client_rejected', code: 'invalid_client' });
  });

  it('незнакомый ответ не выдаётся за вывод', async () => {
    // Ни «ключи верны», ни «ключи неверны» из такого ответа не следует.
    const probe = await probeClientAuth(
      { db: makeDb(), fetchImpl: rejectingFetch('unsupported_grant_type').fetchImpl },
      account,
    );
    expect(probe.outcome).toBe('inconclusive');
  });
});

describe('непригодные реквизиты отвергаются до сети', () => {
  it('пустой ключ приложения не уходит в запрос и назван своим именем', async () => {
    // Схема хранения обрезает пробелы и требует непустое, поэтому пустое поле
    // выглядит как ошибка разбора. Раньше она доезжала до экрана как «Диадок
    // ответил в неожиданном формате» — то есть указывала не на ту сторону.
    const probe = rejectingFetch('invalid_client');
    expect(() =>
      createDiadocAuth(
        { db: makeDb(), fetchImpl: probe.fetchImpl },
        {
          ...account,
          credentialsEncrypted: JSON.stringify({
            authMode: 'oidc_refresh',
            ...TRICKY,
            clientSecret: '   ',
          }),
        },
      ),
    ).toThrow(/реквизиты учётной записи/i);
    expect(probe.calls()).toBe(0);
  });

  it('причина не раскрывает самих значений', () => {
    // В ZodError попадает и полученное значение; наружу уходит только имя поля.
    try {
      createDiadocAuth(
        { db: makeDb() },
        {
          ...account,
          credentialsEncrypted: JSON.stringify({
            authMode: 'oidc_refresh',
            ...TRICKY,
            clientSecret: '',
          }),
        },
      );
      expect.unreachable('ожидался отказ');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('clientSecret');
      expect(message).not.toContain(TRICKY.refreshToken);
      expect(message).not.toContain(TRICKY.clientId);
    }
  });

  it('сохранённая маска распознаётся как маска', async () => {
    const probe = rejectingFetch('invalid_client');
    expect(() =>
      createDiadocAuth(
        { db: makeDb(), fetchImpl: probe.fetchImpl },
        {
          ...account,
          credentialsEncrypted: JSON.stringify({
            authMode: 'oidc_refresh',
            ...TRICKY,
            refreshToken: '********',
          }),
        },
      ),
    ).toThrow(/маска/i);
    expect(probe.calls()).toBe(0);
  });
});

/** Отвечает по очереди заданными парами «код ответа → тело», запоминая запросы. */
function scriptedFetch(steps: { status: number; body: unknown }[]) {
  const seen: { headers: Record<string, string>; body: string }[] = [];
  let i = 0;
  const fetchImpl = (async (_url: URL, init?: RequestInit) => {
    seen.push({
      headers: (init?.headers as Record<string, string>) ?? {},
      body: String(init?.body ?? ''),
    });
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(step.body), { status: step.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const basicOf = (headers: Record<string, string>) =>
  Object.entries(headers).find(([n]) => n.toLowerCase() === 'authorization')?.[1] ?? null;

describe('способ передачи реквизитов приложения', () => {
  it('при invalid_client реквизиты повторно уходят заголовком Authorization', async () => {
    // Тот же invalid_client приходит и на верные ключи, если приложение
    // зарегистрировано на другой способ их передачи. Снаружи это неразличимо,
    // поэтому второй способ пробуется до того, как винить реквизиты.
    const net = scriptedFetch([
      { status: 400, body: { error: 'invalid_client' } },
      { status: 200, body: { access_token: 'a', expires_in: 3600 } },
    ]);
    const auth = createDiadocAuth({ db: makeDb(), fetchImpl: net.fetchImpl }, account);
    await expect(auth.header()).resolves.toBe('Bearer a');

    expect(net.seen).toHaveLength(2);
    // Первая попытка — как требует документация: всё в теле, без Authorization.
    expect(basicOf(net.seen[0]!.headers)).toBeNull();
    expect(new URLSearchParams(net.seen[0]!.body).get('client_secret')).toBe(TRICKY.clientSecret);
    // Вторая — реквизиты в заголовке и, что важно, НЕ продублированы в теле.
    const auth2 = basicOf(net.seen[1]!.headers);
    expect(auth2).toMatch(/^Basic /);
    expect(Buffer.from(auth2!.slice(6), 'base64').toString('utf8')).toBe(
      `${encodeURIComponent(TRICKY.clientId)}:${encodeURIComponent(TRICKY.clientSecret)}`,
    );
    expect(new URLSearchParams(net.seen[1]!.body).get('client_secret')).toBeNull();
    // Токен во второй попытке тот же самый: меняется способ, а не грант.
    expect(new URLSearchParams(net.seen[1]!.body).get('refresh_token')).toBe(TRICKY.refreshToken);
  });

  it('удачный обмен вторым способом не пробуется', async () => {
    const net = scriptedFetch([{ status: 200, body: { access_token: 'a', expires_in: 3600 } }]);
    const auth = createDiadocAuth({ db: makeDb(), fetchImpl: net.fetchImpl }, account);
    await auth.header();
    expect(net.seen).toHaveLength(1);
  });

  it('другие отказы вторым способом не повторяются', async () => {
    // invalid_grant говорит о самом токене, и повтор другим способом к этому
    // ничего не добавит — только лишний запрос.
    const net = scriptedFetch([{ status: 400, body: { error: 'invalid_grant' } }]);
    const auth = createDiadocAuth({ db: makeDb(), fetchImpl: net.fetchImpl }, account);
    await expect(auth.header()).rejects.toThrow(/invalid_grant/);
    expect(net.seen).toHaveLength(1);
  });

  it('проба различает «не те ключи» и «не тот способ»', async () => {
    const net = scriptedFetch([
      { status: 400, body: { error: 'invalid_client' } },
      { status: 400, body: { error: 'invalid_grant' } },
    ]);
    const probe = await probeClientAuth({ db: makeDb(), fetchImpl: net.fetchImpl }, account);
    expect(probe).toEqual({ outcome: 'client_accepted', code: 'invalid_grant', method: 'basic' });
  });

  it('отказ обоими способами означает именно реквизиты', async () => {
    const net = scriptedFetch([{ status: 400, body: { error: 'invalid_client' } }]);
    const probe = await probeClientAuth({ db: makeDb(), fetchImpl: net.fetchImpl }, account);
    expect(probe).toEqual({ outcome: 'client_rejected', code: 'invalid_client' });
    expect(net.seen).toHaveLength(2);
  });
});
