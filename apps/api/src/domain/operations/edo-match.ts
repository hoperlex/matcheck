/** Evidence for a suggested EDO document. A score only orders choices; it never links them. */
export type MatchReference = {
  numbers: string[];
  dates: string[];
  supplierInn: string | null;
  supplierName: string | null;
  sums: string[];
  itemNames: string[];
  arrivedDate: string | null;
};

export type MatchDocument = {
  docNumber: string | null;
  docDate: string | null;
  supplierInn: string | null;
  supplierName: string | null;
  totalSum: string | null;
  itemNames: string[];
};

const LOOKALIKES: Record<string, string> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
};

export function normalizeDocumentNumber(value: string | null): string {
  return (value ?? '')
    .toUpperCase()
    .replace(/[АВЕКМНОРСТУХ]/g, (letter) => LOOKALIKES[letter] ?? letter)
    .replace(/[^A-Z0-9А-ЯЁ]/g, '');
}

function normalizeName(value: string | null): string {
  return (value ?? '').toLocaleLowerCase('ru').replace(/[^a-zа-яё0-9]/gi, '');
}

function normalizeInn(value: string | null): string {
  return (value ?? '').replace(/\D/g, '');
}

function moneyEqual(a: string, b: string): boolean {
  const left = Number(a.replace(',', '.'));
  const right = Number(b.replace(',', '.'));
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.01;
}

export function rankEdoDocument(reference: MatchReference, doc: MatchDocument) {
  let score = 0;
  const matches: string[] = [];
  const conflicts: string[] = [];
  const missing: string[] = [];
  const refNumbers = reference.numbers.map(normalizeDocumentNumber).filter(Boolean);
  const number = normalizeDocumentNumber(doc.docNumber);
  if (refNumbers.length && number) {
    if (refNumbers.includes(number)) {
      score += 55;
      matches.push('номер УПД');
    } else if (refNumbers.length === 1) {
      conflicts.push('номер УПД отличается');
    }
  } else missing.push('номер УПД');

  if (reference.dates.length && doc.docDate) {
    if (reference.dates.includes(doc.docDate)) {
      score += 20;
      matches.push('дата документа');
    } else {
      conflicts.push('дата документа отличается');
    }
  } else if (reference.arrivedDate && doc.docDate) {
    const days = Math.abs(Date.parse(reference.arrivedDate) - Date.parse(doc.docDate)) / 86_400_000;
    if (Number.isFinite(days) && days <= 7) {
      score += 5;
      matches.push('дата близка к приёмке');
    }
  } else missing.push('дата документа');

  const refInn = normalizeInn(reference.supplierInn);
  const docInn = normalizeInn(doc.supplierInn);
  if (refInn && docInn) {
    if (refInn === docInn) {
      score += 30;
      matches.push('ИНН поставщика');
    } else conflicts.push('ИНН поставщика отличается');
  } else {
    const refName = normalizeName(reference.supplierName);
    const docName = normalizeName(doc.supplierName);
    if (refName && docName) {
      if (refName === docName) {
        score += 12;
        matches.push('название поставщика');
      } else conflicts.push('поставщик отличается');
    } else missing.push('поставщик');
  }

  if (reference.sums.length && doc.totalSum) {
    if (reference.sums.some((sum) => moneyEqual(sum, doc.totalSum!))) {
      score += 20;
      matches.push('сумма');
    } else conflicts.push('сумма отличается');
  } else missing.push('сумма');

  const names = new Set(reference.itemNames.map(normalizeName).filter(Boolean));
  const overlap = doc.itemNames.filter((name) => names.has(normalizeName(name))).length;
  if (names.size && doc.itemNames.length) {
    if (overlap) {
      score += Math.min(20, overlap * 10);
      matches.push(`материалы: ${overlap}`);
    } else conflicts.push('материалы не совпали по названию');
  } else missing.push('материалы');

  const level = conflicts.length === 0 && score >= 90 ? 'high' : score >= 45 ? 'possible' : 'weak';
  return { score, level, matches, conflicts, missing } as const;
}

export function rankEdoAgainstReferences(
  references: readonly (MatchReference & { paperDocNumber: string | null })[],
  doc: MatchDocument,
) {
  return references
    .map((reference) => ({
      paperDocNumber: reference.paperDocNumber,
      ...rankEdoDocument(reference, doc),
    }))
    .sort((a, b) => b.score - a.score || a.conflicts.length - b.conflicts.length)[0]!;
}
