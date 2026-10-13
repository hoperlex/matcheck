import { normalizeInn } from '../sourceDocuments/resolve-contractor.js';

/**
 * Сверка УПД из ЭДО с документом приёмки.
 *
 * Очки здесь только упорядочивают список — уровень решают правила
 * (`levelOf`). Порог по сумме очков давал «сильное совпадение» по одним цифрам
 * номера: ядро номера, дата и ИНН вместе как раз добирали до порога, а номера
 * разных документов одного поставщика по цифрам совпадают законно.
 *
 * Позиции УПД в сверке намеренно не участвуют: их показывает просмотр
 * документа, а бэктест по ним размечает правильные пары — участвуй они и в
 * оценке, проверка опиралась бы на тот же признак, что и подбор.
 */

/** Откуда взят эталон: бумажная УПД, распознанное фото или реквизиты самой приёмки. */
export type ReferenceOrigin = 'paper' | 'photo' | 'delivery';

export type MatchReference = {
  origin: ReferenceOrigin;
  /** Номер документа-эталона для показа менеджеру. */
  label: string | null;
  numbers: string[];
  /** Дата документа-эталона, YYYY-MM-DD. */
  date: string | null;
  /** Только ИНН, прошедшие проверку контрольных цифр. */
  inns: string[];
  /** ИНН у эталона были, но ни один не прошёл проверку. */
  innUnreadable: boolean;
  names: string[];
  /**
   * Суммы эталона. У бумажной УПД — её итог; у фото — итоги отдельных
   * снимков, и страница многолистовой УПД показывает не итог документа.
   */
  sums: string[];
  /** Дата приезда машины по Москве, YYYY-MM-DD. */
  arrivedDate: string | null;
};

export type MatchDocument = {
  docNumber: string | null;
  docDate: string | null;
  supplierInn: string | null;
  /** Все продавцы из XML: формат допускает нескольких. */
  supplierInns?: readonly string[];
  supplierName: string | null;
  totalSum: string | null;
};

export type MatchLevel = 'high' | 'possible' | 'weak';

export type MatchResult = {
  score: number;
  level: MatchLevel;
  matches: string[];
  conflicts: string[];
  missing: string[];
  /** Проверенные ИНН есть у обеих сторон и не пересекаются. */
  innConflict: boolean;
  /** Какой ИНН документа совпал с эталоном — у УПД с несколькими продавцами важно, какой. */
  matchedInn: string | null;
};

/** Сверка документа со всеми эталонами приёмки. */
export type DocumentMatch = MatchResult & {
  reference: { origin: ReferenceOrigin; label: string | null };
  /**
   * Документ другого поставщика: ИНН не совпал ни с одним эталоном, хотя бы с
   * одним разошёлся, и ни один эталон без ИНН не подтвердил его полным номером
   * или названием. Признак всего документа, а не одной сверки: при нескольких
   * УПД в приёмке «лучшая» сверка могла бы быть как раз с чужим эталоном.
   */
  otherSupplier: boolean;
  supplierCheck: {
    /** Проверенные ИНН документа. */
    documentInns: string[];
    /** Проверенные ИНН всех эталонов приёмки. */
    referenceInns: string[];
    matchedInn: string | null;
  };
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

/** Номер целиком: регистр, похожие кириллица/латиница, без пробелов и знаков. */
export function normalizeDocumentNumber(value: string | null): string {
  return (value ?? '')
    .toUpperCase()
    .replace(/[АВЕКМНОРСТУХ]/g, (letter) => LOOKALIKES[letter] ?? letter)
    .replace(/[^A-Z0-9А-ЯЁ]/g, '');
}

/**
 * Цифровое ядро номера: только цифры, без ведущих нулей. «УТ-2214» и
 * «0002214» дают одно ядро. Короче трёх цифр — пусто: такие ядра совпадают
 * у слишком многих документов, чтобы что-то значить.
 */
export function documentNumberCore(value: string | null): string {
  const core = (value ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return core.length >= 3 ? core : '';
}

const LEGAL_FORM_PHRASES = [
  /общество\s+с\s+ограниченной\s+ответственностью/g,
  /публичное\s+акционерное\s+общество/g,
  /закрытое\s+акционерное\s+общество/g,
  /открытое\s+акционерное\s+общество/g,
  /акционерное\s+общество/g,
  /индивидуальный\s+предприниматель/g,
];
const LEGAL_FORM_TOKENS = new Set(['ооо', 'оао', 'зао', 'пао', 'ао', 'нао', 'ип']);

/** Слова названия без организационно-правовой формы, кавычек и знаков. */
export function supplierNameTokens(value: string | null): string[] {
  let text = (value ?? '').toLocaleLowerCase('ru').replace(/ё/g, 'е');
  for (const phrase of LEGAL_FORM_PHRASES) text = text.replace(phrase, ' ');
  return text
    .split(/[^a-zа-я0-9]+/)
    .filter((token) => token.length > 0 && !LEGAL_FORM_TOKENS.has(token));
}

/** «ООО «Терма Альянс»» и «ТЕРМА АЛЬЯНС» — одно и то же название. */
export function normalizeSupplierName(value: string | null): string {
  return supplierNameTokens(value).join('');
}

function moneyEqual(a: string, b: string): boolean {
  const left = Number(a.replace(',', '.'));
  const right = Number(b.replace(',', '.'));
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.01;
}

/** Разница дат в днях: положительная — `later` позже `earlier`. */
export function daysBetween(earlier: string, later: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}

/** Множество проверенных ИНН из всех источников: битый ИНН не перекрывает верный. */
export function validInns(values: readonly (string | null | undefined)[]): {
  inns: string[];
  unreadable: boolean;
} {
  const inns = new Set<string>();
  let present = false;
  for (const value of values) {
    if (!value || !value.replace(/\D/g, '')) continue;
    present = true;
    const inn = normalizeInn(value);
    if (inn) inns.add(inn);
  }
  return { inns: [...inns], unreadable: present && inns.size === 0 };
}

export function rankEdoDocument(reference: MatchReference, doc: MatchDocument): MatchResult {
  const { evidence: _evidence, ...result } = rankWithEvidence(reference, doc);
  return result;
}

/** Улики, по которым эталон без ИНН может подтвердить документ. Наружу не отдаются. */
type Evidence = { numberFull: boolean; nameMatch: boolean };

function rankWithEvidence(
  reference: MatchReference,
  doc: MatchDocument,
): MatchResult & { evidence: Evidence } {
  let score = 0;
  const matches: string[] = [];
  const conflicts: string[] = [];
  const missing: string[] = [];

  let numberFull = false;
  let numberCore = false;
  const refFull = reference.numbers.map(normalizeDocumentNumber).filter(Boolean);
  const refCore = reference.numbers.map(documentNumberCore).filter(Boolean);
  const docFull = normalizeDocumentNumber(doc.docNumber);
  const docCore = documentNumberCore(doc.docNumber);
  if (!refFull.length || !docFull) {
    missing.push('номер УПД');
  } else if (refFull.includes(docFull)) {
    numberFull = true;
    score += 55;
    matches.push('номер УПД');
  } else if (docCore && refCore.includes(docCore)) {
    numberCore = true;
    score += 40;
    matches.push('номер совпал по цифрам');
  } else {
    conflicts.push('номер УПД отличается');
  }

  let dateEqual = false;
  if (reference.date && doc.docDate) {
    if (reference.date === doc.docDate) {
      dateEqual = true;
      score += 20;
      matches.push('дата документа');
    } else {
      conflicts.push('дата документа отличается');
    }
  } else {
    missing.push('дата документа');
    // УПД выписывают до приезда машины или в тот же день, не позже.
    if (reference.arrivedDate && doc.docDate) {
      const days = daysBetween(doc.docDate, reference.arrivedDate);
      if (days >= 0 && days <= 7) {
        score += 5;
        matches.push('дата близка к приезду');
      }
    }
  }

  let innMatch = false;
  let innConflict = false;
  let matchedInn: string | null = null;
  let nameMatch = false;
  const docInns = documentInns(doc);
  if (reference.inns.length && docInns.length) {
    matchedInn = docInns.find((inn) => reference.inns.includes(inn)) ?? null;
    if (matchedInn) {
      innMatch = true;
      score += 30;
      matches.push('ИНН поставщика');
    } else {
      innConflict = true;
      conflicts.push('ИНН поставщика отличается');
    }
  } else {
    missing.push(
      reference.innUnreadable && !reference.inns.length
        ? 'ИНН поставщика (в документе приёмки не проходит проверку)'
        : 'ИНН поставщика',
    );
    const refNames = new Set(reference.names.map(normalizeSupplierName).filter(Boolean));
    const docName = normalizeSupplierName(doc.supplierName);
    if (refNames.size && docName) {
      if (refNames.has(docName)) {
        nameMatch = true;
        score += 12;
        matches.push('название поставщика');
      } else {
        conflicts.push('название поставщика другое');
      }
    }
  }

  if (reference.sums.length && doc.totalSum) {
    const equal = reference.sums.some((sum) => moneyEqual(sum, doc.totalSum!));
    if (reference.origin === 'photo') {
      // Неравенство не улика: страница многолистовой УПД несёт свой итог.
      if (equal) {
        score += 10;
        matches.push('сумма с фото совпала с итогом');
      }
    } else if (equal) {
      score += 20;
      matches.push('сумма');
    } else {
      conflicts.push('сумма отличается');
    }
  } else {
    missing.push('сумма');
  }

  return {
    score,
    level: levelOf({ numberFull, numberCore, dateEqual, innMatch, innConflict, nameMatch, conflicts }),
    matches,
    conflicts,
    missing,
    innConflict,
    matchedInn,
    evidence: { numberFull, nameMatch },
  };
}

/** Проверенные ИНН документа: продавец реестра и все продавцы из XML. */
function documentInns(doc: MatchDocument): string[] {
  return validInns([doc.supplierInn, ...(doc.supplierInns ?? [])]).inns;
}

/**
 * «Сильное» — только полный номер, проверенный ИНН и та же дата без единого
 * расхождения. Ни цифры номера, ни название, ни сумма с фото до него не
 * поднимают: это улики для «проверьте», а не подтверждение.
 *
 * При разных проверенных ИНН цифры номера ничего не значат: у разных
 * поставщиков номера «УТ-4862» и «ТК-04862» совпадают по цифрам законно.
 * «Проверьте» тогда — только за полный номер и ту же дату: ИНН мог быть
 * прочитан с ошибкой, которая прошла контрольную цифру.
 */
function levelOf(evidence: {
  numberFull: boolean;
  numberCore: boolean;
  dateEqual: boolean;
  innMatch: boolean;
  innConflict: boolean;
  nameMatch: boolean;
  conflicts: readonly string[];
}): MatchLevel {
  if (
    evidence.numberFull &&
    evidence.innMatch &&
    evidence.dateEqual &&
    evidence.conflicts.length === 0
  ) {
    return 'high';
  }
  if (evidence.innConflict) {
    return evidence.numberFull && evidence.dateEqual ? 'possible' : 'weak';
  }
  if (evidence.numberFull || evidence.numberCore || evidence.innMatch || evidence.nameMatch) {
    return 'possible';
  }
  return 'weak';
}

const LEVEL_RANK: Record<MatchLevel, number> = { high: 2, possible: 1, weak: 0 };

type Ordered = Pick<MatchResult, 'level' | 'score' | 'conflicts'> & { otherSupplier?: boolean };

/** Порядок кандидатов: уровень, затем свои поставщики выше чужих, затем очки. */
export function compareMatches(a: Ordered, b: Ordered): number {
  return (
    LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
    Number(a.otherSupplier ?? false) - Number(b.otherSupplier ?? false) ||
    b.score - a.score ||
    a.conflicts.length - b.conflicts.length
  );
}

/**
 * Выбор эталона для одного документа — по уровню и очкам, без предпочтения
 * «эталона без расхождения ИНН». Бэктест сентября: такое предпочтение отдавало
 * сверку соседней УПД той же приёмки, совпавшей одним ИНН или названием, и
 * правильная пара уходила с 1-го места (16515 — на 2-е, 17688 — на 9-е).
 * Совпавший ИНН другого эталона всё равно виден в `supplierCheck.matchedInn`.
 */
function compareReferences(a: MatchResult, b: MatchResult): number {
  return (
    LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
    b.score - a.score ||
    a.conflicts.length - b.conflicts.length
  );
}

/**
 * Одна приёмка может иметь несколько УПД. Электронную сверяем с каждым
 * эталоном отдельно и берём лучший: общая сумма и реквизиты всей машины
 * давали бы ложные совпадения между разными документами.
 *
 * Чужой ли поставщик — решают все эталоны вместе (см. `otherSupplier`). У
 * чужого документа уровень берётся только из сверок с расхождением ИНН:
 * эталон без ИНН, совпавший лишь цифрами номера, не должен поднимать его до
 * «проверьте».
 */
export function rankEdoAgainstReferences(
  references: readonly MatchReference[],
  doc: MatchDocument,
): DocumentMatch {
  const results = references.map((reference) => ({
    reference: { origin: reference.origin, label: reference.label },
    ...rankWithEvidence(reference, doc),
  }));
  const docInns = documentInns(doc);
  const vouches = (r: (typeof results)[number]) =>
    r.matchedInn !== null || (!r.innConflict && (r.evidence.numberFull || r.evidence.nameMatch));
  const otherSupplier =
    docInns.length > 0 && results.some((r) => r.innConflict) && !results.some(vouches);
  const pool = otherSupplier ? results.filter((r) => r.innConflict) : results;
  const { evidence: _evidence, ...best } = [...pool].sort(compareReferences)[0]!;
  const matchedInn = best.matchedInn ?? results.find((r) => r.matchedInn)?.matchedInn ?? null;
  return {
    ...best,
    otherSupplier,
    supplierCheck: {
      documentInns: docInns,
      referenceInns: [...new Set(references.flatMap((reference) => reference.inns))],
      matchedInn,
    },
  };
}
