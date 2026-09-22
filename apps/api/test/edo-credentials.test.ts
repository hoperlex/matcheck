/**
 * Секреты подключения к Диадоку: что попадает в хранилище.
 *
 * Повод конкретный. Первая боевая настройка упёрлась в `invalid_client`, хотя
 * те же значения, отправленные напрямую curl'ом, давали токен. Такой отказ
 * сервис авторизации возвращает одинаково и на неверный ключ, и на лишний
 * пробел в его конце — а пробел цепляется к значению при копировании из
 * Кабинета интегратора и в поле формы никак не виден.
 */
import { describe, it, expect } from 'vitest';
import { EdoAccountCreateSchema, EdoAccountPatchSchema } from '@matcheck/contracts';

const base = {
  name: 'Диадок',
  environment: 'production' as const,
};

describe('секреты при заведении учётной записи', () => {
  it('пробелы и переносы строк по краям обрезаются', () => {
    const parsed = EdoAccountCreateSchema.parse({
      ...base,
      credentials: {
        authMode: 'oidc_refresh',
        clientId: '  app-1\n',
        clientSecret: ' key-2 ',
        refreshToken: '\trefresh-3  ',
      },
    });
    expect(parsed.credentials).toMatchObject({
      clientId: 'app-1',
      clientSecret: 'key-2',
      refreshToken: 'refresh-3',
    });
  });

  it('значение из одних пробелов не принимается за секрет', () => {
    expect(() =>
      EdoAccountCreateSchema.parse({
        ...base,
        credentials: {
          authMode: 'oidc_refresh',
          clientId: 'app-1',
          clientSecret: '   ',
          refreshToken: 'refresh-3',
        },
      }),
    ).toThrow();
  });

  it('внутренние символы не трогаются: в ключах бывают + / =', () => {
    const parsed = EdoAccountCreateSchema.parse({
      ...base,
      credentials: {
        authMode: 'oidc_refresh',
        clientId: 'app-1',
        clientSecret: 'a+b/c=d==',
        refreshToken: 'x+y/z=',
      },
    });
    expect(parsed.credentials).toMatchObject({
      clientSecret: 'a+b/c=d==',
      refreshToken: 'x+y/z=',
    });
  });

  it('правка учётной записи обрезает так же', () => {
    const parsed = EdoAccountPatchSchema.parse({
      credentials: { clientSecret: '  new-key  ' },
    });
    expect(parsed.credentials?.clientSecret).toBe('new-key');
  });
});
