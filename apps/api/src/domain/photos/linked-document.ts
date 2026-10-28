// С каким УПД операции сверять таблицу, распознанную с фото документа.
//
// Выбор чистый: кандидатов (разобранные УПД этой же приёмки или отгрузки с
// позициями) собирает роут. Ответ — `PhotoRecognition.linkedDocument`.
//
//   1. Номер на фото после normalizeDocumentNumber непустой и совпал ровно с
//      одним кандидатом → `number`. Пустой номер совпадением не считается.
//      Два кандидата с одним номером — неоднозначно, сверки нет.
//   2. Номер не совпал ни с кем → ищем по строкам: у ровно одного кандидата
//      сошлось не меньше двух строк и не меньше половины строк фото →
//      `rows`. Так опознаётся 2 этап приёмки 22246, где номер 1820 прочитан
//      как 00000001682.
//
// Ветка `photo_v1` не читает номеров позиций, и сверка по ней не делается.

import {
  matchPhotoRows,
  type PhotoLinkedDocument,
  type PhotoRecognition,
} from '@matcheck/contracts';
import { normalizeDocumentNumber } from '../operations/edo-match.js';

export type LinkedDocumentCandidate = Omit<PhotoLinkedDocument, 'matchedBy'>;

export function pickLinkedDocument(
  photo: Pick<PhotoRecognition, 'parser' | 'docNumber' | 'items'>,
  candidates: readonly LinkedDocumentCandidate[],
): PhotoLinkedDocument | null {
  if (photo.parser !== 'upd_vision' || photo.items.length === 0) return null;
  const usable = candidates.filter((c) => c.items.length > 0);
  if (usable.length === 0) return null;

  const photoKey = normalizeDocumentNumber(photo.docNumber);
  if (photoKey !== '') {
    const byNumber = usable.filter((c) => normalizeDocumentNumber(c.docNumber) === photoKey);
    if (byNumber.length === 1) return { ...byNumber[0]!, matchedBy: 'number' };
    if (byNumber.length > 1) return null;
  }

  const byRows = usable.filter((c) => {
    const pairs = matchPhotoRows(photo.items, c.items, { byNumber: false }).length;
    return pairs >= 2 && pairs * 2 >= photo.items.length;
  });
  return byRows.length === 1 ? { ...byRows[0]!, matchedBy: 'rows' } : null;
}
