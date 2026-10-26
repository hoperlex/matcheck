// Подсказка «Получатель» приёмки по сторонам привязанных документов.
//
// Список приёмок показывает покупателя и грузополучателя документа, а чип
// «Получатель» в карточке — подрядчика самой приёмки (deliveries.contractor_id).
// Автоподстановку выключили 25.08 (7d62092): примерно в 40% документов
// грузополучатель — сама СУ-10, и подставленный генподрядчик давал бы права
// роли «подрядчик» из недоверенного файла. Поэтому здесь только подсказка:
// подставляет и сохраняет человек, тем же путём, что ручной выбор.
//
// Сопоставление только по ИНН: одинаковое имя без формы собственности бывает у
// разных юрлиц с разными ИНН. И только когда операционный контрагент с этим
// ИНН уже есть — иначе from-directory пошёл бы искать по имени и мог вернуть
// контрагента с другим ИНН (routes/counterparties.ts, шаг 2).

import { normalizeInn } from './resolve-contractor.js';

export type SuggestionDocument = {
  id: string;
  buyerInn: string | null;
  consigneeInn: string | null;
};

export type DirectoryContractor = { id: string; name: string; inn: string | null };

export type RecipientSuggestion = {
  customerCounterpartyId: string;
  name: string;
  inn: string;
  from: 'buyer' | 'consignee';
  sourceDocumentId: string;
};

/**
 * Подрядчик-кандидат одного документа: сначала покупатель (подрядчики в УПД
 * стоят покупателем — совпадение в 154 из 163 случаев, resolve-contractor.ts),
 * потом грузополучатель. Свои ИНН и стороны вне справочника пропускаются.
 */
function documentCandidate(
  doc: SuggestionDocument,
  byInn: ReadonlyMap<string, DirectoryContractor>,
  ownInns: ReadonlySet<string>,
): RecipientSuggestion | null {
  const sides: Array<['buyer' | 'consignee', string | null]> = [
    ['buyer', doc.buyerInn],
    ['consignee', doc.consigneeInn],
  ];
  for (const [from, raw] of sides) {
    const inn = normalizeInn(raw);
    if (!inn || ownInns.has(inn)) continue;
    const contractor = byInn.get(inn);
    if (!contractor) continue;
    return {
      customerCounterpartyId: contractor.id,
      name: contractor.name,
      inn,
      from,
      sourceDocumentId: doc.id,
    };
  }
  return null;
}

/**
 * Подсказка по всем документам приёмки или null.
 *
 * null, когда кандидатов нет, когда документы указывают на разных подрядчиков
 * (выбирать за человека нельзя) и когда операционного контрагента с этим ИНН
 * нет (`operationalInns`) — см. заголовок файла.
 *
 * `directory` — в устойчивом порядке: при дублях одного ИНН в справочнике
 * берётся первая запись, и подсказка не прыгает между ними.
 */
export function pickRecipientSuggestion(
  docs: readonly SuggestionDocument[],
  directory: readonly DirectoryContractor[],
  ownInns: ReadonlySet<string>,
  operationalInns: ReadonlySet<string>,
): RecipientSuggestion | null {
  const byInn = new Map<string, DirectoryContractor>();
  for (const c of directory) {
    const inn = normalizeInn(c.inn);
    if (inn && !ownInns.has(inn) && !byInn.has(inn)) byInn.set(inn, c);
  }

  let picked: RecipientSuggestion | null = null;
  for (const doc of docs) {
    const candidate = documentCandidate(doc, byInn, ownInns);
    if (!candidate) continue;
    if (picked && picked.inn !== candidate.inn) return null;
    picked ??= candidate;
  }
  if (!picked || !operationalInns.has(picked.inn)) return null;
  return picked;
}

/** ИНН-кандидаты документов — чтобы одним запросом проверить операционные записи. */
export function candidateInns(docs: readonly SuggestionDocument[]): string[] {
  const out = new Set<string>();
  for (const d of docs) {
    for (const raw of [d.buyerInn, d.consigneeInn]) {
      const inn = normalizeInn(raw);
      if (inn) out.add(inn);
    }
  }
  return [...out];
}
