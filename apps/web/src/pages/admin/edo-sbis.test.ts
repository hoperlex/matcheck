import { describe, expect, it } from 'vitest';
import { parseSbisOrgRef, sbisCreateBody, sbisOrgLabel, sbisPatchBody } from './edo-sbis';

describe('организация СБИС из boxId', () => {
  it('юрлицо, ИП и филиал — подпись по ссылке', () => {
    expect(sbisOrgLabel('legal:7736255508:774550001:')).toBe('ИНН 7736255508 · КПП 774550001');
    expect(sbisOrgLabel('person:500100732259::')).toBe('ИНН 500100732259');
    expect(sbisOrgLabel('legal:7736255508:774550001:12')).toBe('ИНН 7736255508 · КПП 774550001 · филиал 12');
    expect(parseSbisOrgRef('legal:7736255508:774550001:')).toEqual({
      kind: 'legal',
      inn: '7736255508',
      kpp: '774550001',
      branch: null,
    });
  });

  it('не ссылка СБИС — подписи нет (организация не выбрана)', () => {
    for (const value of [null, '', 'e4f1c2d3-0000-4000-8000-000000000000', '7736255508/774550001', 'org:7736255508::']) {
      expect(sbisOrgLabel(value)).toBeNull();
    }
  });
});

describe('тела запросов учётки СБИС', () => {
  it('создание: три ключа без пробелов по краям, полей Диадока нет', () => {
    expect(
      sbisCreateBody({ name: ' СБИС СУ-10 ', appClientId: ' 1025 ', appSecret: 'sec\n', secretKey: '\tkey ' }),
    ).toEqual({
      provider: 'sbis',
      name: 'СБИС СУ-10',
      isActive: true,
      credentials: { authMode: 'sbis_service_key', appClientId: '1025', appSecret: 'sec', secretKey: 'key' },
    });
  });

  it('правка: пустые ключи не уходят; без новых ключей — без sbisCredentials', () => {
    expect(sbisPatchBody({ name: 'СБИС', isActive: false, appClientId: '', appSecret: '  ', secretKey: undefined })).toEqual({
      name: 'СБИС',
      isActive: false,
    });
    expect(sbisPatchBody({ name: 'СБИС', isActive: true, secretKey: ' new-key ' })).toEqual({
      name: 'СБИС',
      isActive: true,
      sbisCredentials: { secretKey: 'new-key' },
    });
  });
});
