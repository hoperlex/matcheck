/**
 * Сопоставление строк таблицы, распознанной с фото документа, со строками УПД
 * той же операции.
 *
 * Зачем. Фото на этапах приёмки распознаётся отдельно от документа, и модель
 * на фото ошибается в своих местах: 28.10 в приёмке 22246 УПД № 1820 разобран
 * верно (204 и 300 пог.м), а с фото того же бланка приехало 16 (строка
 * разметки граф «1б») и «3 шт» (номер графы «3»). Сверка сумм ловит не всё:
 * единицу измерения она не проверяет вовсе. Строка УПД рядом с ошибочной
 * строкой фото показывает расхождение прямо.
 *
 * Общий для сервера (опознать документ по строкам, когда номер на фото
 * прочитан неверно) и портала (подсказка «в УПД: 204 пог.м»), чтобы оба
 * считали одинаково.
 *
 * Сопоставление однозначное: каждая строка УПД участвует не больше одного
 * раза, а неоднозначный кандидат не берётся вовсе — лучше без подсказки, чем
 * с подсказкой от чужой строки. Порядок попыток:
 *   1. совпали напечатанный номер позиции и ключ имени;
 *   2. совпал только ключ имени, и он единственный и на фото, и в УПД —
 *      у строк УПД до миграции 0115 и у подпозиций «1а» номера нет;
 *   3. совпал только номер позиции — лишь когда документ уже опознан по
 *      номеру, номер позиции единственный с обеих сторон и цифры в именах
 *      совпадают («10П» и «10 П»). Так проходит имя, прочитанное с опечаткой.
 */

export type MatchRowInput = {
  rowNo?: number | null;
  nameRaw?: string | null;
};

export type PhotoRowPair = {
  photoIndex: number;
  docIndex: number;
  by: 'row_and_name' | 'name' | 'row';
};

// Латиница, которую модель и выгрузки ставят вместо кириллицы.
const LATIN_LOOKALIKES: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
};

/** Ключ сравнения имени позиции: регистр, ё, латинские двойники, без пробелов и знаков. */
export function itemNameKey(name: string | null | undefined): string {
  return (name ?? '')
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[ABCEHKMOPTXY]/g, (ch) => LATIN_LOOKALIKES[ch] ?? ch)
    .replace(/[^0-9A-ZА-Я]/g, '');
}

/** Единица для сравнения: «пог. м» и «Пог.м» — одно и то же. */
export function unitKey(unit: string | null | undefined): string {
  return (unit ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[\s.]/g, '');
}

function nameDigits(name: string | null | undefined): string {
  return (name ?? '').replace(/\D/g, '');
}

function countBy<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

export function matchPhotoRows(
  photo: readonly MatchRowInput[],
  doc: readonly MatchRowInput[],
  opts: { byNumber: boolean },
): PhotoRowPair[] {
  const photoKeys = photo.map((r) => itemNameKey(r.nameRaw));
  const docKeys = doc.map((r) => itemNameKey(r.nameRaw));
  const photoKeyCount = countBy(photoKeys);
  const docKeyCount = countBy(docKeys);
  const photoRowCount = countBy(photo.map((r) => r.rowNo ?? null));
  const docRowCount = countBy(doc.map((r) => r.rowNo ?? null));

  const pairs: PhotoRowPair[] = [];
  const usedDoc = new Set<number>();
  const pairedPhoto = new Set<number>();
  const take = (photoIndex: number, docIndex: number, by: PhotoRowPair['by']): void => {
    pairs.push({ photoIndex, docIndex, by });
    usedDoc.add(docIndex);
    pairedPhoto.add(photoIndex);
  };
  const freeDocs = (match: (j: number) => boolean): number[] =>
    doc.map((_, j) => j).filter((j) => !usedDoc.has(j) && match(j));

  // 1. Номер позиции и имя.
  photo.forEach((p, i) => {
    if (p.rowNo == null || photoKeys[i] === '') return;
    const found = freeDocs((j) => doc[j]!.rowNo === p.rowNo && docKeys[j] === photoKeys[i]);
    if (found.length === 1) take(i, found[0]!, 'row_and_name');
  });

  // 2. Единственное имя с обеих сторон.
  photo.forEach((_, i) => {
    const key = photoKeys[i]!;
    if (pairedPhoto.has(i) || key === '') return;
    if (photoKeyCount.get(key) !== 1 || docKeyCount.get(key) !== 1) return;
    const found = freeDocs((j) => docKeys[j] === key);
    if (found.length === 1) take(i, found[0]!, 'name');
  });

  // 3. Только номер позиции — при документе, опознанном по номеру.
  if (opts.byNumber) {
    photo.forEach((p, i) => {
      if (pairedPhoto.has(i) || p.rowNo == null) return;
      if (photoRowCount.get(p.rowNo) !== 1 || docRowCount.get(p.rowNo) !== 1) return;
      const found = freeDocs(
        (j) => doc[j]!.rowNo === p.rowNo && nameDigits(doc[j]!.nameRaw) === nameDigits(p.nameRaw),
      );
      if (found.length === 1) take(i, found[0]!, 'row');
    });
  }

  return pairs.sort((a, b) => a.photoIndex - b.photoIndex);
}
