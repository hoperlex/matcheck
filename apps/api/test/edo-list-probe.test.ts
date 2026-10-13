/**
 * Проба списка документов на фейковом Диадоке: все шаги проходят и считают то,
 * что должны. Проба запускается на бою один раз, и упасть там на опечатке —
 * значит потерять круг «деплой → запуск → отчёт».
 *
 * Фейк ведёт себя как V3 по документации: больше 1000 → TotalCount = 1000 и
 * HasMoreResults = true; границы по времени включительные; Deleted — все
 * направления.
 */
import { describe, expect, it } from 'vitest';
import type { GetDocumentsParams } from '../src/domain/edo/diadoc.client.js';
import type { DiadocDocumentList, DiadocListedDocument } from '../src/domain/edo/diadoc.types.js';
import { EdoLeaseLost } from '../src/domain/edo/inventory.js';
import { runListProbe, type ProbeRegistryRow, type ProbeReport } from '../src/domain/edo/list-probe.js';
import { moscowMonthWindow, ticksToDate } from '../src/domain/edo/list-windows.js';

const SEPT = moscowMonthWindow(2026, 9);

type Doc = DiadocListedDocument & { ticks: bigint };

function makeDoc(i: number, ticks: bigint, extra: Partial<DiadocListedDocument> = {}): Doc {
  return {
    MessageId: `m-${i}`,
    EntityId: `e-${i}`,
    IndexKey: `k-${i}`,
    TypeNamedId: 'UniversalTransferDocument',
    Function: 'СЧФДОП',
    DocumentDirection: 'Inbound',
    DeliveryTimestampTicks: ticks.toString(),
    RecipientResponseStatus: 'WithRecipientSignature',
    RevocationStatus: 'RevocationStatusNone',
    Metadata: [
      { Key: 'DocumentNumber', Value: `N-${i}` },
      { Key: 'DocumentDate', Value: '15.09.2026' },
      { Key: 'TotalSum', Value: '100.00' },
      { Key: 'TotalVat', Value: '16.67' },
      { Key: 'SellerInn', Value: '7842224734' },
    ],
    ...extra,
    ticks,
  } as Doc;
}

const N = 1200;
const span = SEPT.to - SEPT.from;
const utd: Doc[] = Array.from({ length: N }, (_, i) => makeDoc(i, SEPT.from + (span * BigInt(i)) / BigInt(N)));
// Отказ в подписи у копии из группы возможных повторов (документы 0 и 1).
utd[0] = makeDoc(0, utd[0]!.ticks, { RecipientResponseStatus: 'RecipientSignatureRequestRejected' });
const revisions: Doc[] = [makeDoc(9000, SEPT.from + 100n, { TypeNamedId: 'UniversalTransferDocumentRevision' })];
const deleted: Doc[] = [
  makeDoc(9100, SEPT.from + 200n, { IsDeleted: true }),
  makeDoc(9101, SEPT.from + 300n, { IsDeleted: true, DocumentDirection: 'Outbound' }),
];

const BY_CATEGORY: Record<string, Doc[]> = {
  'UniversalTransferDocument.Inbound': utd,
  'Any.Inbound': [...utd, ...revisions],
  'UniversalTransferDocumentRevision.Inbound': revisions,
  'UniversalTransferDocument.Deleted': deleted,
  'Any.Deleted': deleted,
};

function fakeClient(level = 'AllDocuments') {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    getMyEmployee: async () => ({ Permissions: { DocumentAccessLevel: level } }),
    getDocuments: async (p: GetDocumentsParams): Promise<DiadocDocumentList> => {
      requests += 1;
      const all = [...(BY_CATEGORY[p.filterCategory] ?? [])].sort((a, b) =>
        a.ticks < b.ticks ? -1 : a.ticks > b.ticks ? 1 : 0,
      );
      if (p.sortDirection === 'Descending') all.reverse();
      const found = all.filter(
        (d) => (p.fromTicks == null || d.ticks >= p.fromTicks) && (p.toTicks == null || d.ticks <= p.toTicks),
      );
      const start = p.afterIndexKey ? found.findIndex((d) => d.IndexKey === p.afterIndexKey) + 1 : 0;
      return {
        Documents: found.slice(start, start + (p.count ?? 100)),
        TotalCount: Math.min(found.length, 1000),
        HasMoreResults: found.length > 1000,
      };
    },
  };
}

function registryRow(d: Doc, extra: Partial<ProbeRegistryRow> = {}): ProbeRegistryRow {
  return {
    message_id: d.MessageId,
    entity_id: d.EntityId,
    status: 'stored',
    document_type: 'UniversalTransferDocument',
    document_number: `n-${d.MessageId.slice(2)}`,
    document_date: '2026-09-15',
    document_function: 'СЧФДОП',
    correction_number: null,
    total_sum: '100.00',
    vat_sum: '16.67',
    supplier_inn: '7842224734',
    supplier_name: 'ТД Электротехмонтаж',
    seller_inns: ['7842224734'],
    received_at: ticksToDate(d.ticks),
    ...extra,
  };
}

function registry(): ProbeRegistryRow[] {
  const rows = utd.slice(0, N - 1).map((d) => registryRow(d)); // последнего документа в реестре нет
  rows[5] = registryRow(utd[5]!, { total_sum: '100.01' }); // копейка
  // Документы 0 и 1 — возможный повтор: тот же поставщик, номер, дата, функция.
  rows[0] = registryRow(utd[0]!, { document_number: 'ПОВТОР-1' });
  rows[1] = registryRow(utd[1]!, { document_number: 'повтор-1 ' });
  rows.push(registryRow(revisions[0]!, { document_type: 'UniversalTransferDocumentRevision' }));
  // Удалённый входящий: в реестре есть, в списке входящих его нет.
  rows.push(registryRow(deleted[0]!));
  return rows;
}

function newReport(): ProbeReport {
  return { startedAt: '', month: '2026-09', requests: 0, steps: {}, errors: [], summary: [] };
}

describe('проба списка документов', () => {
  it('все шаги проходят и считают то, что должны', async () => {
    const client = fakeClient();
    let leaseRenewals = 0;
    const report = newReport();
    await runListProbe(
      {
        account: { id: 'acc', name: 'Диадок_СУ10' },
        boxId: 'box',
        client,
        ensureLease: async () => {
          leaseRenewals += 1;
        },
      },
      { month: '2026-09', maxRead: 3000, loadRegistry: async () => registry() },
      report,
    );

    expect(report.errors).toEqual([]);
    // Лиз продлевается перед каждым запросом к Диадоку.
    expect(leaseRenewals).toBe(client.requests + 1 /* GetMyEmployee */);
    expect(report.requests).toBe(leaseRenewals);

    // Отчёт — свободный JSON для человека; здесь важны значения, а не типы.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = report.steps as Record<string, any>;
    expect(steps.access).toEqual({ documentAccessLevel: 'AllDocuments', full: true });

    expect(steps.bounds['UniversalTransferDocument.Inbound'].first.messageId).toBe('m-0');
    expect(steps.bounds['UniversalTransferDocument.Inbound'].last.messageId).toBe(`m-${N - 1}`);
    expect(steps.bounds['UniversalTransferDocument.Deleted'].firstInbound.messageId).toBe('m-9100');

    expect(steps.pagination.head).toEqual({ total: 1000, hasMoreResults: true, exact: false });
    expect(steps.pagination.unsplit.read).toBe(N);
    expect(steps.pagination.unsplit.readBeyondCap).toBe(true);
    expect(steps.pagination.split.read).toBe(N);
    expect(steps.pagination.split.sumOfTotals).toBe(N);
    expect(steps.pagination.split.duplicateKeysAcrossParts).toBe(0);
    expect(steps.pagination.split.partsWithMismatch).toBe(0);

    expect(steps.deleted['UniversalTransferDocument.Deleted'].read).toBe(2);
    expect(steps.deleted['UniversalTransferDocument.Deleted'].inbound).toBe(1);

    expect(steps.reconcile.listed).toBe(N + 1);
    expect(steps.reconcile.listedNotInRegistry.count).toBe(1);
    expect(steps.reconcile.listedNotInRegistry.samples[0].messageId).toBe(`m-${N - 1}`);
    expect(steps.reconcile.registryNotListed.count).toBe(1);
    expect(steps.reconcile.registryNotListed.foundAmongDeletedInbound).toBe(1);
    expect(steps.reconcile.fields.total).toEqual({ equal: N - 1, diff: 1, no_data: 0 });
    // У пары повторов номер в реестре свой («ПОВТОР-1»), в Диадоке — N-0 и N-1.
    expect(steps.reconcile.fields.number).toEqual({ equal: N - 2, diff: 2, no_data: 0 });
    expect(steps.reconcile.receivedAt.exact).toBe(N);

    expect(steps.statuses.duplicateGroups.touchingMonth).toBe(1);
    expect(steps.statuses.duplicateGroups.exactlyOneNotRejectedOrRevoked).toBe(1);
    expect(steps.statuses.month.recipientResponse.RecipientSignatureRequestRejected).toBe(1);

    expect(steps.rawSamples).toHaveLength(3);
    expect(report.summary.join('\n')).toContain('нет в реестре 1');
  });

  it('неполный доступ — проба останавливается после первого шага', async () => {
    const client = fakeClient('SelectedDepartments');
    const report = newReport();
    await runListProbe(
      { account: { id: 'acc', name: 'x' }, boxId: 'box', client, ensureLease: async () => {} },
      { month: '2026-09', maxRead: 3000, loadRegistry: async () => [] },
      report,
    );
    expect(client.requests).toBe(0);
    expect(Object.keys(report.steps)).toEqual(['access']);
  });

  it('потеря лиза — стоп, а не «шаг не прошёл»', async () => {
    let calls = 0;
    const report = newReport();
    const run = runListProbe(
      {
        account: { id: 'acc', name: 'x' },
        boxId: 'box',
        client: fakeClient(),
        ensureLease: async () => {
          calls += 1;
          if (calls > 3) throw new EdoLeaseLost();
        },
      },
      { month: '2026-09', maxRead: 3000, loadRegistry: async () => [] },
      report,
    );
    await expect(run).rejects.toBeInstanceOf(EdoLeaseLost);
    expect(report.errors).toEqual([]);
  });
});
