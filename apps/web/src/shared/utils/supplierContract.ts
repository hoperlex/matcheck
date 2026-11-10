import type {
  ContractSiteMatch,
  DeliveryContract,
  SupplierContractSiteStatus,
  SupplierContractSummary,
} from '@matcheck/contracts';

/** YYYY-MM-DD → дд.мм.гггг; пусто — «без даты». */
export function contractDateRu(date: string | null): string {
  if (!date) return 'без даты';
  const [y, m, d] = date.split('-');
  return y && m && d ? `${d}.${m}.${y}` : date;
}

/**
 * Короткая подпись договора для чипа: «СУ-ЗИЛ33/25-33 от 26.08.2025». В 1С в
 * «Номер» бывает не номер («Оплата по счету», «Договор поставки») — тогда
 * берём начало наименования.
 */
export function contractShortLabel(c: Pick<SupplierContractSummary, 'number' | 'name' | 'contractDate'>): string {
  const number = c.number?.trim() ?? '';
  const looksLikeNumber = /\d/.test(number) && number.length <= 32;
  if (looksLikeNumber) {
    return c.contractDate ? `${number} от ${contractDateRu(c.contractDate)}` : number;
  }
  return c.name.length > 48 ? `${c.name.slice(0, 47)}…` : c.name;
}

export const SITE_STATUS_LABELS: Record<SupplierContractSiteStatus, string> = {
  exact: 'точно',
  group: 'группа',
  conflict: 'спорный',
  none: 'не определён',
};

/** Метка объекта договора относительно объекта приёмки: текст и цвет antd Tag. */
export function siteMatchTag(
  match: ContractSiteMatch,
  siteCodes: readonly string[],
): { text: string; color: string | undefined } {
  const codes = siteCodes.join(', ');
  switch (match) {
    case 'match':
      return { text: 'этот объект', color: 'green' };
    case 'group':
      return { text: `группа: ${codes}`, color: 'green' };
    case 'conflict':
      return { text: `спорный: ${siteCodes.join(' / ')}`, color: 'gold' };
    case 'unknown':
      return { text: 'объект не определён', color: undefined };
    case 'other':
      return { text: codes ? `другой: ${codes}` : 'другой объект', color: 'orange' };
  }
}

/** Почему выбранный договор подсвечен. Пусто — всё сходится. */
export function contractWarnings(c: DeliveryContract): string[] {
  const out: string[] = [];
  if (c.supplierMatch === false) out.push('контрагент договора — не поставщик приёмки');
  if (c.siteMatch === 'other') out.push('договор другого объекта');
  if (c.siteMatch === 'conflict') out.push(`объект договора спорный: ${c.siteCodes.join(' / ')}`);
  if (c.kindChanged) out.push('в 1С вид договора уже не «С поставщиком»');
  if (c.missing) out.push('договора нет в последней выгрузке 1С');
  return out;
}
