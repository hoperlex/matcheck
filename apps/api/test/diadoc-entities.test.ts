/**
 * Что забираем из сообщения Диадока.
 *
 * Главная проверка — «два документа в одном сообщении дают две сущности».
 * Прежний каркас брал первый попавшийся EntityId, и второй документ исчезал бы
 * без следа: ни ошибки, ни записи, просто в портале его нет. Такую потерю
 * невозможно заметить постфактум, поэтому она проверяется тестом.
 */
import { describe, it, expect } from 'vitest';
import { classifyMessageEntities } from '../src/domain/edo/diadoc.entities.js';
import { diadocTimestampToDate, dateToDiadocTicks } from '../src/domain/edo/diadoc.types.js';
import type { DiadocMessage } from '../src/domain/edo/diadoc.types.js';

const OUR_BOX = 'box-наш';
const THEIR_BOX = 'box-контрагента';

function message(partial: Partial<DiadocMessage>): DiadocMessage {
  return {
    MessageId: 'm1',
    FromBoxId: THEIR_BOX,
    ToBoxId: OUR_BOX,
    Entities: [],
    ...partial,
  } as DiadocMessage;
}

function utdEntity(entityId: string, extra: Record<string, unknown> = {}) {
  return {
    EntityId: entityId,
    EntityType: 'Attachment',
    DocumentInfo: {
      TypeNamedId: 'UniversalTransferDocument',
      Function: 'СЧФДОП',
      Version: 'utd970_05_03_01',
      DocumentNumber: 'УТ-1',
      DocumentDate: '01.09.2026',
      ...extra,
    },
  };
}

describe('отбор сущностей сообщения', () => {
  it('сообщение с двумя УПД даёт две сущности, а не одну', () => {
    const result = classifyMessageEntities(
      message({ Entities: [utdEntity('e1'), utdEntity('e2')] as never }),
      OUR_BOX,
    );
    const utd = result.entities.filter((e) => e.route === 'utd_xml');
    expect(utd.map((e) => e.entityId)).toEqual(['e1', 'e2']);
  });

  it('исходящее сообщение не разбирается', () => {
    const result = classifyMessageEntities(
      message({ FromBoxId: OUR_BOX, ToBoxId: THEIR_BOX, Entities: [utdEntity('e1')] as never }),
      OUR_BOX,
    );
    expect(result.skipped).toBe('исходящее сообщение');
    expect(result.entities).toHaveLength(0);
  });

  it('черновик и удалённое сообщение не разбираются', () => {
    expect(
      classifyMessageEntities(message({ IsDraft: true, Entities: [utdEntity('e')] as never }), OUR_BOX)
        .skipped,
    ).toBe('черновик');
    expect(
      classifyMessageEntities(
        message({ IsDeleted: true, Entities: [utdEntity('e')] as never }),
        OUR_BOX,
      ).skipped,
    ).toBe('сообщение удалено');
  });

  it('подпись и производные сущности пропускаются', () => {
    const result = classifyMessageEntities(
      message({
        Entities: [
          utdEntity('e1'),
          { EntityId: 'sig', EntityType: 'Signature', ParentEntityId: 'e1' },
          { EntityId: 'child', EntityType: 'Attachment', ParentEntityId: 'e1' },
        ] as never,
      }),
      OUR_BOX,
    );
    expect(result.entities.filter((e) => e.route === 'ignored').map((e) => e.entityId)).toEqual([
      'sig',
      'child',
    ]);
  });

  it('неформализованное вложение уходит в разбор распознаванием, а не в мусор', () => {
    const result = classifyMessageEntities(
      message({
        Entities: [
          { EntityId: 'scan', EntityType: 'Attachment', FileName: 'скан.pdf' },
        ] as never,
      }),
      OUR_BOX,
    );
    expect(result.entities[0]?.route).toBe('unformalized');
  });

  it('зашифрованное, удалённое и исходящее остаются документами с причиной', () => {
    // Прежде они были «ignored» наравне с подписями и в журнал не попадали:
    // на вопрос «а где документ?» ответа не было.
    const result = classifyMessageEntities(
      message({
        Entities: [
          utdEntity('enc', { IsEncryptedContent: true }),
          utdEntity('del', { IsDeleted: true }),
          utdEntity('out', { DocumentDirection: 'Outbound' }),
        ] as never,
      }),
      OUR_BOX,
    );
    expect(result.entities.map((e) => [e.entityId, e.route, e.category, e.reason])).toEqual([
      ['enc', 'skip', 'excluded', 'содержимое зашифровано'],
      ['del', 'skip', 'excluded', 'документ удалён'],
      ['out', 'skip', 'excluded', 'исходящий документ'],
    ]);
  });

  it('тестовое сообщение пропускается целиком, тестовый документ — с причиной', () => {
    // Тестовый документооборот юридической силы не имеет, а выглядит как
    // настоящий: без этой проверки такой УПД стал бы карточкой.
    expect(
      classifyMessageEntities(message({ IsTest: true, Entities: [utdEntity('e')] as never }), OUR_BOX)
        .skipped,
    ).toBe('тестовое сообщение');
    const [entity] = classifyMessageEntities(
      message({ Entities: [utdEntity('t', { IsTest: true })] as never }),
      OUR_BOX,
    ).entities;
    expect([entity?.route, entity?.reason]).toEqual(['skip', 'тестовый документ']);
  });

  it('аннулированным считается только завершённое аннулирование', () => {
    const result = classifyMessageEntities(
      message({
        Entities: [
          utdEntity('done', { RevocationStatus: 'RevocationAccepted' }),
          // Запрос на аннулирование ещё не аннулирование: документ действует.
          utdEntity('asked', { RevocationStatus: 'RequestsMyRevocation' }),
        ] as never,
      }),
      OUR_BOX,
    );
    expect(result.entities.map((e) => [e.entityId, e.route])).toEqual([
      ['done', 'skip'],
      ['asked', 'utd_xml'],
    ]);
    expect(result.entities[0]?.reason).toBe('документ аннулирован');
  });

  it('исправление УПД не идёт в разбор как обычный УПД', () => {
    const [entity] = classifyMessageEntities(
      message({
        Entities: [utdEntity('rev', { TypeNamedId: 'UniversalTransferDocumentRevision' })] as never,
      }),
      OUR_BOX,
    ).entities;
    expect([entity?.route, entity?.category]).toEqual(['skip', 'revision']);
  });

  it('счёт-фактура, УПД-счёт-фактура и неизвестный тип не берутся — с причиной', () => {
    const result = classifyMessageEntities(
      message({
        Entities: [
          utdEntity('inv', { TypeNamedId: 'Invoice', Function: 'default' }),
          utdEntity('schf', { Function: 'СЧФ' }),
          utdEntity('new', { TypeNamedId: 'SomethingNew2027' }),
        ] as never,
      }),
      OUR_BOX,
    );
    expect(result.entities.map((e) => [e.entityId, e.route, e.category])).toEqual([
      ['inv', 'skip', 'invoice'],
      ['schf', 'skip', 'utd_invoice_only'],
      ['new', 'skip', 'not_delivery'],
    ]);
    expect(result.entities[2]?.reason).toContain('SomethingNew2027');
  });

  it('номер и дата берутся из коллекции Metadata раньше устаревших полей', () => {
    const [entity] = classifyMessageEntities(
      message({
        Entities: [
          utdEntity('m', {
            DocumentNumber: 'СТАРОЕ',
            Metadata: [
              { Key: 'DocumentNumber', Value: 'ЦБ-674' },
              { Key: 'DocumentDate', Value: '26.08.2026' },
            ],
          }),
        ] as never,
      }),
      OUR_BOX,
    ).entities;
    expect([entity?.documentNumber, entity?.documentDate, entity?.meta.numberSource]).toEqual([
      'ЦБ-674',
      '26.08.2026',
      'metadata',
    ]);
  });

  it('реквизиты документа переносятся в журнал', () => {
    const [entity] = classifyMessageEntities(
      message({ Entities: [utdEntity('e1')] as never }),
      OUR_BOX,
    ).entities;
    expect(entity).toMatchObject({
      typeNamedId: 'UniversalTransferDocument',
      documentFunction: 'СЧФДОП',
      documentVersion: 'utd970_05_03_01',
      documentNumber: 'УТ-1',
    });
  });
});

describe('время Диадока', () => {
  it('тики .NET не принимаются за миллисекунды Unix', () => {
    // Тики считаются от 0001-01-01, а не от 1970 года. Прочитав их как
    // миллисекунды Unix, мы получили бы дату документа в первых секундах
    // 1970-го — и она молча уехала бы в карточку.
    const expected = new Date('2026-09-01T00:00:00.000Z');
    const ticks = dateToDiadocTicks(expected);
    const naive = new Date(Number(ticks));

    expect(diadocTimestampToDate(ticks)?.toISOString()).toBe(expected.toISOString());
    expect(naive.getUTCFullYear()).not.toBe(2026);
  });

  it('преобразование в тики и обратно возвращает ту же дату', () => {
    const source = new Date('2026-09-01T12:34:56.000Z');
    const back = diadocTimestampToDate(dateToDiadocTicks(source));
    expect(back?.toISOString()).toBe(source.toISOString());
  });

  it('ISO-строка читается как есть', () => {
    expect(diadocTimestampToDate('2026-09-01T00:00:00Z')?.getUTCFullYear()).toBe(2026);
    expect(diadocTimestampToDate(undefined)).toBeNull();
  });
});
