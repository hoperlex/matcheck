import {
  matchPhotoRows,
  unitKey,
  type PhotoLinkedDocument,
  type PhotoRecognitionItem,
  type UpdCheckName,
  type UpdValidation,
} from '@matcheck/contracts';

/**
 * Что показать у строки таблицы, распознанной с фото документа.
 *
 * Два источника. Сверка сумм самого фото (`validation.checks`) — в ней
 * `scope.row` равен индексу строки + 1, а не номеру, напечатанному в графе 1.
 * И строка УПД этой же операции (`linkedDocument`), если она нашлась и
 * отличается количеством или единицей: в приёмке 22246 фото 1 этапа дало 16
 * вместо 204, а 2 этапа — «3 шт» вместо «204 пог.м». Единицу сверка сумм не
 * проверяет вовсе, расхождение с УПД — единственный сигнал.
 */
export type PhotoRowHint = {
  /** Проваленные проверки этой строки — по ним выбирается текст подсказки. */
  failed: UpdCheckName[];
  /** Строка УПД, если она расходится с фото. */
  doc: { qty: number | null; unit: string | null } | null;
};

export type PhotoRowHints = {
  rows: PhotoRowHint[];
  /** Сколько строк фото сопоставлено со строками УПД. */
  compared: number;
  /** Из них расходятся количеством или единицей. */
  mismatched: number;
};

// Количество хранится с 4 знаками; меньшие расхождения — округление, не ошибка.
const QTY_EPS = 0.001;

export function photoRowHints(
  items: readonly PhotoRecognitionItem[],
  validation: UpdValidation | null | undefined,
  linkedDocument: PhotoLinkedDocument | null | undefined,
): PhotoRowHints {
  const rows: PhotoRowHint[] = items.map(() => ({ failed: [], doc: null }));

  for (const check of validation?.checks ?? []) {
    if (check.ok || check.scope === 'document') continue;
    rows[check.scope.row - 1]?.failed.push(check.name);
  }

  let compared = 0;
  let mismatched = 0;
  if (linkedDocument) {
    const pairs = matchPhotoRows(items, linkedDocument.items, {
      byNumber: linkedDocument.matchedBy === 'number',
    });
    compared = pairs.length;
    for (const { photoIndex, docIndex } of pairs) {
      const photo = items[photoIndex]!;
      const doc = linkedDocument.items[docIndex]!;
      const qtyDiffers =
        photo.qty != null && doc.qty != null && Math.abs(photo.qty - doc.qty) > QTY_EPS;
      const unitDiffers =
        unitKey(photo.unit) !== '' &&
        unitKey(doc.unit) !== '' &&
        unitKey(photo.unit) !== unitKey(doc.unit);
      if (!qtyDiffers && !unitDiffers) continue;
      rows[photoIndex]!.doc = { qty: doc.qty, unit: doc.unit };
      mismatched += 1;
    }
  }

  return { rows, compared, mismatched };
}

/** Подсказка к строке, не прошедшей сверку: текст — по имени проверки. */
export function rowCheckText(name: UpdCheckName): string {
  switch (name) {
    case 'row_qty_price':
      return 'Кол-во × цена не сходится с суммой строки — сверьте с фото';
    case 'row_vat_rate':
      return 'НДС строки не сходится со ставкой — сверьте с фото';
    default:
      return 'Строка не прошла сверку сумм';
  }
}
