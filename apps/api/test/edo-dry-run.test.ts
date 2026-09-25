/**
 * Пробный разбор: показать разбор настоящих документов, ничего не создавая.
 *
 * Появился потому, что выбор был из двух крайностей — разведка, считающая
 * только типы, и импорт, сразу пишущий карточки. Разбор XML на бою не
 * выполнялся ни разу, и первая же проверка на живых данных оказалась бы
 * проверкой постфактум: неверные документы уже лежали бы в рабочем списке.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/env.js', () => ({
  loadEnv: () => ({ EDO_HTTP_MAX_RETRIES: 0, EDO_XML_MAX_BYTES: 1024 * 1024 }),
}));

const { dryRunBox } = await import('../src/domain/edo/dry-run.js');
type Client = Parameters<typeof dryRunBox>[0];

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

const UTD = `<?xml version="1.0" encoding="UTF-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_2BM">
  <Документ КНД="1115131" Функция="СЧФДОП">
    <СвСчФакт НомерСчФ="УТ-4308" ДатаСчФ="01.09.2026">
      <СвПрод><ИдСв>
        <СвЮЛУч НаимОрг="ООО «Металлбаза»" ИННЮЛ="7712345678" КПП="771201001"/>
      </ИдСв></СвПрод>
      <СвПокуп><ИдСв>
        <СвЮЛУч НаимОрг="ООО «СУ-10»" ИННЮЛ="7736255508" КПП="771501001"/>
      </ИдСв></СвПокуп>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Труба стальная 57х3.5" НаимЕдИзм="т"
               КолТов="2.5" ЦенаТов="64000" СтТовБезНДС="160000" НалСт="20%" СтТовУчНал="192000">
        <СумНал><СумНал>32000</СумНал></СумНал>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="160000" СтТовУчНалВсего="192000">
        <СумНалВсего><СумНал>32000</СумНал></СумНалВсего>
      </ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`;

/** Событие с одним формализованным УПД. */
function updEvent(id: string, meta: Record<string, string> = {}) {
  return {
    EventId: id,
    IndexKey: `idx-${id}`,
    Message: {
      MessageId: `msg-${id}`,
      ToBoxId: 'box-наш',
      Entities: [
        {
          EntityId: `ent-${id}`,
          EntityType: 'Attachment',
          FileName: `${id}.xml`,
          DocumentInfo: {
            DocumentDirection: 'Inbound',
            TypeNamedId: 'UniversalTransferDocument',
            Function: 'СЧФДОП',
            Version: 'utd970_05_03_01',
            ...meta,
          },
        },
      ],
    },
  };
}

/** Клиент, отдающий заданные события и заданное содержимое. */
function clientWith(events: unknown[], content: string | (() => never) = UTD): Client {
  let page = 0;
  return {
    getNewEvents: async () => ({ events: (page++ === 0 ? events : []) as never[] }),
    getEntityContent: async () => {
      if (typeof content === 'function') content();
      return Buffer.from(content as string, 'utf8');
    },
  } as unknown as Client;
}

describe('пробный разбор', () => {
  it('показывает, что вычитано из документа, и что он прошёл бы в карточки', async () => {
    const report = await dryRunBox(clientWith([updEvent('a')]), {
      boxId: 'box-наш',
      since: null,
    }, log);

    expect(report.candidates).toBe(1);
    expect(report.examined).toBe(1);
    const doc = report.documents[0]!;
    expect(doc.accepted).toBe(true);
    expect(doc.reasons).toEqual([]);
    expect(doc.parsed).toMatchObject({
      docNumber: 'УТ-4308',
      // Парсер приводит дату к ISO — в карточке она хранится именно так.
      docDate: '2026-09-01',
      itemsCount: 1,
    });
    expect(doc.parsed?.supplier.inn).toBe('7712345678');
    expect(doc.parsed?.recipient?.inn).toBe('7736255508');
    // Позиции показываются, иначе «прочитал» невозможно отличить от «угадал».
    expect(doc.parsed?.sampleItems[0]).toMatchObject({ qty: 2.5, sum: 160000 });
  });

  it('разный формат даты расхождением не считает', async () => {
    // Диадок отдаёт 01.09.2026, парсер — 2026-09-01. Это одна и та же дата, и
    // без приведения к общему виду расхождением был бы каждый документ.
    const report = await dryRunBox(
      clientWith([updEvent('z', { DocumentNumber: 'УТ-4308', DocumentDate: '01.09.2026' })]),
      { boxId: 'box-наш', since: null },
      log,
    );
    expect(report.documents[0]!.mismatches).toEqual([]);
  });

  it('называет расхождение с метаданными Диадока', async () => {
    // Провайдер знает номер документа независимо от содержимого, поэтому
    // расхождение — ранний признак того, что парсер читает не те поля.
    const report = await dryRunBox(
      clientWith([updEvent('b', { DocumentNumber: 'ДРУГОЙ-1', DocumentDate: '02.09.2026' })]),
      { boxId: 'box-наш', since: null },
      log,
    );
    const doc = report.documents[0]!;
    expect(doc.mismatches).toHaveLength(2);
    expect(doc.mismatches.join(' ')).toMatch(/номер/);
    expect(doc.mismatches.join(' ')).toMatch(/дата/);
  });

  it('неразобранный документ не выдаётся за годный', async () => {
    const report = await dryRunBox(
      clientWith([updEvent('c')], '<Файл><Документ/></Файл>'),
      { boxId: 'box-наш', since: null },
      log,
    );
    const doc = report.documents[0]!;
    expect(doc.accepted).toBe(false);
    expect(doc.reasons.length).toBeGreaterThan(0);
  });

  it('сбой скачивания попадает в отчёт, а не роняет пробу', async () => {
    const report = await dryRunBox(
      clientWith([updEvent('d'), updEvent('e')], () => {
        throw new Error('Diadoc: содержимое недоступно (HTTP 404)');
      }),
      { boxId: 'box-наш', since: null },
      log,
    );
    expect(report.examined).toBe(2);
    expect(report.documents[0]!.parsed).toBeNull();
    expect(report.documents[0]!.reasons[0]).toMatch(/не удалось скачать/);
  });

  it('разбирает не больше заданного числа, но считает все найденные', async () => {
    // Предел бережёт и время администратора, и квоту обращений к API.
    const report = await dryRunBox(
      clientWith([updEvent('f'), updEvent('g'), updEvent('h')]),
      { boxId: 'box-наш', since: null, limit: 2 },
      log,
    );
    expect(report.candidates).toBe(3);
    expect(report.examined).toBe(2);
  });

  it('предел обхода помечается, чтобы «не нашли» не читалось как «пусто»', async () => {
    // Запрос синхронный, поэтому лента просматривается неглубоко. Отчёт обязан
    // признаться в этом: иначе пустой результат неотличим от пустого ящика.
    const many = Array.from({ length: 4 }, (_, i) => updEvent(`p${i}`));
    const report = await dryRunBox(
      clientWith(many),
      { boxId: 'box-наш', since: null, maxEvents: 2, limit: 1 },
      log,
    );
    expect(report.truncated).toBe(true);
    expect(report.eventsSeen).toBe(2);
  });

  it('полностью просмотренная лента пределом не помечается', async () => {
    const report = await dryRunBox(clientWith([updEvent('q')]), {
      boxId: 'box-наш',
      since: null,
    }, log);
    expect(report.truncated).toBe(false);
  });

  it('неформализованные вложения не трогает', async () => {
    const scan = {
      EventId: 'i',
      IndexKey: 'idx-i',
      Message: {
        MessageId: 'msg-i',
        ToBoxId: 'box-наш',
        Entities: [
          {
            EntityId: 'ent-i',
            EntityType: 'Attachment',
            FileName: 'скан.pdf',
            DocumentInfo: { DocumentDirection: 'Inbound', TypeNamedId: 'Nonformalized' },
          },
        ],
      },
    };
    const report = await dryRunBox(clientWith([scan]), { boxId: 'box-наш', since: null }, log);
    expect(report.candidates).toBe(0);
    expect(report.documents).toEqual([]);
  });
});
