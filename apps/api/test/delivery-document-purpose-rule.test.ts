import { describe, expect, it } from 'vitest';
import {
  allowedDeliveryPurposes,
  deliveryRecipientKind,
  effectiveDocumentRecipient,
  reconcileDocumentPurpose,
  type DeliveryPurpose,
  type DocumentRecipientState,
} from '@matcheck/contracts';

const recipient = (kind: 'none' | 'contractor' | 'mol') => ({
  contractorId: kind === 'contractor' ? 'contractor' : null,
  recipientMolId: kind === 'mol' ? 'mol' : null,
});
const purposes: (DeliveryPurpose | null)[] = [
  null,
  'own_forces',
  'realization',
  'tolling_act',
  'contractor_materials',
  'realization_tolling',
];

describe('признак связанного документа', () => {
  it('наследование и свой NULL имеют разные действующие значения', () => {
    const general = { ...recipient('mol'), purpose: 'own_forces' as const };
    const doc: DocumentRecipientState = {
      ownRecipient: false,
      contractorId: null,
      recipientMolId: null,
      ownPurpose: true,
      purpose: null,
    };
    expect(effectiveDocumentRecipient(general, doc).purpose).toBeNull();
    expect(effectiveDocumentRecipient(general, { ...doc, ownPurpose: false }).purpose).toBe(
      'own_forces',
    );
  });

  for (const previous of ['none', 'contractor', 'mol'] as const) {
    for (const next of ['none', 'contractor', 'mol'] as const) {
      for (const ownRecipient of [false, true]) {
        for (const ownPurpose of [false, true]) {
          for (const purpose of purposes) {
            it(`${previous} → ${next}, свой получатель=${ownRecipient}, свой признак=${ownPurpose}, ${purpose ?? '—'}`, () => {
              const beforeGeneral = {
                ...recipient(previous),
                purpose: previous === 'contractor' ? null : ('realization' as DeliveryPurpose),
              };
              const afterGeneral = {
                ...recipient(next),
                purpose: next === 'contractor' ? null : ('own_forces' as DeliveryPurpose),
              };
              const doc: DocumentRecipientState = {
                ownRecipient,
                ...recipient(ownRecipient ? 'contractor' : 'none'),
                ownPurpose,
                purpose: ownPurpose ? purpose : null,
              };
              const out = reconcileDocumentPurpose(beforeGeneral, afterGeneral, doc, doc);
              const effective = effectiveDocumentRecipient(afterGeneral, out);
              const kind = deliveryRecipientKind(effective);
              if (effective.purpose)
                expect(allowedDeliveryPurposes(kind)).toContain(effective.purpose);
              if (ownRecipient && ownPurpose && purpose !== 'own_forces') {
                expect(out.ownRecipient).toBe(true);
              }
            });
          }
        }
      }
    }
  }

  it('смена получателя документа на МОЛ ставит свой «Свои силы», не трогая флаг получателя', () => {
    const general = { ...recipient('contractor'), purpose: 'realization' as const };
    const before: DocumentRecipientState = {
      ownRecipient: false,
      ...recipient('none'),
      ownPurpose: false,
      purpose: null,
    };
    const next: DocumentRecipientState = { ...before, ownRecipient: true, ...recipient('mol') };
    expect(reconcileDocumentPurpose(general, general, before, next)).toMatchObject({
      ownRecipient: true,
      recipientMolId: 'mol',
      ownPurpose: true,
      purpose: 'own_forces',
    });
  });

  it('общий признак «Свои силы» со своим подрядчиком даёт собственный NULL', () => {
    const beforeGeneral = { ...recipient('mol'), purpose: 'realization' as const };
    const afterGeneral = { ...recipient('mol'), purpose: 'own_forces' as const };
    const doc: DocumentRecipientState = {
      ownRecipient: true,
      ...recipient('contractor'),
      ownPurpose: false,
      purpose: null,
    };
    expect(reconcileDocumentPurpose(beforeGeneral, afterGeneral, doc, doc)).toMatchObject({
      ownRecipient: true,
      ownPurpose: true,
      purpose: null,
    });
  });
});
