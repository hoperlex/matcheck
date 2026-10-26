// Подсказка «Получатель» по сторонам документов приёмки. Только по ИНН, без
// своей организации, без выбора за человека между разными подрядчиками и
// только когда операционный контрагент с этим ИНН уже есть.
import { describe, expect, it } from 'vitest';
import {
  candidateInns,
  pickRecipientSuggestion,
  type DirectoryContractor,
  type SuggestionDocument,
} from '../src/domain/sourceDocuments/recipient-suggestion.js';

const SU10 = '7736255508';
const STROYSERVIS = '9728074050';
const FORUM = '7719659204';

const directory: DirectoryContractor[] = [
  { id: 'cc-su10', name: 'СУ-10', inn: SU10 },
  { id: 'cc-ss', name: 'ООО "Стройсервис"', inn: `ИНН ${STROYSERVIS}` },
  { id: 'cc-ss-dup', name: 'Стройсервис (дубль)', inn: STROYSERVIS },
  { id: 'cc-forum', name: 'ООО «ФОРУМ-СТОЛИЦА»', inn: FORUM },
];
const own = new Set([SU10]);
const operational = new Set([SU10, STROYSERVIS, FORUM]);

function doc(id: string, buyerInn: string | null, consigneeInn: string | null): SuggestionDocument {
  return { id, buyerInn, consigneeInn };
}

describe('pickRecipientSuggestion', () => {
  it('21514: покупатель — подрядчик из справочника', () => {
    expect(
      pickRecipientSuggestion([doc('d1', STROYSERVIS, STROYSERVIS)], directory, own, operational),
    ).toEqual({
      customerCounterpartyId: 'cc-ss',
      name: 'ООО "Стройсервис"',
      inn: STROYSERVIS,
      from: 'buyer',
      sourceDocumentId: 'd1',
    });
  });

  it('покупатель — СУ-10, грузополучатель — подрядчик: подсказка по грузополучателю', () => {
    expect(
      pickRecipientSuggestion([doc('d1', SU10, FORUM)], directory, own, operational),
    ).toMatchObject({ customerCounterpartyId: 'cc-forum', from: 'consignee' });
  });

  it('только СУ-10 — подсказки нет', () => {
    expect(
      pickRecipientSuggestion([doc('d1', SU10, SU10)], directory, own, operational),
    ).toBeNull();
  });

  it('два документа с разными подрядчиками — не выбираем за человека', () => {
    expect(
      pickRecipientSuggestion(
        [doc('d1', STROYSERVIS, null), doc('d2', FORUM, null)],
        directory,
        own,
        operational,
      ),
    ).toBeNull();
  });

  it('два документа с одним подрядчиком — подсказка', () => {
    expect(
      pickRecipientSuggestion(
        [doc('d1', null, null), doc('d2', STROYSERVIS, null), doc('d3', null, STROYSERVIS)],
        directory,
        own,
        operational,
      ),
    ).toMatchObject({ inn: STROYSERVIS, sourceDocumentId: 'd2' });
  });

  it('ИНН стороны не из справочника или битый — подсказки нет', () => {
    expect(
      pickRecipientSuggestion([doc('d1', '7709938569', '9728074051')], directory, own, operational),
    ).toBeNull();
  });

  it('операционного контрагента с этим ИНН нет — подсказки нет', () => {
    expect(
      pickRecipientSuggestion([doc('d1', STROYSERVIS, null)], directory, own, new Set([SU10])),
    ).toBeNull();
  });

  it('дубли одного ИНН в справочнике — берётся первая запись', () => {
    expect(
      pickRecipientSuggestion([doc('d1', STROYSERVIS, null)], directory, own, operational)
        ?.customerCounterpartyId,
    ).toBe('cc-ss');
  });

  it('без документов — подсказки нет', () => {
    expect(pickRecipientSuggestion([], directory, own, operational)).toBeNull();
  });
});

describe('candidateInns', () => {
  it('валидные ИНН обеих сторон без повторов', () => {
    expect(candidateInns([doc('d1', STROYSERVIS, STROYSERVIS), doc('d2', 'мусор', FORUM)])).toEqual(
      [STROYSERVIS, FORUM],
    );
  });
});
