// Сопоставление подрядчика по ИНН покупателя из шапки УПД.
//
// АВТОПОДСТАНОВКИ БОЛЬШЕ НЕТ. Она жила ради одного: без получателя документ
// висел «Черновиком» и не уезжал на планшет. Сейчас у приёмки получатель не
// обязателен ни для «Обработано», ни для выдачи инспектору, а планшет
// показывает грузополучателя из самого документа — от подстановки оставался
// только вред: в поле «Получатель» вставал покупатель из шапки, а у поставки
// субподрядчику это генподрядчик. Осталось само сопоставление: им пользуется
// скрипт сверки (scripts/contractor-backtest.ts).
//
// Почему покупатель, а не грузополучатель. Справочник контрагентов — это
// подрядчики, и в УПД они стоят покупателем (графа 6). Сверка на боевых данных:
// из 163 документов, где заполнено и распознанное, и выбранное человеком,
// покупатель совпал с подрядчиком по ИНН в 154. Грузополучатель (графа 4) на
// той же выборке распознан у одного документа из 208 и без ИНН — связать его
// не с чем.
//
// Почему только по ИНН. Одна организация пишется в документах как «ООО «СУ-10»»,
// «ООО "СУ-10"» и «Общество с ограниченной ответственностью …»; совпадение по
// строке имени даёт 90 из 163 против 154 по ИНН. Fuzzy здесь неуместен: ошибка
// не косметическая, а операционная — подрядчик определяет привязку документа.
//
// ВАЖНО. Результат помечается recipient_source='auto_buyer' и НЕ даёт прав роли
// contractor: /uploads открыт всем, и содержимое присланного файла недоверенное.
// Ограничение живёт в lib/contractor-scope.ts.

import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { counterparties, sourceDocuments } from '../../db/schema.js';

export type ContractorMatch = {
  contractorId: string;
  /** Каноничное имя из справочника — для лога, не для записи в документ. */
  name: string;
};

/**
 * ИНН, пригодный для поиска: только цифры, длина 10 (юрлицо) или 12 (ИП),
 * контрольные цифры сходятся. Иначе null.
 *
 * Проверка контрольных цифр здесь не формальность: LLM переставляет цифры на
 * плохих сканах — на боевых данных так появились 7736255088 и 7736255608 вместо
 * 7736255508. Без проверки такой ИНН просто не найдётся в справочнике, но с
 * проверкой мы не найдём его гарантированно и не рискуем случайным попаданием
 * в чужую организацию.
 */
export function normalizeInn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 12) return null;
  return isValidInnChecksum(digits) ? digits : null;
}

/** Контрольные цифры ИНН по алгоритму ФНС: одна для 10 знаков, две для 12. */
export function isValidInnChecksum(digits: string): boolean {
  const d = [...digits].map(Number);
  if (d.some(Number.isNaN)) return false;
  const dot = (weights: readonly number[], upTo: number) =>
    (weights.reduce((acc, w, i) => acc + w * d[i]!, 0) % 11) % 10 === d[upTo];

  if (digits.length === 10) {
    return dot([2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
  }
  return dot([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && dot([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11);
}

/**
 * Найти подрядчика в справочнике по ИНН покупателя.
 *
 * Ищет ТОЛЬКО среди is_contractor=true и ничего не создаёт: роль контрагента
 * менять нельзя, иначе в справочник подрядчиков натечёт каждый покупатель из
 * УПД (та же причина, по которой стороны документа пишутся с ролью 'customer').
 *
 * Дубли по ИНН в справочнике реальны: у СУ-10 их четыре — по записи на КПП
 * обособленного подразделения (уникальность в схеме частичная: UNIQUE(inn, kpp)
 * при заполненном КПП). Побеждает самая используемая запись; тай-брейк доведён
 * до полной детерминированности (usage → created_at → id), чтобы результат не
 * зависел от порядка строк в плане запроса.
 *
 * Почему КПП в поиске НЕ участвует, хотя парсер его знает. На боевых данных
 * человек в 153 случаях из 154 выбирает одну и ту же запись (КПП 774550001)
 * независимо от того, какой КПП напечатан в документе: встречались 771501001
 * (59 документов), 997450001 (2), 773601001 (1) и пустой (1) — и все они
 * привязаны к основной записи. Матч по паре ИНН+КПП увёл бы эти 63 документа
 * на почти неиспользуемые дубли, то есть был бы точнее формально и хуже
 * фактически.
 *
 * На видимость роли contractor выбор конкретной записи не влияет: скоуп
 * разворачивается по ИНН (lib/contractor-scope.ts).
 */
export async function resolveContractorByBuyerInn(
  db: Db,
  buyerInn: string | null | undefined,
): Promise<ContractorMatch | null> {
  const inn = normalizeInn(buyerInn);
  if (!inn) return null;

  const [row] = await db
    .select({
      id: counterparties.id,
      name: counterparties.name,
      usage: sql<number>`(
        select count(*) from ${sourceDocuments} sd
         where sd.contractor_id = ${counterparties.id}
           and sd.is_technical = false
      )`,
    })
    .from(counterparties)
    .where(and(eq(counterparties.inn, inn), eq(counterparties.isContractor, true)))
    .orderBy(
      sql`(
        select count(*) from ${sourceDocuments} sd
         where sd.contractor_id = ${counterparties.id}
           and sd.is_technical = false
      ) desc`,
      counterparties.createdAt,
      counterparties.id,
    )
    .limit(1);

  return row ? { contractorId: row.id, name: row.name } : null;
}

/**
 * Значение recipient_source для документа, создаваемого с уже выбранным
 * получателем: форма менеджера, разбор письма, техническая запись пакета.
 *
 * Нужно, чтобы NULL означал именно «получателя не задавали»: без этого документ
 * с подрядчиком из формы выглядел бы для автоподстановки нетронутым, а условие
 * «менеджер очистил поле» — неотличимым от «поле никогда не заполняли».
 *
 * Только inbound: у outbound получатель — recipient_id, а contractor_id там наш
 * отправитель, и происхождение получателя им не описывается.
 */
export function manualRecipientSource(bundle: {
  direction: string;
  contractorId: string | null;
  recipientMolId: string | null;
}): 'manual' | null {
  if (bundle.direction !== 'inbound') return null;
  return bundle.contractorId || bundle.recipientMolId ? 'manual' : null;
}
