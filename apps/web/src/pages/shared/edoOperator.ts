/**
 * Подписи операторов ЭДО. Сервер отдаёт код (`provider` учётки, `operator`
 * строки реестра); незнакомый код показывается как есть — новый оператор не
 * должен превращаться в «Диадок» по умолчанию.
 */
const LABELS: Record<string, string> = { diadoc: 'Диадок', sbis: 'СБИС' };
/** Для «ленту …», «из …». */
const GENITIVE: Record<string, string> = { diadoc: 'Диадока', sbis: 'СБИС' };

export function edoOperatorLabel(provider: string | null | undefined): string {
  if (!provider) return 'ЭДО';
  return LABELS[provider] ?? provider;
}

export function edoOperatorGenitive(provider: string | null | undefined): string {
  if (!provider) return 'ЭДО';
  return GENITIVE[provider] ?? provider;
}
