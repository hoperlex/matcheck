/**
 * Матчер объекта для писем с документами.
 *
 * Справочник в фикстуре — РЕАЛЬНЫЙ (коды, названия и адреса сняты с боевой
 * базы), потому что вся ценность матчера в том, как он ведёт себя именно на
 * этих строках: короткие коды вроде `ВЛ` и `САД` пересекаются с обычными
 * словами, а «Метрополия», PRIMAVERA и «Ботанический сад» — это по несколько
 * объектов сразу.
 */
import { describe, expect, it } from 'vitest';
import { matchSite, stripQuoted, type SiteRef } from '../src/domain/sourceDocuments/siteHint.js';

const site = (code: string, name: string, address = '', isActive = true): SiteRef => ({
  id: `id-${code}`,
  code,
  name,
  address,
  isActive,
});

const SITES: SiteRef[] = [
  site('test', 'TEST'),
  site('АЛ13', 'ЖК АЛИЯ, БЛОКИ 13А, 13B', 'ЛЁТНАЯ УЛ.,'),
  site('БС2', 'ЖК БОТАНИЧЕСКИЙ САД, 2-Я ОЧЕРЕДЬ', 'СЕРЕБРЯКОВА ПР-Д'),
  site('БС3', 'ЖК БОТАНИЧЕСКИЙ САД, 3-Я ОЧЕРЕДЬ', 'ЛАЗОРЕВЫЙ ПР-Д'),
  site('ВЛ', 'ЖК ВАРШАВСКАЯ LIFE', 'КОТЛЯКОВСКИЙ 2-Й ПЕР., ВЛ. 1'),
  site('Д56', 'ЖК ДОМ 56', 'ФРИДРИХА ЭНГЕЛЬСА УЛ., З. У. 56/1'),
  site('ЗИЛ18', 'ЖК ЗИЛАРТ, ГРАНД (Дом 18)', 'АВТОЗАВОДСКАЯ УЛ., ВЛ. 23/2,'),
  site('ЗИЛ33', 'ЖК МАРК (ЛОТ №33)', 'АВТОЗАВОДСКАЯ УЛ., ВЛ. 23/2, ЖК «ЗИЛАРТ», ЛОТ 33'),
  site('ЛК', 'ЖК LIFE‑Кутузовский 1-ая и 2-ая оч.', 'ГЖАТСКАЯ УЛ., ВЛ. 9'),
  site('МЕ1.0', 'ЖК Метрополия 1-ая оч. Этап 1.0', 'ВОЛГОГРАДСКИЙ ПР-Т'),
  site('МЕ1.1', 'ЖК Метрополия 2-ая оч. Этап 1.1', 'ВОЛГОГРАДСКИЙ ПР-Т'),
  site('ПРИМ13', 'ЖК PRIMAVERA квартал Vivaldi. К13', 'ВОЛОКОЛАМСКОЕ Ш., ВЛ. 71/13'),
  site('ПРИМ14', 'ЖК PRIMAVERA квартал Bellini. К14', 'ВОЛОКОЛАМСКОЕ Ш., ВЛ. 71/14'),
  site('САД', 'ЖК «Садовническая 69»', 'Садовническая набережная, 69'),
  site('СБ1', 'ЖК Сити Бей 1-ая оч.', 'ВОЛОКОЛАМСКОЕ Ш., ВЛ. 97'),
  site('СБ2', 'ЖК Сити Бей 2-ая оч.', 'ВОЛОКОЛАМСКОЕ Ш., ВЛ. 93-97'),
  site('СОБ2', 'ЖК СОБЫТИЕ-2', 'РАМЕНКИ Р-Н, М/У УЛ. ЛОБАЧЕВСКОГО И ПЛ. "МАТВЕЕВСКОЕ"'),
  site('СТОР', 'ЖК СТОРИС', 'РАМЕНКИ ВТМО, УЛ. ЛОБАЧЕВСКОГО, З/У 124/3А'),
  site('ЗАКР', 'ЖК ЗАКРЫТЫЙ', '', false),
];

const codes = (m: ReturnType<typeof matchSite>) =>
  m.decision === 'none' || m.decision === 'ambiguous' || m.decision === 'unknown_code'
    ? m.suggestions.map((s) => s.code)
    : [];

describe('явный маркер — единственный путь к автопроходу', () => {
  it('«Объект: ЗИЛ33» в теме → автопроход', () => {
    const m = matchSite({ subject: 'УПД Объект: ЗИЛ33', body: '' }, SITES);
    expect(m).toEqual({ decision: 'explicit', siteId: 'id-ЗИЛ33', code: 'ЗИЛ33' });
  });

  it('регистр, тире и лишние пробелы не мешают', () => {
    for (const text of ['объект - зил33', 'ОБЪЕКТ:   ЗИЛ33', 'Площадка: ЗиЛ33', 'обьект: зил 33']) {
      const m = matchSite({ body: text }, SITES);
      expect(m.decision, text).toBe('explicit');
      if (m.decision === 'explicit') expect(m.code).toBe('ЗИЛ33');
    }
  });

  it('один и тот же код дважды — это по-прежнему один объект', () => {
    const m = matchSite({ subject: 'Объект: АЛ13', body: 'повторю: Объект: АЛ13' }, SITES);
    expect(m.decision).toBe('explicit');
  });

  it('два разных явных кода → в разбор, без выбора «наугад»', () => {
    const m = matchSite({ body: 'Объект: ЗИЛ33\nОбъект: АЛ13' }, SITES);
    expect(m.decision).toBe('ambiguous');
    if (m.decision === 'ambiguous') expect(m.codes.sort()).toEqual(['АЛ13', 'ЗИЛ33']);
  });

  it('опечатка в коде → unknown_code, а не молчаливый провал в подсказки', () => {
    const m = matchSite({ body: 'Объект: ЗИЛ99' }, SITES);
    expect(m.decision).toBe('unknown_code');
    if (m.decision === 'unknown_code') expect(m.codes).toEqual(['ЗИЛ99']);
  });

  it('технический объект test и неактивные к автопроходу не приводят', () => {
    expect(matchSite({ body: 'Объект: test' }, SITES).decision).toBe('unknown_code');
    expect(matchSite({ body: 'Объект: ЗАКР' }, SITES).decision).toBe('unknown_code');
  });

  it('явный маркер побеждает любые совпадения в тексте', () => {
    const m = matchSite(
      { subject: 'Объект: АЛ13', body: 'Ранее возили на СТОРИС, Лобачевского' },
      SITES,
    );
    expect(m).toMatchObject({ decision: 'explicit', code: 'АЛ13' });
  });
});

describe('ловушки коротких кодов и общих слов', () => {
  it('«ВЛ. 71/14» в адресе не превращается в объект ВЛ', () => {
    // Именно такой формат в справочнике адресов («ВОЛОКОЛАМСКОЕ Ш., ВЛ. 71/14»),
    // и точка сразу после «ВЛ» образует границу слова — короткий код совпал бы.
    const m = matchSite(
      { body: 'Доставка: Волоколамское ш., вл. 71/14, корпус 3' },
      SITES,
    );
    expect(m.decision).toBe('none');
    expect(codes(m)).not.toContain('ВЛ');
  });

  it('«влд.» слитно тоже не даёт ВЛ', () => {
    const m = matchSite({ body: 'Волоколамское шоссе, влд. 71/14' }, SITES);
    expect(codes(m)).not.toContain('ВЛ');
  });

  it('«Ботанический сад» не превращается в объект САД', () => {
    const m = matchSite({ body: 'Выгрузка ЖК Ботанический сад, 2-я очередь' }, SITES);
    expect(codes(m)).not.toContain('САД');
  });

  it('«Волоколамское шоссе» само по себе объект не определяет', () => {
    const m = matchSite({ body: 'Волоколамское шоссе' }, SITES);
    expect(m.decision).toBe('none');
    expect(codes(m)).toEqual([]);
  });

  it('«Метрополия» — это пять объектов, подсказки быть не должно', () => {
    const m = matchSite({ body: 'Привезли на Метрополию' }, SITES);
    expect(m.decision).toBe('none');
    expect(codes(m)).toEqual([]);
  });

  it('«Зиларт» встречается у двух объектов → не подсказываем', () => {
    // ЗИЛ18 называется «ЖК ЗИЛАРТ…», а у ЗИЛ33 «ЗИЛАРТ» стоит в адресе.
    const m = matchSite({ filenames: ['зиларт.pdf'] }, SITES);
    expect(codes(m)).not.toContain('ЗИЛ18');
  });

  it('«Лобачевского» — СТОР и СОБ2, тоже не различает', () => {
    const m = matchSite({ body: 'ул. Лобачевского' }, SITES);
    expect(codes(m)).toEqual([]);
  });
});

describe('подсказки по различающим словам', () => {
  it('«Алия» в имени файла подсказывает АЛ13, но автопрохода не даёт', () => {
    const m = matchSite({ filenames: ['Алия.pdf'] }, SITES);
    expect(m.decision).toBe('none');
    expect(codes(m)).toContain('АЛ13');
  });

  it('«Фридриха Энгельса» подсказывает Д56', () => {
    const m = matchSite({ filenames: ['Су-10 Фридриха Энгельса 22.06.pdf'] }, SITES);
    expect(codes(m)).toContain('Д56');
  });

  it('голый код в теме — только подсказка, не автопроход', () => {
    const m = matchSite({ subject: 'УПД ПРИМ14 за июль' }, SITES);
    expect(m.decision).toBe('none');
    expect(codes(m)).toContain('ПРИМ14');
  });

  it('квартал Bellini различает ПРИМ14 внутри семейства PRIMAVERA', () => {
    const m = matchSite({ body: 'PRIMAVERA, квартал Bellini' }, SITES);
    expect(codes(m)).toEqual(['ПРИМ14']);
  });
});

describe('цитата пересланной переписки', () => {
  it('маркер внутри цитаты не учитывается', () => {
    const m = matchSite(
      {
        body: [
          'Добрый день! Направляю УПД.',
          '',
          '-----Original Message-----',
          'From: snab@example.org',
          'Объект: ЗИЛ33',
        ].join('\n'),
      },
      SITES,
    );
    expect(m.decision).toBe('none');
  });

  it('строки с «>» отбрасываются', () => {
    const m = matchSite({ body: 'Направляю документы\n> Объект: АЛ13' }, SITES);
    expect(m.decision).toBe('none');
  });

  it('свой маркер выше цитаты работает', () => {
    const m = matchSite(
      { body: 'Объект: АЛ13\n\n-----Original Message-----\nОбъект: ЗИЛ33' },
      SITES,
    );
    expect(m).toMatchObject({ decision: 'explicit', code: 'АЛ13' });
  });

  it('stripQuoted оставляет только собственный текст', () => {
    expect(stripQuoted('своё\n\nFrom: x@y\nчужое')).toBe('своё\n');
  });
});
