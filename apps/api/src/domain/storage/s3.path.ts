/**
 * Формирование S3-ключей в понятной иерархии:
 *
 *   {site.code}/{counterparty}/{entity-type}/{entity-uuid}/{filename}
 *
 * Пример:
 *   MS-01/7707083893__llc-stroy-vostok/deliveries/a1b2.../c0ffee....jpg
 *
 * Что даёт:
 * - админ может находить файлы конкретного объекта/подрядчика без БД;
 * - смена name контрагента в справочнике не ломает старые пути (ИНН стабилен);
 * - inn гарантирует уникальность папок при близких именах.
 *
 * Старые ключи (photos/{uuid}/...) остаются в БД и продолжают работать через
 * хранимый s3Key — миграция не требуется.
 */

// Простая транслитерация кириллицы. Покрывает все буквы а-я + ё.
// Цель — читаемые ASCII-имена, не лингвистическая точность.
const CYR_TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

const SLUG_MAX_LEN = 64;

/**
 * Превращает произвольную строку (включая кириллицу) в slug
 * `[a-z0-9-]+`, ≤ 64 символа. Если результат пустой — возвращает 'x'
 * (S3 не любит пустые сегменты пути).
 */
export function slugify(text: string): string {
  if (!text) return 'x';
  let out = '';
  for (const ch of text.toLowerCase()) {
    if (CYR_TRANSLIT[ch] !== undefined) {
      out += CYR_TRANSLIT[ch];
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else {
      out += '-';
    }
  }
  // Схлопываем повторные '-' и обрезаем по краям.
  out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!out) return 'x';
  return out.slice(0, SLUG_MAX_LEN).replace(/-+$/, '');
}

/**
 * Минимальная санитизация для site.code и подобных коротких идентификаторов:
 * lowercase, только `[a-z0-9_-]`. Не разрезает на слова. Для пустых входов
 * возвращает 'unknown'.
 */
export function sanitizeKey(text: string | null | undefined): string {
  if (!text) return 'unknown';
  const out = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out || 'unknown';
}

export type EntityType = 'deliveries' | 'shipments' | 'source-documents';

export type S3PathInput = {
  site: { code: string | null } | null;
  // Либо реальный контрагент (тогда формат `{inn}__{slug(name)}`), либо
  // явная метка ('writeoff', 'transfer-to-XX', 'unknown') — используется
  // когда контрагента нет, но нужно осмысленное имя папки.
  counterparty: { inn: string; name: string } | null;
  fallbackCounterparty?: string;
  entityType: EntityType;
  entityId: string;
  filename: string;
};

function counterpartyKey(input: S3PathInput): string {
  if (input.counterparty) {
    const inn = sanitizeKey(input.counterparty.inn);
    const name = slugify(input.counterparty.name);
    return `${inn}__${name}`;
  }
  return sanitizeKey(input.fallbackCounterparty ?? 'unknown');
}

/**
 * Формирует полный S3-ключ. Все сегменты ASCII, безопасные для AWS S3.
 */
export function buildS3Key(input: S3PathInput): string {
  const siteCode = sanitizeKey(input.site?.code ?? null);
  const cp = counterpartyKey(input);
  const filename = input.filename.replace(/\.+/g, '.').replace(/^\/+|\/+$/g, '');
  return `${siteCode}/${cp}/${input.entityType}/${input.entityId}/${filename}`;
}
