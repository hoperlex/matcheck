/**
 * Единица измерения позиции при деструктивном upsert.
 *
 * Зачем нужно. Планшет теряет единицу на финализации 2 Этапа: форма несёт её
 * верно, но при сборке запроса поле не передаётся и подставляется «шт». На бою
 * за 30 дней так испорчено 2989 позиций из 3068 — «84 м» кабеля становились
 * «84 шт», «30 м³» плит — «30 шт». Приёмки, не дошедшие до 2 Этапа, единицу
 * сохраняют полностью, поэтому источник потери однозначен.
 *
 * Правило намеренно узкое, и каждое ограничение защищает от своего сценария:
 *
 *  - только присланное «шт». Любая другая единица — это осознанный ввод, его
 *    не трогаем;
 *  - только строки с ПОДТВЕРЖДЁННОЙ привязкой. Присланный клиентом
 *    `sourceDocumentItemId` — ключ восстановления, а не доверенное значение
 *    (см. item-origin.ts), поэтому работаем по результату `resolveItemOrigins`;
 *  - строка документа обязана принадлежать ИМЕННО тому документу, что записан
 *    в происхождении: `source_document_id` и `source_document_item_id` — два
 *    независимых внешних ключа, и БД их согласованность не гарантирует;
 *  - документ обязан быть в актуальных связях операции: у отвязанного документа
 *    позиции остаются со своим происхождением, но подтягивать из него данные
 *    уже нельзя.
 *
 * Ограничения «запрос от планшета» и «статус confirmed_mol» живут в маршруте:
 * это свойства запроса, а не позиций. На портале единицу выбирают руками, и
 * осознанное «шт» менеджера обязано сохраниться.
 */

import type { ItemOrigin } from './item-origin.js';

/** Позиция документа, как она лежит в БД. */
export type DocumentItemUnit = {
  id: string;
  sourceDocumentId: string;
  unit: string | null;
};

export type UnitDecision = {
  /** Индекс позиции во входящем списке. */
  index: number;
  /** Единица, которую надо записать вместо присланной. */
  unit: string;
  /** Что прислал клиент — для лога и shadow-отчёта. */
  incomingUnit: string;
  sourceDocumentItemId: string;
};

/** Сравнение единиц без оглядки на регистр и лишние пробелы. */
function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

const LOST_UNIT = 'шт';

/**
 * Какие позиции получают единицу из документа.
 *
 * Возвращает только те, что реально надо поменять: пустой массив означает
 * «ничего не трогаем». Вызывающий сам решает, применить решения (`on`) или
 * только сосчитать (`shadow`).
 *
 * @param incoming позиции запроса, в том же порядке, что и `origins`
 * @param origins результат resolveItemOrigins — источник истины о привязке
 * @param documentItems строки документов, загруженные по origins
 * @param linkedDocumentIds документы, привязанные к операции СЕЙЧАС
 */
export function resolveItemUnits(args: {
  incoming: readonly { unit: string }[];
  origins: readonly ItemOrigin[];
  documentItems: readonly DocumentItemUnit[];
  linkedDocumentIds: readonly string[];
}): UnitDecision[] {
  const { incoming, origins, documentItems, linkedDocumentIds } = args;
  const linked = new Set(linkedDocumentIds);
  const docItemById = new Map(documentItems.map((r) => [r.id, r]));

  const decisions: UnitDecision[] = [];
  incoming.forEach((item, index) => {
    // Клиент прислал осмысленную единицу — вмешиваться не во что.
    if (!sameUnit(item.unit, LOST_UNIT)) return;

    const origin = origins[index];
    const docItemId = origin?.sourceDocumentItemId;
    const docId = origin?.sourceDocumentId;
    if (!docItemId || !docId) return;
    if (!linked.has(docId)) return;

    const row = docItemById.get(docItemId);
    // Строка документа должна принадлежать тому же документу, что и
    // происхождение: два независимых FK согласованность не гарантируют.
    if (!row || row.sourceDocumentId !== docId) return;

    const unit = row.unit?.trim();
    if (!unit) return;
    if (sameUnit(unit, LOST_UNIT)) return;

    decisions.push({
      index,
      unit,
      incomingUnit: item.unit,
      sourceDocumentItemId: docItemId,
    });
  });
  return decisions;
}

/** Идентификаторы строк документа, которые нужно загрузить для решения. */
export function documentItemIdsForUnits(args: {
  incoming: readonly { unit: string }[];
  origins: readonly ItemOrigin[];
}): string[] {
  const ids = new Set<string>();
  args.incoming.forEach((item, index) => {
    if (!sameUnit(item.unit, LOST_UNIT)) return;
    const id = args.origins[index]?.sourceDocumentItemId;
    if (id) ids.add(id);
  });
  return [...ids];
}

/**
 * Решения для одного upsert: сама загружает нужные строки документа.
 *
 * Загрузчик инжектируется — модуль остаётся чистым и тестируется без БД, а
 * маршруты приёмок и отгрузок используют один и тот же код.
 *
 * В режиме `off` не делает НИ ОДНОГО запроса: выключенный рубильник не должен
 * стоить лишнего похода в базу на каждом сохранении. То же и когда «шт» никто
 * не присылал — тогда и решать нечего.
 */
export async function decideUnitsFromDocument(args: {
  mode: 'off' | 'shadow' | 'on';
  incoming: readonly { unit: string }[];
  origins: readonly ItemOrigin[];
  linkedDocumentIds: readonly string[];
  loadDocumentItems: (ids: readonly string[]) => Promise<readonly DocumentItemUnit[]>;
}): Promise<UnitDecision[]> {
  if (args.mode === 'off') return [];
  const ids = documentItemIdsForUnits({ incoming: args.incoming, origins: args.origins });
  if (ids.length === 0) return [];
  const documentItems = await args.loadDocumentItems(ids);
  return resolveItemUnits({
    incoming: args.incoming,
    origins: args.origins,
    documentItems,
    linkedDocumentIds: args.linkedDocumentIds,
  });
}
