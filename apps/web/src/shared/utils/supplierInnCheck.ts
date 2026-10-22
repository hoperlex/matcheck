import type { SupplierInnCheckTraceDto } from '@matcheck/contracts';

const SOURCE_LABEL: Record<NonNullable<SupplierInnCheckTraceDto['source']>, string> = {
  edo: 'по ЭДО',
  directory: 'по справочнику',
  directory_name: 'по справочнику',
};

/**
 * Подпись «ИНН исправлен при распознавании» для карточки документа. Только
 * для применённого исправления (режим on): в shadow данные документа не
 * менялись, и подпись ввела бы в заблуждение. Непроверенный ИНН показывается
 * предупреждением supplier_inn_unverified, здесь его нет.
 */
export function supplierInnCorrectionNote(
  check: SupplierInnCheckTraceDto | null | undefined,
): { short: string; full: string } | null {
  if (!check || check.mode !== 'on' || check.decision !== 'corrected' || !check.inn) return null;
  const how = check.source ? ` ${SOURCE_LABEL[check.source]}` : '';
  return {
    short: `ИНН исправлен${how}`,
    full: `ИНН поставщика исправлен при распознавании${how}: было ${check.raw ?? '—'}, стало ${check.inn}`,
  };
}
