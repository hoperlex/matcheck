/**
 * «Возможно, та же УПД» в окне подбора.
 *
 * Сервер склеивает копии одной УПД у двух операторов ЭДО (тот же файл, ИдФайл
 * или состав) и показывает одну строку. Совпадение одной шапки — номер, дата,
 * поставщик, сумма — копией не считается: у «Службы Механизации» два разных
 * УПД № 671 от 31.08 с одной шапкой. Такие строки остаются раздельными, а
 * человеку подсказывается сверить позиции.
 */
export type TwinCandidate = {
  id: string;
  source: 'import' | 'export';
  operator?: string;
  docNumber: string | null;
  docDate: string | null;
  supplierInn: string | null;
  totalSum: string | null;
};

export function candidateKey(c: Pick<TwinCandidate, 'id' | 'source'>): string {
  return `${c.source}:${c.id}`;
}

function headerKey(c: TwinCandidate): string | null {
  const number = c.docNumber?.replace(/\s+/g, '').toUpperCase();
  const sum = c.totalSum === null ? NaN : Number(c.totalSum);
  if (!number || !c.docDate || !c.supplierInn || !Number.isFinite(sum)) return null;
  // Копейки — целым числом: «1200.00» и «1200» одна сумма.
  return [number, c.docDate.slice(0, 10), c.supplierInn.trim(), Math.round(sum * 100)].join('|');
}

/**
 * Для каждой строки, у которой та же шапка есть у ДРУГОГО оператора, — список
 * этих операторов. Строки одного оператора друг другу не пара: повторы внутри
 * Диадока — обычное дело и подсказкой не помечаются.
 */
export function possibleTwins(items: readonly TwinCandidate[]): Map<string, string[]> {
  const groups = new Map<string, TwinCandidate[]>();
  for (const item of items) {
    if (!item.operator) continue;
    const key = headerKey(item);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const out = new Map<string, string[]>();
  for (const group of groups.values()) {
    for (const item of group) {
      const others = [...new Set(group.map((g) => g.operator!).filter((op) => op !== item.operator))].sort();
      if (others.length) out.set(candidateKey(item), others);
    }
  }
  return out;
}
