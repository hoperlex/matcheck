/**
 * Сборка данных приёмки для 1С — чистая функция над тем, что прочитал
 * export-loader.ts в одном снимке БД.
 *
 * Единица документа 1С — пара «приёмка + группа»: группа на каждый документ
 * приёмки (связанный сейчас или оставшийся в происхождении строк) плюс группа
 * `nodoc` для строк без документа. Документ без строк даёт пустую группу, а не
 * исчезает: иначе 1С не узнала бы, что связь есть.
 */
import {
  effectiveDocumentRecipient,
  type DeliveryPurpose,
  type OnecContract,
  type OnecDelivery,
  type OnecDocument,
  type OnecEdo,
  type OnecGroup,
  type OnecLine,
  type OnecLineWarning,
  type OnecParty,
  type OnecRecipient,
  type OnecTotals,
} from '@matcheck/contracts';
import { add, format, mul, parseDec, round, shift, type Dec } from './money.js';
import { vatMismatch, vatRateKind } from './vat.js';

export type RawCounterparty = { id: string; inn: string | null; kpp: string | null; name: string };
export type RawMol = { id: string; name: string };

export type RawHeader = {
  id: string;
  displayId: number;
  statusCode: string;
  confirmedAt: string | null;
  arrivedAt: string | null;
  pendingDeletionAt: string | null;
  siteCode: string;
  siteName: string;
  fotSiteId: number | null;
  purpose: string | null;
  supplier: RawCounterparty | null;
  contractor: RawCounterparty | null;
  mol: RawMol | null;
  sourceShipmentId: string | null;
  sourceShipmentDisplayId: number | null;
};

export type RawItem = {
  lineNo: number;
  nameRaw: string;
  material: { id: string; code: string | null; name: string } | null;
  unit: string | null;
  qtyPlanned: string | null;
  qtyActual: string | null;
  price: string | null;
  vatRate: string | null;
  vatSum: string | null;
  itemKind: string;
  inventoryNumber: string | null;
  serialNumber: string | null;
  sourceDocumentId: string | null;
};

export type RawLink = {
  sourceDocumentId: string;
  ownRecipient: boolean;
  contractor: RawCounterparty | null;
  mol: RawMol | null;
  ownPurpose: boolean;
  purpose: string | null;
};

export type RawDocument = {
  id: string;
  kind: string;
  number: string | null;
  date: string | null;
  totalSum: string | null;
  vatSum: string | null;
  supplier: OnecParty;
  buyer: OnecParty;
  consignee: OnecParty;
};

export type RawContract = OnecContract & { sourceDocumentId: string | null };

export type RawEdo = Omit<OnecEdo, 'xmlPath'> & { sectionDocumentId: string | null };

export type RawBundle = {
  header: RawHeader;
  items: RawItem[];
  links: RawLink[];
  /** Документы приёмки (связанные ∪ из происхождения строк), без технических. */
  documents: Map<string, RawDocument>;
  contracts: RawContract[];
  edo: RawEdo[];
  sharedWith: Map<string, { id: string; displayId: number }[]>;
  duplicates: Map<string, string[]>;
  okeiByUnit: Map<string, string>;
};

/** Всё, кроме блоков, зависящих от состояния выгрузки и хеша. */
export type OnecDeliveryBody = Omit<OnecDelivery, 'contentHash' | 'hashVersion' | 'export'>;

export function edoXmlPath(deliveryId: string, matchId: string): string {
  return `/api/v1/integration/1c/deliveries/${deliveryId}/edo/${matchId}/xml`;
}

// ─────────────────────────── Строки и итоги ──────────────────────────────

/**
 * Деньги строки. Опора для 1С — суммы, цены справочные:
 *  - sumExVat = round_half_up(qty × price, 2);
 *  - vatSum — как хранится (портал берёт НДС из документа, у ~20% строк он
 *    не равен «сумма × ставка» — пересчитывать нельзя); при нулевой ставке и
 *    пустом НДС — 0.00;
 *  - sumWithVat — только когда известны обе части;
 *  - priceWithVat — только при ставке в СТРОКЕ, 4 знака, как у цены.
 */
export function buildLine(raw: RawItem, okeiByUnit: Map<string, string>): OnecLine {
  const qtyRaw = raw.qtyActual ?? raw.qtyPlanned;
  const qty = parseDec(qtyRaw);
  const price = parseDec(raw.price);
  const rate = parseDec(raw.vatRate);
  const kind = vatRateKind(raw.vatRate);
  const storedVat = parseDec(raw.vatSum);

  const sumExVat = qty && price ? round(mul(qty, price), 2) : null;
  const vatSum: Dec | null = storedVat
    ? round(storedVat, 2)
    : kind === 'zero_or_exempt'
      ? { v: 0n, s: 2 }
      : null;
  const sumWithVat = sumExVat && vatSum ? add(sumExVat, vatSum) : null;
  const priceWithVat =
    price && rate && kind !== 'unknown'
      ? round(shift(mul(price, add({ v: 100n, s: 0 }, rate)), 2), 4)
      : null;

  const warnings: OnecLineWarning[] = [];
  if (!qty) warnings.push('no_qty');
  if (!price) warnings.push('no_price');
  if (kind === 'unknown') warnings.push('no_vat_rate');
  if (!vatSum) warnings.push('no_vat_sum');
  if (sumExVat && rate && kind === 'percent' && storedVat && vatMismatch(sumExVat, rate, storedVat)) {
    warnings.push('vat_mismatch');
  }

  return {
    lineNo: raw.lineNo,
    name: raw.nameRaw,
    material: raw.material,
    unit: raw.unit,
    okei: raw.unit ? (okeiByUnit.get(raw.unit.trim().toLowerCase()) ?? null) : null,
    qty: qty ? qtyRaw : null,
    qtyPlanned: raw.qtyPlanned,
    qtyActual: raw.qtyActual,
    price: raw.price,
    priceWithVat: priceWithVat ? format(priceWithVat, 4) : null,
    vatRate: raw.vatRate,
    vatRateKind: kind,
    sumExVat: sumExVat ? format(sumExVat, 2) : null,
    vatSum: vatSum ? format(vatSum, 2) : null,
    sumWithVat: sumWithVat ? format(sumWithVat, 2) : null,
    itemKind: raw.itemKind,
    inventoryNumber: raw.inventoryNumber,
    serialNumber: raw.serialNumber,
    warnings,
  };
}

/** Итоги — суммы уже округлённых строк; отсутствующее нулём не считается. */
export function buildTotals(lines: readonly OnecLine[]): OnecTotals {
  let sumExVat: Dec | null = null;
  let vatSum: Dec | null = null;
  let sumWithVat: Dec | null = null;
  let linesWithSum = 0;
  let linesWithVat = 0;
  let linesComplete = 0;
  for (const l of lines) {
    const s = parseDec(l.sumExVat);
    const v = parseDec(l.vatSum);
    const w = parseDec(l.sumWithVat);
    if (s) {
      linesWithSum += 1;
      sumExVat = sumExVat ? add(sumExVat, s) : s;
    }
    if (v) {
      linesWithVat += 1;
      vatSum = vatSum ? add(vatSum, v) : v;
    }
    if (w) {
      linesComplete += 1;
      sumWithVat = sumWithVat ? add(sumWithVat, w) : w;
    }
  }
  return {
    linesTotal: lines.length,
    linesWithSum,
    linesWithVat,
    linesComplete,
    sumExVat: sumExVat ? format(sumExVat, 2) : null,
    vatSum: vatSum ? format(vatSum, 2) : null,
    sumWithVat: sumWithVat ? format(sumWithVat, 2) : null,
    complete: lines.length > 0 && linesComplete === lines.length,
  };
}

// ─────────────────────────── Стороны ─────────────────────────────────────

function recipientOf(contractor: RawCounterparty | null, mol: RawMol | null): OnecRecipient {
  if (contractor) {
    return { kind: 'contractor', inn: contractor.inn, kpp: contractor.kpp, name: contractor.name, molId: null };
  }
  if (mol) return { kind: 'mol', inn: null, kpp: null, name: mol.name, molId: mol.id };
  return { kind: 'none', inn: null, kpp: null, name: null, molId: null };
}

function partyOf(cp: RawCounterparty | null): OnecParty | null {
  return cp ? { inn: cp.inn, kpp: cp.kpp, name: cp.name } : null;
}

function toContract(c: RawContract): OnecContract {
  return {
    onecId: c.onecId,
    counterpartyOnecId: c.counterpartyOnecId,
    number: c.number,
    date: c.date,
    name: c.name,
  };
}

/**
 * Получатель и признак документа — тем же правилом, что портал
 * (effectiveDocumentRecipient): собственные значения документа, иначе общие.
 * Документ, оставшийся только в происхождении строк (отвязан), наследует общие.
 */
function documentRecipient(
  header: RawHeader,
  link: RawLink | undefined,
): { recipient: OnecRecipient; purpose: string | null } {
  const general = {
    contractorId: header.contractor?.id ?? null,
    recipientMolId: header.mol?.id ?? null,
    purpose: header.purpose as DeliveryPurpose | null,
  };
  if (!link) return { recipient: recipientOf(header.contractor, header.mol), purpose: header.purpose };
  const eff = effectiveDocumentRecipient(general, {
    ownRecipient: link.ownRecipient,
    contractorId: link.contractor?.id ?? null,
    recipientMolId: link.mol?.id ?? null,
    ownPurpose: link.ownPurpose,
    purpose: link.purpose as DeliveryPurpose | null,
  });
  const contractors = [link.contractor, header.contractor].filter(Boolean) as RawCounterparty[];
  const mols = [link.mol, header.mol].filter(Boolean) as RawMol[];
  const contractor = contractors.find((c) => c.id === eff.contractorId) ?? null;
  const mol = mols.find((m) => m.id === eff.recipientMolId) ?? null;
  return { recipient: recipientOf(contractor, mol), purpose: eff.purpose };
}

// ─────────────────────────── Сборка ──────────────────────────────────────

function compareDocs(a: RawDocument, b: RawDocument): number {
  const da = a.date ?? '9999-12-31';
  const db = b.date ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  const na = a.number ?? '';
  const nb = b.number ?? '';
  if (na !== nb) return na < nb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareLines(a: OnecLine, b: OnecLine): number {
  if (a.lineNo !== b.lineNo) return a.lineNo - b.lineNo;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function buildDeliveryBody(bundle: RawBundle, snapshotAt: string): OnecDeliveryBody {
  const { header } = bundle;
  const linkByDoc = new Map(bundle.links.map((l) => [l.sourceDocumentId, l]));
  const generalContract = bundle.contracts.find((c) => c.sourceDocumentId === null) ?? null;
  const contractByDoc = new Map(
    bundle.contracts.filter((c) => c.sourceDocumentId !== null).map((c) => [c.sourceDocumentId!, c]),
  );

  const docs = [...bundle.documents.values()].sort(compareDocs);
  const docIds = new Set(docs.map((d) => d.id));

  const linesByDoc = new Map<string, OnecLine[]>();
  const noDocLines: OnecLine[] = [];
  for (const item of bundle.items) {
    const line = buildLine(item, bundle.okeiByUnit);
    if (item.sourceDocumentId && docIds.has(item.sourceDocumentId)) {
      const list = linesByDoc.get(item.sourceDocumentId) ?? [];
      list.push(line);
      linesByDoc.set(item.sourceDocumentId, list);
    } else {
      noDocLines.push(line);
    }
  }

  const edoByDoc = new Map<string, OnecEdo[]>();
  const deliveryEdo: OnecEdo[] = [];
  for (const raw of bundle.edo) {
    const { sectionDocumentId, ...rest } = raw;
    const edo: OnecEdo = {
      ...rest,
      xmlPath: raw.xmlAvailable ? edoXmlPath(header.id, raw.matchId) : null,
    };
    if (sectionDocumentId && docIds.has(sectionDocumentId)) {
      const list = edoByDoc.get(sectionDocumentId) ?? [];
      list.push(edo);
      edoByDoc.set(sectionDocumentId, list);
    } else {
      deliveryEdo.push(edo);
    }
  }

  const groups: OnecGroup[] = docs.map((doc) => {
    const link = linkByDoc.get(doc.id);
    const { recipient, purpose } = documentRecipient(header, link);
    const own = contractByDoc.get(doc.id);
    // Договор документа наследует общий, как в портале (adb25e2): своего нет —
    // действует общий.
    const contract = own ?? generalContract;
    const document: OnecDocument = {
      id: doc.id,
      kind: doc.kind,
      number: doc.number,
      date: doc.date,
      linked: Boolean(link),
      dedupKey: { supplierInn: doc.supplier.inn, number: doc.number, date: doc.date },
      portalDuplicates: [...(bundle.duplicates.get(doc.id) ?? [])].sort(),
      supplier: doc.supplier,
      buyer: doc.buyer,
      consignee: doc.consignee,
      recipient,
      purpose,
      contract: contract ? toContract(contract) : null,
      printedTotals: { totalSum: doc.totalSum, vatSum: doc.vatSum },
      sharedWith: (bundle.sharedWith.get(doc.id) ?? [])
        .filter((d) => d.id !== header.id)
        .sort((a, b) => a.displayId - b.displayId),
      edo: edoByDoc.get(doc.id) ?? [],
    };
    const lines = (linesByDoc.get(doc.id) ?? []).sort(compareLines);
    return { groupKey: `doc:${doc.id}`, document, lines, totals: buildTotals(lines) };
  });
  if (noDocLines.length > 0) {
    const lines = noDocLines.sort(compareLines);
    groups.push({ groupKey: 'nodoc', document: null, lines, totals: buildTotals(lines) });
  }

  return {
    id: header.id,
    displayId: header.displayId,
    status: header.statusCode,
    confirmedAt: header.confirmedAt,
    arrivedAt: header.arrivedAt,
    snapshotAt,
    deletion: header.pendingDeletionAt ? { pendingSince: header.pendingDeletionAt } : null,
    operation: header.sourceShipmentId ? 'transfer' : 'supply',
    sourceShipmentDisplayId: header.sourceShipmentDisplayId,
    site: { code: header.siteCode, name: header.siteName, fotSiteId: header.fotSiteId },
    purpose: header.purpose,
    supplier: partyOf(header.supplier),
    recipient: recipientOf(header.contractor, header.mol),
    contract: generalContract ? toContract(generalContract) : null,
    edo: deliveryEdo,
    groups,
    totals: buildTotals(groups.flatMap((g) => g.lines)),
  };
}
