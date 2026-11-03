/**
 * Эталоны приёмки для сверки с УПД из ЭДО: бумажные УПД, распознанные фото и
 * реквизиты самой приёмки.
 *
 * Сборка одна (`buildReferences`), источников строк два: одна приёмка (подбор
 * УПД к приёмке, edo-candidates.ts) и пачка приёмок (подсказка «к каким ещё
 * приёмкам эта УПД», edo-share.ts). Так обе стороны сверяют по одному правилу.
 */
import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import {
  counterparties,
  deliveries,
  deliveryPhotos,
  deliverySources,
  edoAccounts,
  photoRecognizedItems,
  sourceDocuments,
  suppliers,
} from '../../db/schema.js';
import { normalizeDocumentNumber, validInns, type MatchReference } from './edo-match.js';

const MSK_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' });

export function mskDate(value: Date | null): string | null {
  return value ? MSK_DATE.format(value) : null;
}

export function isoDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

export type LoadedReferences = {
  delivery: {
    siteId: string;
    arrivedDate: string | null;
    createdDate: string;
    contractorId: string | null;
  };
  references: MatchReference[];
};

type DeliveryRow = {
  siteId: string;
  arrivedAt: Date | null;
  createdAt: Date;
  supplierId: string | null;
  contractorId: string | null;
};

type SupplierRow = { name: string | null; inn: string | null };

type PaperRow = {
  docNumber: string | null;
  docDate: Date | null;
  totalSum: string | null;
  innRaw: string | null;
  directoryInn: string | null;
  directoryName: string | null;
  supplierInn: string | null;
  supplierName: string | null;
};

type PhotoRow = { docNumber: string | null; docDate: string | null; totalSum: string | null };

/** Сборка эталонов из прочитанных строк — без обращений к базе. */
export function buildReferences(input: {
  delivery: DeliveryRow;
  ownSupplier: SupplierRow | undefined;
  paperRows: readonly PaperRow[];
  photoRows: readonly PhotoRow[];
  /** Проверенные ИНН организаций-владельцев ящиков ЭДО. */
  orgInns: ReadonlySet<string>;
}): LoadedReferences {
  const { delivery, ownSupplier, paperRows, photoRows, orgInns } = input;
  // ИНН самой организации (владельца ящика ЭДО) в графе поставщика — это
  // распознанный ИНН покупателя. Эталоном он сделал бы правильную УПД «чужой».
  const supplierInnsOf = (values: readonly (string | null | undefined)[]) => {
    const checked = validInns(values);
    const inns = checked.inns.filter((inn) => !orgInns.has(inn));
    return { inns, unreadable: checked.unreadable || (checked.inns.length > 0 && !inns.length) };
  };

  const arrivedDate = mskDate(delivery.arrivedAt);
  const own = supplierInnsOf([ownSupplier?.inn]);
  const ownNames = ownSupplier?.name ? [ownSupplier.name] : [];

  const references: MatchReference[] = paperRows.map((paper) => {
    // Каждый ИНН проверяется отдельно: битый `supplier_inn_raw` не должен
    // перекрывать верный ИНН справочника, как это делал coalesce.
    const checked = supplierInnsOf([
      paper.innRaw,
      paper.directoryInn,
      paper.supplierInn,
      ownSupplier?.inn,
    ]);
    return {
      origin: 'paper',
      label: paper.docNumber,
      numbers: paper.docNumber ? [paper.docNumber] : [],
      date: isoDate(paper.docDate),
      inns: checked.inns,
      innUnreadable: checked.unreadable,
      names: [paper.directoryName, paper.supplierName, ...ownNames].filter(
        (name): name is string => !!name,
      ),
      sums: paper.totalSum ? [paper.totalSum] : [],
      arrivedDate,
    };
  });

  // Страницы одной УПД на разных фото — один эталон. Склеиваем только по
  // полному номеру и той же дате: по одним цифрам номера склеились бы
  // разные документы.
  const paperKeys = new Set(
    references.map((ref) => `${normalizeDocumentNumber(ref.label)}|${ref.date ?? ''}`),
  );
  const photoGroups = new Map<string, MatchReference>();
  for (const photo of photoRows) {
    const full = normalizeDocumentNumber(photo.docNumber);
    if (!full) continue;
    const date = isoDate(photo.docDate);
    const key = `${full}|${date ?? ''}`;
    if (paperKeys.has(key)) continue;
    const group = photoGroups.get(key);
    if (group) {
      if (photo.totalSum) group.sums.push(photo.totalSum);
      continue;
    }
    photoGroups.set(key, {
      origin: 'photo',
      label: photo.docNumber,
      numbers: [photo.docNumber!],
      date,
      inns: own.inns,
      innUnreadable: own.unreadable,
      names: ownNames,
      sums: photo.totalSum ? [photo.totalSum] : [],
      arrivedDate,
    });
  }
  references.push(...photoGroups.values());

  if (!references.length) {
    references.push({
      origin: 'delivery',
      label: null,
      numbers: [],
      date: null,
      inns: own.inns,
      innUnreadable: own.unreadable,
      names: ownNames,
      sums: [],
      arrivedDate,
    });
  }

  return {
    delivery: {
      siteId: delivery.siteId,
      arrivedDate,
      createdDate: mskDate(delivery.createdAt)!,
      contractorId: delivery.contractorId,
    },
    references,
  };
}

const deliveryColumns = {
  siteId: deliveries.siteId,
  arrivedAt: deliveries.arrivedAt,
  createdAt: deliveries.createdAt,
  supplierId: deliveries.supplierId,
  contractorId: deliveries.contractorId,
};

function paperSelection() {
  const paperDirectory = alias(suppliers, 'paper_directory');
  const paperSupplier = alias(counterparties, 'paper_supplier');
  return {
    paperDirectory,
    paperSupplier,
    columns: {
      docNumber: sourceDocuments.docNumber,
      docDate: sourceDocuments.docDate,
      totalSum: sourceDocuments.totalSum,
      innRaw: sourceDocuments.supplierInnRaw,
      directoryInn: paperDirectory.inn,
      directoryName: paperDirectory.name,
      supplierInn: paperSupplier.inn,
      supplierName: paperSupplier.name,
    },
  };
}

const photoColumns = {
  docNumber: photoRecognizedItems.docNumber,
  docDate: photoRecognizedItems.docDate,
  totalSum: photoRecognizedItems.totalSum,
};

async function loadOrgInns(db: Db): Promise<Set<string>> {
  const orgRows = await db.select({ inn: edoAccounts.orgInn }).from(edoAccounts);
  return new Set(validInns(orgRows.map((row) => row.inn)).inns);
}

/**
 * Эталоны подбора. С `sectionDocumentId` — только документ этого блока
 * материалов, любого вида (накладная тоже), без фото: номера с фото относятся
 * к другим документам приёмки. Что документ связан с приёмкой, проверяет маршрут.
 */
export async function loadReferences(
  db: Db,
  deliveryId: string,
  sectionDocumentId?: string,
): Promise<LoadedReferences | null> {
  const [delivery] = await db
    .select(deliveryColumns)
    .from(deliveries)
    .where(eq(deliveries.id, deliveryId))
    .limit(1);
  if (!delivery) return null;

  const [ownSupplier] = delivery.supplierId
    ? await db
        .select({ name: counterparties.name, inn: counterparties.inn })
        .from(counterparties)
        .where(eq(counterparties.id, delivery.supplierId))
        .limit(1)
    : [];

  const paper = paperSelection();
  const paperRows = await db
    .select(paper.columns)
    .from(deliverySources)
    .innerJoin(sourceDocuments, eq(deliverySources.sourceDocumentId, sourceDocuments.id))
    .leftJoin(
      paper.paperDirectory,
      eq(sourceDocuments.supplierDirectoryId, paper.paperDirectory.id),
    )
    .leftJoin(paper.paperSupplier, eq(sourceDocuments.supplierId, paper.paperSupplier.id))
    .where(
      sectionDocumentId
        ? and(eq(deliverySources.deliveryId, deliveryId), eq(sourceDocuments.id, sectionDocumentId))
        : and(
            eq(deliverySources.deliveryId, deliveryId),
            eq(sourceDocuments.kind, 'upd'),
            ne(sourceDocuments.origin, 'edo_diadoc'),
          ),
    );

  const photoRows = sectionDocumentId
    ? []
    : await db
        .select(photoColumns)
        .from(deliveryPhotos)
        .innerJoin(
          photoRecognizedItems,
          eq(photoRecognizedItems.deliveryPhotoId, deliveryPhotos.id),
        )
        .where(
          and(eq(deliveryPhotos.deliveryId, deliveryId), isNotNull(photoRecognizedItems.docNumber)),
        );

  return buildReferences({
    delivery,
    ownSupplier,
    paperRows,
    photoRows,
    orgInns: await loadOrgInns(db),
  });
}

/**
 * Эталоны нескольких приёмок сразу — те же выборки, что у `loadReferences`
 * без блока, одним запросом на каждую. Приёмки, которой нет, в ответе нет.
 */
export async function loadReferencesForDeliveries(
  db: Db,
  deliveryIds: readonly string[],
): Promise<Map<string, LoadedReferences>> {
  const result = new Map<string, LoadedReferences>();
  const ids = [...new Set(deliveryIds)];
  if (!ids.length) return result;

  const deliveryRows = await db
    .select({ id: deliveries.id, ...deliveryColumns })
    .from(deliveries)
    .where(inArray(deliveries.id, ids));
  if (!deliveryRows.length) return result;

  const supplierIds = [
    ...new Set(deliveryRows.map((row) => row.supplierId).filter((id): id is string => !!id)),
  ];
  const supplierRows = supplierIds.length
    ? await db
        .select({ id: counterparties.id, name: counterparties.name, inn: counterparties.inn })
        .from(counterparties)
        .where(inArray(counterparties.id, supplierIds))
    : [];
  const supplierById = new Map(supplierRows.map((row) => [row.id, row]));

  const paper = paperSelection();
  const paperRows = await db
    .select({ deliveryId: deliverySources.deliveryId, ...paper.columns })
    .from(deliverySources)
    .innerJoin(sourceDocuments, eq(deliverySources.sourceDocumentId, sourceDocuments.id))
    .leftJoin(
      paper.paperDirectory,
      eq(sourceDocuments.supplierDirectoryId, paper.paperDirectory.id),
    )
    .leftJoin(paper.paperSupplier, eq(sourceDocuments.supplierId, paper.paperSupplier.id))
    .where(
      and(
        inArray(deliverySources.deliveryId, ids),
        eq(sourceDocuments.kind, 'upd'),
        ne(sourceDocuments.origin, 'edo_diadoc'),
      ),
    );

  const photoRows = await db
    .select({ deliveryId: deliveryPhotos.deliveryId, ...photoColumns })
    .from(deliveryPhotos)
    .innerJoin(photoRecognizedItems, eq(photoRecognizedItems.deliveryPhotoId, deliveryPhotos.id))
    .where(and(inArray(deliveryPhotos.deliveryId, ids), isNotNull(photoRecognizedItems.docNumber)));

  const orgInns = await loadOrgInns(db);
  const group = <T extends { deliveryId: string }>(rows: readonly T[]) => {
    const byDelivery = new Map<string, T[]>();
    for (const row of rows) {
      const list = byDelivery.get(row.deliveryId) ?? [];
      list.push(row);
      byDelivery.set(row.deliveryId, list);
    }
    return byDelivery;
  };
  const paperBy = group(paperRows);
  const photoBy = group(photoRows);

  for (const { id, ...delivery } of deliveryRows) {
    result.set(
      id,
      buildReferences({
        delivery,
        ownSupplier: delivery.supplierId ? supplierById.get(delivery.supplierId) : undefined,
        paperRows: paperBy.get(id) ?? [],
        photoRows: photoBy.get(id) ?? [],
        orgInns,
      }),
    );
  }
  return result;
}
