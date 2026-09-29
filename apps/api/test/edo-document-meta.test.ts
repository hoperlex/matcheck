/**
 * Что Диадок сообщает о документе до скачивания.
 *
 * Номер и дата живут в коллекции Metadata, прямые поля устарели; время — у
 * документа и сообщения, а не у события. Проба 25.09 и разведка 24.09 искали
 * всё это не там и получили пустоту.
 */
import { describe, it, expect } from 'vitest';
import {
  flattenForDisplay,
  metadataMap,
  normalizeDocumentInfo,
} from '../src/domain/edo/document-meta.js';
import { dateToDiadocTicks } from '../src/domain/edo/diadoc.types.js';

const DELIVERED = new Date('2026-08-26T09:15:00.000Z');
const SENT = new Date('2026-08-26T09:00:00.000Z');

function entity(info: Record<string, unknown>) {
  return { EntityId: 'e', DocumentInfo: info } as never;
}

describe('метаданные документа', () => {
  it('номер и дата — из Metadata, устаревшие поля — запасной путь', () => {
    const fromMeta = normalizeDocumentInfo(
      entity({
        DocumentNumber: 'СТАРОЕ',
        Metadata: [
          { Key: 'DocumentNumber', Value: 'ЦБ-674' },
          { Key: 'DocumentDate', Value: '26.08.2026' },
          { Key: 'TotalSum', Value: '1657534.40' },
        ],
      }),
      {},
    );
    expect(fromMeta).toMatchObject({
      number: 'ЦБ-674',
      date: '26.08.2026',
      numberSource: 'metadata',
      totalSum: '1657534.40',
    });

    const legacy = normalizeDocumentInfo(
      entity({ DocumentNumber: 'УТ-1', DocumentDate: '01.09.2026' }),
      {},
    );
    expect(legacy).toMatchObject({ number: 'УТ-1', numberSource: 'legacy' });
    expect(normalizeDocumentInfo(entity({}), {}).numberSource).toBeNull();
  });

  it('время — доставка документа, иначе время сообщения', () => {
    const delivered = normalizeDocumentInfo(
      entity({ DeliveryTimestampTicks: dateToDiadocTicks(DELIVERED) }),
      { TimestampTicks: dateToDiadocTicks(SENT) },
    );
    expect(delivered.receivedAt?.toISOString()).toBe(DELIVERED.toISOString());
    expect(delivered.receivedAtSource).toBe('delivery');

    const fromMessage = normalizeDocumentInfo(entity({}), { TimestampTicks: dateToDiadocTicks(SENT) });
    expect(fromMessage.receivedAt?.toISOString()).toBe(SENT.toISOString());
    expect(fromMessage.receivedAtSource).toBe('message');
  });

  it('тест — у сообщения или у документа; аннулирован — только завершённое', () => {
    expect(normalizeDocumentInfo(entity({}), { IsTest: true }).isTest).toBe(true);
    expect(normalizeDocumentInfo(entity({ IsTest: true }), {}).isTest).toBe(true);
    expect(
      normalizeDocumentInfo(entity({ RevocationStatus: 'RevocationAccepted' }), {}).revoked,
    ).toBe(true);
    const asked = normalizeDocumentInfo(entity({ RevocationStatus: 'RevocationIsRequestedByMe' }), {});
    expect([asked.revoked, asked.revocationStatus]).toEqual([false, 'RevocationIsRequestedByMe']);
  });

  it('чужая форма Metadata не роняет разбор', () => {
    expect(metadataMap({ DocumentNumber: 'A-1', Nested: { x: 1 } })).toEqual({ DocumentNumber: 'A-1' });
    expect(metadataMap('мусор')).toEqual({});
    expect(metadataMap([{ Key: 'K' }, null, { Key: 'N', Value: 5 }])).toEqual({ N: '5' });
  });
});

describe('сырые поля для показа', () => {
  it('содержимое файла не показывается, предел соблюдается', () => {
    const fields = flattenForDisplay({
      Entity: { EntityId: 'e', Content: { Data: 'AAAA', Size: 4 }, DocumentInfo: { Metadata: [{ Key: 'K', Value: 'V' }] } },
    });
    expect(fields).toEqual([
      { path: 'Entity.EntityId', value: 'e' },
      { path: 'Entity.DocumentInfo.Metadata[0].Key', value: 'K' },
      { path: 'Entity.DocumentInfo.Metadata[0].Value', value: 'V' },
    ]);
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
    expect(flattenForDisplay(many, 150)).toHaveLength(150);
  });
});
