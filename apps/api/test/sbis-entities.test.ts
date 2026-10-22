/**
 * Вложения из ленты СБИС: где ищутся, что считается УПД, как склеиваются
 * повторы и редакции.
 *
 * Отбор по направлению документа мог бы потерять УПД: у вложения своё
 * направление. Поэтому записи собираются по всем направлениям, а «входящее
 * вложение события „Получение“» — отдельный признак для сверки.
 */
import { describe, expect, it } from 'vitest';
import {
  SbisAttachmentSet,
  attachmentKey,
  collectSbisAttachments,
  isIncomingReceipt,
} from '../src/domain/edo/sbis/sbis.entities.js';
import { SbisDocumentSchema } from '../src/domain/edo/sbis/sbis.types.js';

const T1 = new Date('2026-10-19T10:00:00Z');
const T2 = new Date('2026-10-19T11:00:00Z');

function att(id: string, extra: Record<string, unknown> = {}) {
  return {
    Идентификатор: id,
    Тип: 'УпдСчфДоп',
    Направление: 'Входящий',
    Служебный: 'Нет',
    ВерсияФормата: '5.03',
    Редакция: { Номер: '1', ДатаВремя: '18.10.2026 12.00.00' },
    Файл: { Имя: `${id}.xml`, Ссылка: `https://disk.sbis.ru/${id}` },
    ...extra,
  };
}

function doc(events: { id: string; name: string; time?: string; attachments: unknown[] }[], extra: Record<string, unknown> = {}) {
  return SbisDocumentSchema.parse({
    Идентификатор: 'doc-1',
    Тип: 'ДокОтгрВх',
    Направление: 'Входящий',
    Номер: 'УТ-15',
    Дата: '17.10.2026',
    Контрагент: { СвЮЛ: { ИНН: '5024000001', КПП: '502401001', Название: 'ООО Бетон' } },
    Редакция: [{ Идентификатор: 'rev-1', ДатаВремя: '18.10.2026 12.00.00' }],
    Событие: events.map((e) => ({
      Идентификатор: e.id,
      Название: e.name,
      ДатаВремя: e.time ?? '18.10.2026 12.00.00',
      Вложение: e.attachments,
    })),
    ...extra,
  });
}

describe('сбор вложений', () => {
  it('вложения берутся из Событие[].Вложение[] со всеми полями', () => {
    const records = collectSbisAttachments(doc([{ id: 'ev-1', name: 'Получение', attachments: [att('a-1')] }]), T1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      documentId: 'doc-1',
      documentRevisionId: 'rev-1',
      documentNumber: 'УТ-15',
      counterparty: { inn: '5024000001', name: 'ООО Бетон' },
      eventId: 'ev-1',
      eventName: 'Получение',
      attachmentId: 'a-1',
      attachmentType: 'УпдСчфДоп',
      attachmentDirection: 'Входящий',
      formatVersion: '5.03',
      attachmentRevision: { number: '1' },
      link: 'https://disk.sbis.ru/a-1',
      linkReceivedAt: T1.toISOString(),
      isUpd: true,
    });
  });

  it('УПД — УпдСчфДоп и УпдДоп; титул покупателя, служебное, вложение без ссылки — нет', () => {
    const records = collectSbisAttachments(
      doc([
        {
          id: 'ev-1',
          name: 'Получение',
          attachments: [
            att('a-1'),
            att('a-2', { Тип: 'УпдДоп' }),
            att('a-3', { Тип: 'УпдСчфДопПокуп' }),
            att('a-4', { Служебный: 'Да' }),
            // Добавлена только подпись: ссылка на файл пуста, ссылка — у подписи.
            att('a-5', { Файл: { Имя: 'a-5.xml', Ссылка: '' }, Подпись: [{ Файл: { Ссылка: 'https://disk.sbis.ru/sig' } }] }),
            att('a-6', { Тип: 'updschfdop' }),
          ],
        },
      ]),
      T1,
    );
    expect(records.filter((r) => r.isUpd).map((r) => r.attachmentId)).toEqual(['a-1', 'a-2']);
    // Не-УПД тоже собираются — для раскладки.
    expect(records).toHaveLength(6);
  });

  it('направления не фильтруются: входящий пакет с исходящим вложением и наоборот', () => {
    const inPackOutAtt = collectSbisAttachments(
      doc([{ id: 'ev-1', name: 'Получение', attachments: [att('a-1', { Направление: 'Исходящий' })] }]),
      T1,
    );
    const outPackInAtt = collectSbisAttachments(
      doc([{ id: 'ev-2', name: 'Получение', attachments: [att('a-2')] }], { Направление: 'Исходящий' }),
      T1,
    );
    expect(inPackOutAtt[0]).toMatchObject({ documentDirection: 'Входящий', attachmentDirection: 'Исходящий', isUpd: true });
    expect(isIncomingReceipt(inPackOutAtt[0]!)).toBe(false);
    expect(outPackInAtt[0]).toMatchObject({ documentDirection: 'Исходящий', attachmentDirection: 'Входящий', isUpd: true });
    expect(isIncomingReceipt(outPackInAtt[0]!)).toBe(true);
  });

  it('«входящее вложение события Получение» — только оба признака сразу', () => {
    expect(isIncomingReceipt({ attachmentDirection: 'Входящий', eventName: 'Получение' })).toBe(true);
    expect(isIncomingReceipt({ attachmentDirection: 'Входящий', eventName: 'Утверждение' })).toBe(false);
    expect(isIncomingReceipt({ attachmentDirection: 'Исходящий', eventName: 'Получение' })).toBe(false);
    expect(isIncomingReceipt({ attachmentDirection: null, eventName: 'Получение' })).toBe(false);
  });

  it('схема терпит числа вместо строк и объект вместо массива', () => {
    const d = SbisDocumentSchema.parse({
      Идентификатор: 'doc-2',
      Номер: 15,
      Событие: { Идентификатор: 'ev', Название: 'Получение', Вложение: att('a-1', { ВерсияФормата: 5.03 }) },
    });
    const records = collectSbisAttachments(d, T1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ documentNumber: '15', formatVersion: '5.03' });
  });
});

describe('склейка повторов', () => {
  it('одно вложение в двух событиях — одна запись; признак «Получение» и свежая ссылка сохраняются', () => {
    const set = new SbisAttachmentSet();
    set.add(
      collectSbisAttachments(
        doc([{ id: 'ev-1', name: 'Утверждение', attachments: [att('a-1', { Файл: { Ссылка: 'https://disk.sbis.ru/old' } })] }]),
        T1,
      ),
    );
    set.add(
      collectSbisAttachments(
        doc([{ id: 'ev-2', name: 'Получение', attachments: [att('a-1', { Файл: { Ссылка: 'https://disk.sbis.ru/new' } })] }]),
        T2,
      ),
    );
    const all = set.revisions();
    expect(all).toHaveLength(1);
    expect(set.repeats).toBe(1);
    expect(all[0]).toMatchObject({
      occurrences: 2,
      eventNames: ['Утверждение', 'Получение'],
      incomingReceipt: true,
      link: 'https://disk.sbis.ru/new',
      linkReceivedAt: T2.toISOString(),
    });
  });

  it('новая редакция вложения — отдельная запись, но то же вложение', () => {
    const set = new SbisAttachmentSet();
    set.add(collectSbisAttachments(doc([{ id: 'ev-1', name: 'Получение', attachments: [att('a-1')] }]), T1));
    set.add(
      collectSbisAttachments(
        doc([{ id: 'ev-2', name: 'Получение', attachments: [att('a-1', { Редакция: { Номер: '2' } })] }]),
        T2,
      ),
    );
    expect(set.revisions()).toHaveLength(2);
    expect(set.repeats).toBe(0);
    expect(set.attachmentCount()).toBe(1);
    expect(new Set(set.revisions().map(attachmentKey)).size).toBe(1);
  });

  it('вложение без идентификатора не учитывается, но считается', () => {
    const set = new SbisAttachmentSet();
    set.add(collectSbisAttachments(doc([{ id: 'ev-1', name: 'Получение', attachments: [att('')] }]), T1));
    expect(set.revisions()).toHaveLength(0);
    expect(set.withoutId).toBe(1);
  });
});
