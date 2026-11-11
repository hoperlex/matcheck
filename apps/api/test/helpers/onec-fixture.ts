/**
 * Полностью заполненная приёмка для тестов выгрузки в 1С: ни одного пустого
 * объекта — тест классификации полей хеша должен видеть каждое поле ответа.
 */
import type { RawBundle, RawItem } from '../../src/domain/onec/export-payload.js';

export const DELIVERY_ID = '11111111-1111-4111-8111-111111111111';
export const DOC_LINKED = '22222222-2222-4222-8222-222222222222';
export const DOC_MENTIONED = '33333333-3333-4333-8333-333333333333';

export function item(patch: Partial<RawItem> = {}): RawItem {
  return {
    lineNo: 1,
    nameRaw: 'Арматура А500С d12',
    material: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', code: 'ARM12', name: 'Арматура 12' },
    unit: 'т',
    qtyPlanned: '2.0000',
    qtyActual: '1.5000',
    price: '65000.0000',
    vatRate: '20.00',
    vatSum: '19500.00',
    itemKind: 'material',
    inventoryNumber: 'INV-1',
    serialNumber: 'SN-1',
    sourceDocumentId: DOC_LINKED,
    ...patch,
  };
}

export function fullBundle(): RawBundle {
  const contractor = { id: 'c0000000-0000-4000-8000-000000000001', inn: '7700000001', kpp: '770001001', name: 'ПОДРЯДЧИК ООО' };
  const ownContractor = { id: 'c0000000-0000-4000-8000-000000000002', inn: '7700000002', kpp: '770001002', name: 'СВОЙ ПОДРЯДЧИК' };
  return {
    header: {
      id: DELIVERY_ID,
      displayId: 24508,
      statusCode: 'confirmed_mol',
      confirmedAt: '2026-11-11T08:00:00.000000Z',
      arrivedAt: '2026-11-11T07:00:00.000000Z',
      pendingDeletionAt: '2026-11-12T07:00:00.000000Z',
      siteCode: 'ЗИЛ33',
      siteName: 'ЗИЛ, корпус 33',
      fotSiteId: 42,
      purpose: 'own_forces',
      supplier: { id: 's0000000-0000-4000-8000-000000000001', inn: '5000000001', kpp: '500001001', name: 'ПОСТАВЩИК ООО' },
      contractor,
      mol: null,
      sourceShipmentId: 'f0000000-0000-4000-8000-000000000001',
      sourceShipmentDisplayId: 777,
    },
    items: [
      item(),
      item({ lineNo: 2, nameRaw: 'Без ставки', vatRate: null, vatSum: null }),
      item({ lineNo: 3, nameRaw: 'Без документа', sourceDocumentId: null, vatRate: '0.00', vatSum: null }),
    ],
    links: [
      {
        sourceDocumentId: DOC_LINKED,
        ownRecipient: true,
        contractor: ownContractor,
        mol: null,
        ownPurpose: true,
        purpose: 'realization',
      },
    ],
    documents: new Map([
      [
        DOC_LINKED,
        {
          id: DOC_LINKED,
          kind: 'upd',
          number: 'УТ-4308',
          date: '2026-11-10',
          totalSum: '117000.00',
          vatSum: '19500.00',
          supplier: { inn: '5000000001', kpp: '500001001', name: 'ПОСТАВЩИК ООО' },
          buyer: { inn: '7736255508', kpp: '773601001', name: 'СУ-10' },
          consignee: { inn: '7736255508', kpp: '773601001', name: 'СУ-10' },
        },
      ],
      [
        DOC_MENTIONED,
        {
          id: DOC_MENTIONED,
          kind: 'upd',
          number: 'УТ-4309',
          date: '2026-11-11',
          totalSum: '1.00',
          vatSum: '0.17',
          supplier: { inn: '5000000001', kpp: '500001001', name: 'ПОСТАВЩИК ООО' },
          buyer: { inn: '7736255508', kpp: '773601001', name: 'СУ-10' },
          consignee: { inn: '7736255508', kpp: '773601001', name: 'СУ-10' },
        },
      ],
    ]),
    contracts: [
      {
        sourceDocumentId: null,
        onecId: 'e0000000-0000-4000-8000-000000000001',
        counterpartyOnecId: 'e0000000-0000-4000-8000-000000000002',
        number: 'СУ-ЗИЛ/25-40',
        date: '2025-01-15',
        name: 'Договор поставки',
      },
      {
        sourceDocumentId: DOC_LINKED,
        onecId: 'e0000000-0000-4000-8000-000000000003',
        counterpartyOnecId: 'e0000000-0000-4000-8000-000000000004',
        number: 'Лот33',
        date: '2025-02-01',
        name: 'Договор по лоту',
      },
    ],
    edo: [
      {
        matchId: 'd0000000-0000-4000-8000-000000000001',
        sectionDocumentId: DOC_LINKED,
        exportDocumentId: 'd1000000-0000-4000-8000-000000000001',
        sourceDocumentId: 'd2000000-0000-4000-8000-000000000001',
        operator: 'diadoc',
        number: 'УТ-4308',
        date: '2026-11-10',
        correctionNumber: '1',
        supplierInn: '5000000001',
        totalSum: '117000.00',
        vatSum: '19500.00',
        sha256: 'a'.repeat(64),
        sizeBytes: 5000,
        xmlAvailable: true,
      },
      {
        matchId: 'd0000000-0000-4000-8000-000000000002',
        sectionDocumentId: null,
        exportDocumentId: 'd1000000-0000-4000-8000-000000000002',
        sourceDocumentId: 'd2000000-0000-4000-8000-000000000002',
        operator: 'sbis',
        number: '57/50126',
        date: '2026-11-09',
        correctionNumber: '2',
        supplierInn: '5000000003',
        totalSum: '10.00',
        vatSum: '1.67',
        sha256: 'b'.repeat(64),
        sizeBytes: 4000,
        xmlAvailable: true,
      },
    ],
    sharedWith: new Map([
      [
        DOC_LINKED,
        [
          { id: DELIVERY_ID, displayId: 24508 },
          { id: '44444444-4444-4444-8444-444444444444', displayId: 24510 },
        ],
      ],
    ]),
    duplicates: new Map([[DOC_LINKED, ['55555555-5555-4555-8555-555555555555']]]),
    okeiByUnit: new Map([['т', '168']]),
  };
}
