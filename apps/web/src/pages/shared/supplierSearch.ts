/**
 * Поиск и порядок вариантов в окне выбора поставщика (чип «Поставщик»).
 *
 * Зачем отдельно от компонента. 26.10 Мониторинг не нашёл в окне правильного
 * поставщика и перепривязал документ к дублю с битым ИНН (приёмка 21713):
 * поиск был голым вхождением подстроки, и запрос «АО И» не находил
 * `АО "ИСТКУЛЬТ…` из-за кавычки, а записи с битым ИНН стояли вперемешку с
 * настоящими. Здесь — правила, которые это закрывают, проверяемые без рендера.
 *
 * Обещание для того, что уже работало: всё, что находил прежний поиск,
 * находится и теперь — прежнее условие входит в новое целиком.
 */
import { isValidInnChecksum } from '../../shared/utils/inn';

export type SupplierLike = {
  id: string;
  name: string;
  inn: string | null;
  aliases?: readonly string[] | null;
};

/** Группа варианта: от неё зависят порядок и подпись. */
export type SupplierInnGroup = 'doc_inn' | 'valid' | 'no_inn' | 'invalid';

const GROUP_ORDER: Record<SupplierInnGroup, number> = {
  doc_inn: 0,
  valid: 1,
  no_inn: 2,
  invalid: 3,
};

/**
 * Текст для сравнения: регистр, «ё», кавычки и знаки препинания не важны.
 * Справочник пишет одно и то же как «АО "ИСТКУЛЬТ МОЖАЙСК"» и «АО ИСТКУЛЬТ
 * МОЖАЙСК», а человек кавычки в поиске не набирает.
 */
export function supplierSearchKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'„“”‚‘’`.,;:!?()[\]{}/\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function innDigits(inn: string | null | undefined): string {
  return (inn ?? '').replace(/\D/g, '');
}

/** ИНН проходит длину и контрольные цифры. */
export function isValidSupplierInn(inn: string | null | undefined): boolean {
  const digits = innDigits(inn);
  return (digits.length === 10 || digits.length === 12) && isValidInnChecksum(digits);
}

/**
 * Группа записи относительно ИНН документа. `docInn` — проверенный ИНН из
 * документа или null, если он неизвестен (тогда группы «как в документе» нет).
 */
export function supplierInnGroup(
  inn: string | null | undefined,
  docInn: string | null,
): SupplierInnGroup {
  const digits = innDigits(inn);
  if (!digits) return 'no_inn';
  if (docInn && digits === docInn) return 'doc_inn';
  return isValidSupplierInn(digits) ? 'valid' : 'invalid';
}

/** Подходит ли запись под запрос. Пустой запрос подходит всем. */
export function matchesSupplierQuery(s: SupplierLike, query: string): boolean {
  const raw = query.trim().toLowerCase();
  if (!raw) return true;
  // Прежнее условие целиком: что находилось раньше, находится и теперь.
  if (s.name.toLowerCase().includes(raw) || (s.inn ?? '').toLowerCase().includes(raw)) {
    return true;
  }
  const key = supplierSearchKey(query);
  if (key) {
    if (supplierSearchKey(s.name).includes(key)) return true;
    if ((s.aliases ?? []).some((a) => supplierSearchKey(a).includes(key))) return true;
  }
  // ИНН набирают и с пробелами: «5028 021 698».
  if (!/^[\d\s]+$/.test(raw)) return false;
  const digits = innDigits(raw);
  return digits.length >= 4 && innDigits(s.inn).includes(digits);
}

/**
 * Варианты для окна: отбор → порядок по группам → первые `limit`.
 *
 * Именно в этом порядке: обрезка до сортировки теряла бы запись «ИНН как в
 * документе», если она не попала в первые 200 строк справочника. Внутри
 * группы порядок справочника сохраняется (сортировка устойчивая).
 */
export function pickSupplierOptions<T extends SupplierLike>(
  items: readonly T[],
  query: string,
  docInn: string | null,
  limit = 200,
): Array<{ supplier: T; group: SupplierInnGroup }> {
  return items
    .filter((s) => matchesSupplierQuery(s, query))
    .map((supplier, index) => ({ supplier, group: supplierInnGroup(supplier.inn, docInn), index }))
    .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.index - b.index)
    .slice(0, limit)
    .map(({ supplier, group }) => ({ supplier, group }));
}

/** Подпись варианта. Строка — по ней antd ставит title, и на неё опираются тесты. */
export function supplierOptionLabel(s: SupplierLike, group: SupplierInnGroup): string {
  const base = s.inn ? `${s.name} · ИНН ${s.inn}` : s.name;
  if (group === 'doc_inn') return `${base} — ИНН как в документе`;
  if (group === 'invalid') return `${base} — ИНН не проходит проверку`;
  return base;
}

/** Совпадает ли ИНН записи с ИНН документа (по цифрам). */
export function supplierInnMatchesDocument(
  inn: string | null | undefined,
  docInn: string,
): boolean {
  return innDigits(inn) === docInn;
}
