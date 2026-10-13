/**
 * Проба списка документов Диадока (GetDocuments V3) против реестра выгрузки.
 *
 * Зачем. Реестр edo_export_documents собран по ленте событий, а человек
 * сверяет его с веб-интерфейсом Диадока — со списком документов. Прежде чем
 * строить на списке выгрузку всей истории, проба отвечает на вопросы, от
 * которых зависит её устройство:
 *   1. Видит ли учётка все документы организации (DocumentAccessLevel).
 *   2. С какой даты в ящике есть документы — среди входящих и среди удалённых.
 *   3. Как ведёт себя пагинация на месяце больше 1000 документов: доходит ли
 *      чтение дальше 1000 и сходится ли счёт после деления окна.
 *   4. Совпадает ли месяц по документам с реестром в обе стороны и
 *      расходятся ли реквизиты: номер, дата, функция, сумма и НДС в копейках,
 *      ИНН продавца.
 *   5. Какие статусы у документов и у групп возможных повторов, есть ли у
 *      них связи (InitialDocumentIds, SubordinateDocumentIds, PacketId).
 *   6. Сколько удалённых и какого они направления.
 *
 * Только чтение: ни БД, ни хранилище не меняются. Шаг, упавший на ответе
 * Диадока, записывается в отчёт, и проба идёт дальше; потеря лиза — стоп.
 * Запуск — scripts/edo-list-probe.ts.
 */
import type { DiadocClient } from './diadoc.client.js';
import { REQUIRED_ACCESS_LEVEL } from './check-access.js';
import { diadocTimestampToDate, type DiadocListedDocument } from './diadoc.types.js';
import { metadataMap } from './document-meta.js';
import { EdoLeaseLost } from './inventory.js';
import {
  compareWithRegistry,
  isInbound,
  listedDocumentState,
  normalizeDocNumber,
  type FieldName,
  type FieldVerdict,
} from './list-compare.js';
import {
  LIST_COUNT_CAP,
  countWindow,
  moscowMonthWindow,
  readWindowPages,
  splitToExactWindows,
  ticksToDate,
  type ListFn,
  type TickWindow,
} from './list-windows.js';

/** То, что пробе нужно от учётки: клиент под лизом. */
export type ProbeSession = {
  account: { id: string; name: string };
  boxId: string;
  client: Pick<DiadocClient, 'getMyEmployee' | 'getDocuments'>;
  /** Продлевает лиз; потерян — бросает EdoLeaseLost. */
  ensureLease: () => Promise<void>;
};

const UTD = 'UniversalTransferDocument';
const UTD_REVISION = 'UniversalTransferDocumentRevision';
const SAMPLE = 30;

export type ProbeRegistryRow = {
  message_id: string;
  entity_id: string;
  status: string;
  document_type: string;
  document_number: string | null;
  document_date: string | null;
  document_function: string | null;
  correction_number: string | null;
  total_sum: string | null;
  vat_sum: string | null;
  supplier_inn: string | null;
  supplier_name: string | null;
  seller_inns: string[];
  received_at: Date | null;
};

export type ProbeReport = {
  startedAt: string;
  finishedAt?: string;
  account?: { id: string; name: string; boxId: string };
  month: string;
  window?: { from: string; to: string };
  requests: number;
  steps: Record<string, unknown>;
  errors: { step: string; error: string }[];
  /** Главное в двух словах — печатается в конце и лежит в файле. */
  summary: string[];
};

const key = (messageId: string, entityId: string) => `${messageId}/${entityId}`;
const docKey = (d: DiadocListedDocument) => key(d.MessageId, d.EntityId);

function iso(ticksOrValue: unknown): string | null {
  const date = diadocTimestampToDate(ticksOrValue as string | number | undefined);
  return date ? date.toISOString() : null;
}

function windowIso(w: TickWindow) {
  return { from: ticksToDate(w.from).toISOString(), to: ticksToDate(w.to).toISOString() };
}

/** Коротко о документе: то, по чему его найдёт человек. */
function brief(d: DiadocListedDocument | undefined) {
  if (!d) return null;
  const meta = metadataMap(d.Metadata);
  return {
    messageId: d.MessageId,
    entityId: d.EntityId,
    type: d.TypeNamedId ?? d.DocumentType ?? null,
    function: d.Function ?? null,
    version: d.Version ?? null,
    direction: d.DocumentDirection ?? null,
    delivered: iso(d.DeliveryTimestampTicks),
    number: meta.DocumentNumber ?? d.DocumentNumber ?? null,
    date: meta.DocumentDate ?? d.DocumentDate ?? null,
    sellerInn: meta.SellerInn ?? null,
    title: d.Title ?? null,
  };
}

function tally<T>(items: readonly T[], by: (item: T) => string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = by(item) ?? '(пусто)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function nonEmptyList(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export async function runListProbe(
  session: ProbeSession,
  opts: { month: string; maxRead: number; loadRegistry: () => Promise<ProbeRegistryRow[]> },
  report: ProbeReport,
): Promise<void> {
  const monthArg = opts.month;
  const maxRead = opts.maxRead;
  const { client, boxId, account } = session;
  report.account = { id: account.id, name: account.name, boxId };

  const list: ListFn = async (q) => {
    await session.ensureLease();
    report.requests += 1;
    return client.getDocuments({
      boxId,
      filterCategory: q.filterCategory,
      fromTicks: q.fromTicks,
      toTicks: q.toTicks,
      afterIndexKey: q.afterIndexKey,
      count: q.count,
    });
  };
  const listOpen = async (params: {
    filterCategory: string;
    count: number;
    sortDirection: 'Ascending' | 'Descending';
    afterIndexKey?: string | null;
  }) => {
    await session.ensureLease();
    report.requests += 1;
    return client.getDocuments({ boxId, ...params });
  };

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    console.info(`— ${name}…`);
    try {
      const result = await fn();
      report.steps[name] = result;
      return result;
    } catch (err) {
      if (err instanceof EdoLeaseLost) throw err;
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      report.errors.push({ step: name, error: message });
      console.error(`  шаг «${name}» не прошёл: ${message}`);
      return null;
    }
  }

  // 1. Доступ: без полного доступа список покажет не всё, и сверка соврёт.
  const access = await step('access', async () => {
    await session.ensureLease();
    report.requests += 1;
    const employee = await client.getMyEmployee(boxId);
    const level = employee.Permissions?.DocumentAccessLevel ?? employee.DocumentAccessLevel ?? null;
    report.summary.push(`Доступ: ${level ?? '?'}`);
    return { documentAccessLevel: level, full: level === REQUIRED_ACCESS_LEVEL };
  });
  if (!access?.full) {
    console.error(
      `Доступ учётки «${access?.documentAccessLevel ?? '?'}», нужен ${REQUIRED_ACCESS_LEVEL}: список был бы неполным. Проба остановлена.`,
    );
    return;
  }

  // 2. Границы истории ящика.
  await step('bounds', async () => {
    const out: Record<string, unknown> = {};
    for (const category of [`${UTD}.Inbound`, 'Any.Inbound']) {
      const first = await listOpen({ filterCategory: category, count: 1, sortDirection: 'Ascending' });
      const last = await listOpen({ filterCategory: category, count: 1, sortDirection: 'Descending' });
      out[category] = {
        totalCount: first.TotalCount ?? null,
        hasMoreResults: first.HasMoreResults ?? null,
        first: brief(first.Documents[0]),
        last: brief(last.Documents[0]),
      };
    }
    // Класс Deleted — все направления: самый ранний ВХОДЯЩИЙ ищется листанием.
    for (const category of [`${UTD}.Deleted`, 'Any.Deleted']) {
      let after: string | null = null;
      let firstAny: DiadocListedDocument | undefined;
      let firstInbound: DiadocListedDocument | undefined;
      let totalCount: number | null = null;
      let pages = 0;
      const directions: DiadocListedDocument[] = [];
      while (pages < 10 && !firstInbound) {
        const page = await listOpen({ filterCategory: category, count: 100, sortDirection: 'Ascending', afterIndexKey: after });
        pages += 1;
        totalCount ??= page.TotalCount ?? null;
        if (page.Documents.length === 0) break;
        firstAny ??= page.Documents[0];
        directions.push(...page.Documents);
        firstInbound = page.Documents.find(isInbound);
        after = page.Documents[page.Documents.length - 1]!.IndexKey ?? null;
        if (!after) break;
      }
      out[category] = {
        totalCount,
        pagesRead: pages,
        directionsInReadPages: tally(directions, (d) => d.DocumentDirection ?? null),
        firstAny: brief(firstAny),
        firstInbound: brief(firstInbound),
        firstInboundFound: Boolean(firstInbound),
      };
    }
    return out;
  });

  // 3. Пагинация на месяце.
  const [y, m] = monthArg.split('-').map(Number) as [number, number];
  const window = moscowMonthWindow(y, m);
  report.window = windowIso(window);

  const readCategory = async (category: string) => {
    const splits: unknown[] = [];
    const parts = await splitToExactWindows(list, category, window, {
      onSplit: (w, c) => splits.push({ ...windowIso(w), totalCount: c.total, hasMoreResults: c.hasMoreResults }),
    });
    const documents: DiadocListedDocument[] = [];
    const partReports = [];
    for (const part of parts) {
      const read = await readWindowPages(list, category, part.window);
      partReports.push({ ...windowIso(part.window), total: part.total, read: read.documents.length, pages: read.pageSizes.length });
      documents.push(...read.documents);
    }
    const unique = new Set(documents.map(docKey));
    return {
      documents,
      summary: {
        splits,
        parts: partReports,
        sumOfTotals: parts.reduce((s, p) => s + p.total, 0),
        read: documents.length,
        duplicateKeysAcrossParts: documents.length - unique.size,
        partsWithMismatch: partReports.filter((p) => p.total !== p.read).length,
      },
    };
  };

  let monthDocs: DiadocListedDocument[] = [];
  await step('pagination', async () => {
    const category = `${UTD}.Inbound`;
    const head = await countWindow(list, category, window);
    const unsplit = await readWindowPages(list, category, window, { maxDocuments: maxRead });
    const split = await readCategory(category);
    monthDocs = split.documents;
    const unsplitKeys = new Set(unsplit.documents.map(docKey));
    const splitKeys = new Set(split.documents.map(docKey));
    report.summary.push(
      `Месяц ${monthArg}: первая страница TotalCount=${head.total}, HasMoreResults=${head.hasMoreResults}; ` +
        `без деления прочитано ${unsplit.documents.length} (${unsplit.stopped}); ` +
        `с делением ${split.summary.read} при сумме счётов ${split.summary.sumOfTotals}`,
    );
    return {
      head,
      unsplit: {
        read: unsplit.documents.length,
        stopped: unsplit.stopped,
        pages: unsplit.pageSizes.length,
        pageSizes: unsplit.pageSizes,
        readBeyondCap: unsplit.documents.length > LIST_COUNT_CAP,
      },
      split: split.summary,
      onlyInUnsplit: [...unsplitKeys].filter((k) => !splitKeys.has(k)).length,
      onlyInSplit: unsplit.stopped === 'empty_page' ? [...splitKeys].filter((k) => !unsplitKeys.has(k)).length : null,
    };
  });

  let revisionDocs: DiadocListedDocument[] = [];
  await step('revisions', async () => {
    const r = await readCategory(`${UTD_REVISION}.Inbound`);
    revisionDocs = r.documents;
    return r.summary;
  });

  const deletedDocs: DiadocListedDocument[] = [];
  await step('deleted', async () => {
    const out: Record<string, unknown> = {};
    for (const category of [`${UTD}.Deleted`, `${UTD_REVISION}.Deleted`]) {
      const r = await readCategory(category);
      deletedDocs.push(...r.documents);
      out[category] = {
        ...r.summary,
        inbound: r.documents.filter(isInbound).length,
        directions: tally(r.documents, (d) => d.DocumentDirection ?? null),
      };
    }
    return out;
  });

  // 4. Сверка с реестром.
  const registry = await opts.loadRegistry();
  const byKey = new Map(registry.map((r) => [key(r.message_id, r.entity_id), r]));
  const listed = [...monthDocs, ...revisionDocs];
  const listedKeys = new Set(listed.map(docKey));
  const from = ticksToDate(window.from).getTime();
  const to = ticksToDate(window.to).getTime();
  const inWindow = registry.filter((r) => r.received_at && r.received_at.getTime() >= from && r.received_at.getTime() <= to);

  if (!report.steps.pagination) {
    report.errors.push({ step: 'reconcile', error: 'пропущено: список месяца не прочитан' });
    return;
  }

  await step('reconcile', async () => {
    const missingInRegistry = listed.filter((d) => !byKey.has(docKey(d)));
    const inWindowKeys = new Set(inWindow.map((r) => key(r.message_id, r.entity_id)));
    const outsideWindow = listed.filter((d) => byKey.has(docKey(d)) && !inWindowKeys.has(docKey(d)));
    const deletedInbound = new Set(deletedDocs.filter(isInbound).map(docKey));
    const notListed = inWindow.filter((r) => !listedKeys.has(key(r.message_id, r.entity_id)));

    const fieldStats: Partial<Record<FieldName, Record<FieldVerdict, number>>> = {};
    const fieldSamples: Record<string, unknown[]> = {};
    const receivedDiffs: number[] = [];
    const receivedSamples: unknown[] = [];
    const matchedByStatus: Record<string, number> = {};
    for (const doc of listed) {
      const row = byKey.get(docKey(doc));
      if (!row) continue;
      matchedByStatus[row.status] = (matchedByStatus[row.status] ?? 0) + 1;
      const checks = compareWithRegistry(doc, {
        documentNumber: row.document_number,
        documentDate: row.document_date,
        documentFunction: row.document_function,
        totalSum: row.total_sum,
        vatSum: row.vat_sum,
        sellerInns: row.seller_inns,
      });
      for (const c of checks) {
        const stats = (fieldStats[c.field] ??= { equal: 0, diff: 0, no_data: 0 });
        stats[c.verdict] += 1;
        if (c.verdict !== 'equal') {
          const bucket = (fieldSamples[`${c.field}:${c.verdict}`] ??= []);
          if (bucket.length < 10) {
            bucket.push({ key: docKey(doc), supplier: row.supplier_name, number: row.document_number, diadoc: c.diadoc, registry: c.registry, status: row.status });
          }
        }
      }
      const delivered = diadocTimestampToDate(doc.DeliveryTimestampTicks);
      if (delivered && row.received_at) {
        const diff = Math.abs(delivered.getTime() - row.received_at.getTime());
        receivedDiffs.push(diff);
        if (diff >= 1000 && receivedSamples.length < 10) {
          receivedSamples.push({ key: docKey(doc), delivered: delivered.toISOString(), registry: row.received_at.toISOString() });
        }
      }
    }

    report.summary.push(
      `Сверка: в списке ${listed.length}, в реестре за месяц ${inWindow.length}; ` +
        `нет в реестре ${missingInRegistry.length}; нет в списке ${notListed.length}; ` +
        `расхождений реквизитов: ${Object.entries(fieldStats)
          .map(([f, v]) => `${f} ${v.diff}`)
          .join(', ')}`,
    );
    return {
      listed: listed.length,
      registryInWindow: inWindow.length,
      registryInWindowByStatus: tally(inWindow, (r) => r.status),
      matched: listed.length - missingInRegistry.length,
      matchedByRegistryStatus: matchedByStatus,
      listedNotInRegistry: {
        count: missingInRegistry.length,
        byType: tally(missingInRegistry, (d) => d.TypeNamedId ?? null),
        byState: tally(missingInRegistry, (d) => {
          const s = listedDocumentState(d);
          return `${s.revocation ?? '-'} | ${s.recipientResponse ?? '-'} | test=${s.isTest}`;
        }),
        samples: missingInRegistry.slice(0, SAMPLE).map(brief),
      },
      listedInRegistryOutsideWindow: {
        count: outsideWindow.length,
        samples: outsideWindow.slice(0, 10).map((d) => ({ ...brief(d), registryReceivedAt: byKey.get(docKey(d))?.received_at?.toISOString() ?? null })),
      },
      registryNotListed: {
        count: notListed.length,
        foundAmongDeletedInbound: notListed.filter((r) => deletedInbound.has(key(r.message_id, r.entity_id))).length,
        byStatus: tally(notListed, (r) => r.status),
        samples: notListed.slice(0, SAMPLE).map((r) => ({
          key: key(r.message_id, r.entity_id),
          status: r.status,
          type: r.document_type,
          supplier: r.supplier_name,
          inn: r.supplier_inn,
          number: r.document_number,
          date: r.document_date,
          receivedAt: r.received_at?.toISOString() ?? null,
          deleted: deletedInbound.has(key(r.message_id, r.entity_id)),
        })),
      },
      fields: fieldStats,
      fieldSamples,
      receivedAt: {
        compared: receivedDiffs.length,
        exact: receivedDiffs.filter((d) => d < 1000).length,
        maxDiffSeconds: receivedDiffs.length ? Math.max(...receivedDiffs) / 1000 : null,
        samples: receivedSamples,
      },
    };
  });

  // 5. Статусы и группы возможных повторов.
  await step('statuses', async () => {
    const states = listed.map((d) => ({ d, s: listedDocumentState(d) }));
    const listedByKey = new Map(listed.map((d) => [docKey(d), d]));
    const groupKey = (r: ProbeRegistryRow) =>
      [r.supplier_inn ?? '', normalizeDocNumber(r.document_number) ?? '', r.document_date ?? '', r.document_function ?? '', r.correction_number ?? '', r.document_type].join('|');
    const groups = new Map<string, ProbeRegistryRow[]>();
    for (const r of registry) {
      if (r.status !== 'stored' && r.status !== 'not_in_list') continue;
      const g = groupKey(r);
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    const touched = [...groups.values()].filter(
      (rows) => rows.length > 1 && rows.some((r) => listedByKey.has(key(r.message_id, r.entity_id))),
    );
    const memberState = (r: ProbeRegistryRow) => {
      const d = listedByKey.get(key(r.message_id, r.entity_id));
      if (!d) return 'не в окне';
      const s = listedDocumentState(d);
      if (s.revocation === 'RevocationAccepted') return 'аннулирован';
      if (s.isDeleted) return 'удалён';
      return s.recipientResponse ?? '-';
    };
    const patterns = tally(touched, (rows) => rows.map(memberState).sort().join(' + '));
    const fullyListed = touched.filter((rows) => rows.every((r) => listedByKey.has(key(r.message_id, r.entity_id))));
    const exactlyOneValid = fullyListed.filter(
      (rows) => rows.filter((r) => !['аннулирован', 'удалён', 'RecipientSignatureRequestRejected'].includes(memberState(r))).length === 1,
    ).length;
    const withLinks = touched.filter((rows) =>
      rows.some((r) => {
        const d = listedByKey.get(key(r.message_id, r.entity_id));
        return d && (nonEmptyList(d.InitialDocumentIds) || nonEmptyList(d.SubordinateDocumentIds));
      }),
    ).length;
    const sharedPacket = touched.filter((rows) => {
      const packets = rows.map((r) => listedByKey.get(key(r.message_id, r.entity_id))?.PacketId).filter(Boolean);
      return packets.length > 1 && new Set(packets).size < packets.length;
    }).length;

    return {
      month: {
        recipientResponse: tally(states, (x) => x.s.recipientResponse),
        revocation: tally(states, (x) => x.s.revocation),
        docflowText: tally(states, (x) => x.s.docflowText),
        isDeleted: tally(states, (x) => String(x.s.isDeleted)),
        isTest: tally(states, (x) => String(x.s.isTest)),
        function: tally(states, (x) => x.d.Function ?? null),
        version: tally(states, (x) => x.d.Version ?? null),
        department: tally(states, (x) => (x.d.DepartmentId ? 'подразделение' : 'головное')),
        withInitialIds: states.filter((x) => nonEmptyList(x.d.InitialDocumentIds)).length,
        withSubordinateIds: states.filter((x) => nonEmptyList(x.d.SubordinateDocumentIds)).length,
        withPacketId: states.filter((x) => x.d.PacketId).length,
      },
      duplicateGroups: {
        touchingMonth: touched.length,
        fullyInMonth: fullyListed.length,
        exactlyOneNotRejectedOrRevoked: exactlyOneValid,
        withLinks,
        sharedPacket,
        patterns,
        samples: touched.slice(0, 15).map((rows) =>
          rows.map((r) => {
            const d = listedByKey.get(key(r.message_id, r.entity_id));
            return {
              key: key(r.message_id, r.entity_id),
              supplier: r.supplier_name,
              number: r.document_number,
              date: r.document_date,
              total: r.total_sum,
              receivedAt: r.received_at?.toISOString() ?? null,
              state: d ? listedDocumentState(d) : null,
              packetId: d?.PacketId ?? null,
              initialIds: d?.InitialDocumentIds ?? null,
              subordinateIds: d?.SubordinateDocumentIds ?? null,
            };
          }),
        ),
      },
    };
  });

  // 7. Сырые документы — чтобы схема выпуска Р опиралась на факт, а не на документацию.
  report.steps.rawSamples = monthDocs.slice(0, 3);
}
