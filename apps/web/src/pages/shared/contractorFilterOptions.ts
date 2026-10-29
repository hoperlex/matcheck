import type { CustomerCounterparty } from '@matcheck/contracts';
import { supplierSearchKey } from './supplierSearch';

// Форма собственности не различает организации: «ООО "МАСТЕР"» и «МАСТЕР» —
// одно имя для глаза.
const LEGAL_FORM = /^(?:общество с ограниченной ответственностью|ооо|оао|зао|пао|ао|ип)\s+/;

// Имя в справочнике обязательно, но падение здесь уронило бы всю страницу со
// списком — пустое имя считаем пустой строкой.
function nameKey(name: string | null | undefined): string {
  return supplierSearchKey(name ?? '').replace(LEGAL_FORM, '');
}

/**
 * Опции фильтра «Подрядчик» из справочника «Контрагенты».
 *
 * В справочнике есть тёзки — разные юрлица с одним именем (ООО "МАСТЕР" с тремя
 * ИНН). Подписью только по имени их не различить, и в списке они выглядят как
 * дубли. Тёзкам дописываем ИНН (или «без ИНН»), остальные подписи не меняются,
 * чтобы не удлинять список без нужды.
 */
export function contractorFilterOptions(
  items: readonly Pick<CustomerCounterparty, 'id' | 'name' | 'inn'>[],
): { value: string; label: string }[] {
  const counts = new Map<string, number>();
  for (const c of items) {
    const k = nameKey(c.name);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return items.map((c) => {
    const name = (c.name ?? '').trim();
    if ((counts.get(nameKey(c.name)) ?? 0) < 2) return { value: c.id, label: name };
    const inn = c.inn?.trim();
    return { value: c.id, label: inn ? `${name} (ИНН ${inn})` : `${name} (без ИНН)` };
  });
}
