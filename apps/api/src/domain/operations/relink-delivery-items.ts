/**
 * Ремонт приёмки: вернуть строкам привязку к позициям документа.
 *
 * Откуда потери. Планшет на 2 Этапе присылал строки, которые сервер не узнавал
 * по id, без происхождения и с «шт» вместо единицы документа, и запасной ключ
 * сопоставления («название|единица|номер») на них промахивался. Строки уезжали в
 * блок «без привязки к документу», а у УПД оставалось «0 из N» (боевая 24687).
 * Сервер это больше не теряет (item-origin.ts, шаги 2б и сопоставление при
 * создании), но накопленное правка не чинит.
 *
 * Правка подтверждённой приёмки — решение владельца, поэтому ремонт адресный:
 * одна приёмка, пары «строка приёмки → позиция документа» задаёт человек (их
 * печатает scripts/report-unlinked-delivery-items.ts). Всё — одной транзакцией,
 * и любое несовпадение отменяет её ЦЕЛИКОМ, включая уже поднятую версию:
 *
 *  1. версия приёмки равна ожидаемой, документ всё ещё к ней привязан; версия
 *     поднимается сразу — клиент со старым снимком, присылающий `baseVersion`,
 *     получит 409, а не перезапишет ремонт;
 *  2. строка документа под FOR SHARE: переразбор не начнётся, пока идёт ремонт
 *     (порядок блокировок «приёмка → документ → позиции», как у upsert);
 *  3. позиции из пар на месте, принадлежат этому документу, и их ровно столько,
 *     сколько пар;
 *  4. строк в приёмке ровно столько, сколько пар, и ни у одной нет
 *     происхождения;
 *  5. ни одна позиция не занята строкой какой-либо приёмки;
 *  6. каждая пара совпадает по названию, количеству и цене — иначе это не та
 *     строка;
 *  7. обновлено ровно столько строк, сколько пар.
 *
 * `material_id` не трогаем: у обычных привязанных строк он тоже пуст.
 */

import type postgres from 'postgres';

export type RelinkPair = { itemId: string; sourceDocumentItemId: string };

export type RelinkInput = {
  deliveryId: string;
  documentId: string;
  expectedVersion: number;
  pairs: readonly RelinkPair[];
};

export type RelinkedRow = {
  itemId: string;
  sourceDocumentItemId: string;
  nameRaw: string;
  unitBefore: string;
  unitAfter: string;
};

export type RelinkResult = { versionAfter: number; rows: RelinkedRow[] };

/** Ремонт отказался: состояние не то, на которое он рассчитан. Ничего не изменено. */
export class RelinkRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelinkRefusedError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Литерал массива uuid без сериализации массивов драйвером (ср. supplier-contracts/apply.ts). */
function uuidArray(ids: readonly string[]): string {
  return ids.join(',');
}

/** Проверка входа до похода в БД: формат и взаимная уникальность пар. */
export function assertRelinkInput(input: RelinkInput): void {
  const ids = [
    input.deliveryId,
    input.documentId,
    ...input.pairs.flatMap((p) => [p.itemId, p.sourceDocumentItemId]),
  ];
  const bad = ids.find((id) => !UUID_RE.test(id));
  if (bad !== undefined) throw new RelinkRefusedError(`не uuid: ${bad}`);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new RelinkRefusedError('ожидаемая версия должна быть целым числом ≥ 1');
  }
  if (input.pairs.length === 0) throw new RelinkRefusedError('не задано ни одной пары');
  if (new Set(input.pairs.map((p) => p.itemId)).size !== input.pairs.length) {
    throw new RelinkRefusedError('строка приёмки повторяется в парах');
  }
  if (new Set(input.pairs.map((p) => p.sourceDocumentItemId)).size !== input.pairs.length) {
    throw new RelinkRefusedError('позиция документа повторяется в парах');
  }
}

/**
 * Выполняет ремонт внутри переданной транзакции. Бросает [RelinkRefusedError],
 * если хоть одно условие не выполнено, — вызывающий обязан дать транзакции
 * откатиться.
 */
export async function relinkDeliveryItems(
  tx: postgres.TransactionSql,
  input: RelinkInput,
): Promise<RelinkResult> {
  assertRelinkInput(input);
  const { deliveryId, documentId, expectedVersion, pairs } = input;
  const itemIds = pairs.map((p) => p.itemId);
  const sdiIds = pairs.map((p) => p.sourceDocumentItemId);

  // 1. Версия и связь. UPDATE берёт блокировку строки приёмки первым делом.
  const bumped = await tx<{ version: number }[]>`
    UPDATE deliveries SET version = version + 1, updated_at = now()
     WHERE id = ${deliveryId} AND version = ${expectedVersion}
       AND EXISTS (SELECT 1 FROM delivery_sources
                    WHERE delivery_id = ${deliveryId} AND source_document_id = ${documentId})
    RETURNING version`;
  if (bumped.length !== 1) {
    throw new RelinkRefusedError(
      `версия приёмки не ${expectedVersion} или документ к ней не привязан`,
    );
  }

  // 2. Документ: переразбор подождёт конца ремонта.
  const doc = await tx`
    SELECT id FROM source_documents WHERE id = ${documentId} FOR SHARE`;
  if (doc.length !== 1) throw new RelinkRefusedError('документа нет');

  // 3. Позиции документа на месте.
  const docItems = await tx<{ id: string; source_document_id: string }[]>`
    SELECT id, source_document_id FROM source_document_items
     WHERE id = ANY(string_to_array(${uuidArray(sdiIds)}, ',')::uuid[])
     FOR KEY SHARE`;
  if (
    docItems.length !== pairs.length ||
    docItems.some((r) => r.source_document_id !== documentId)
  ) {
    throw new RelinkRefusedError('позиции документа не найдены или принадлежат другому документу');
  }

  // 4. Состав строк приёмки.
  const items = await tx<
    {
      id: string;
      name_raw: string;
      unit: string;
      source_document_id: string | null;
      source_document_item_id: string | null;
    }[]
  >`
    SELECT id, name_raw, unit, source_document_id, source_document_item_id
      FROM delivery_items WHERE delivery_id = ${deliveryId}`;
  if (items.length !== pairs.length) {
    throw new RelinkRefusedError(
      `в приёмке ${items.length} строк, а пар ${pairs.length} — состав изменился`,
    );
  }
  if (items.some((r) => r.source_document_id !== null || r.source_document_item_id !== null)) {
    throw new RelinkRefusedError('у строки приёмки уже есть привязка');
  }
  const byId = new Map(items.map((r) => [r.id, r]));
  if (itemIds.some((id) => !byId.has(id))) {
    throw new RelinkRefusedError('строка из пары не принадлежит этой приёмке');
  }

  // 5. Позиции никем не заняты.
  const taken = await tx`
    SELECT 1 FROM delivery_items
     WHERE source_document_item_id = ANY(string_to_array(${uuidArray(sdiIds)}, ',')::uuid[])
     LIMIT 1`;
  if (taken.length > 0) throw new RelinkRefusedError('позиция документа уже занята другой строкой');

  // 6–7. Пары совпадают по названию, количеству и цене — только тогда меняем.
  // Единица из документа: строка потеряла её вместе с привязкой. Пустую
  // единицу документа не переносим — колонка в приёмке NOT NULL.
  const updated = await tx<{ id: string; source_document_item_id: string; unit: string }[]>`
    UPDATE delivery_items di
       SET source_document_id = sdi.source_document_id,
           source_document_item_id = sdi.id,
           unit = COALESCE(NULLIF(btrim(sdi.unit), ''), di.unit)
      FROM source_document_items sdi,
           unnest(string_to_array(${uuidArray(itemIds)}, ',')::uuid[],
                  string_to_array(${uuidArray(sdiIds)}, ',')::uuid[]) AS p(item_id, sdi_id)
     WHERE di.id = p.item_id AND sdi.id = p.sdi_id
       AND di.delivery_id = ${deliveryId}
       AND sdi.source_document_id = ${documentId}
       AND di.source_document_id IS NULL
       AND di.name_raw = sdi.name_raw
       AND di.qty_actual IS NOT DISTINCT FROM sdi.qty
       AND di.price IS NOT DISTINCT FROM sdi.price
    RETURNING di.id, di.source_document_item_id, di.unit`;
  if (updated.length !== pairs.length) {
    throw new RelinkRefusedError(
      `пары не совпали по названию, количеству или цене: подходит ${updated.length} из ${pairs.length}`,
    );
  }

  const rows: RelinkedRow[] = updated.map((u) => {
    const before = byId.get(u.id)!;
    return {
      itemId: u.id,
      sourceDocumentItemId: u.source_document_item_id,
      nameRaw: before.name_raw,
      unitBefore: before.unit,
      unitAfter: u.unit,
    };
  });
  return { versionAfter: bumped[0]!.version, rows };
}
