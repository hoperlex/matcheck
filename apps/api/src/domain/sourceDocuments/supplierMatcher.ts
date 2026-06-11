import { eq, sql } from 'drizzle-orm';
import { suppliers } from '../../db/schema.js';

// Поиск поставщика в справочнике (suppliers, 982+ записей, импорт из JSON
// заказчика) при распознавании УПД/накладной. Если не нашли — добавляем
// новую запись и возвращаем её id (счётчик «Поставщики» вырастает на 1).
// В counterparties для распознанных УПД ничего не пишем — поставщики ≠
// контрагенты, это разные сущности (см. миграцию 0064).
//
// Алгоритм:
//   1. Если есть ИНН — точный поиск по inn. Найден → возвращаем.
//   2. Иначе/если не нашли по ИНН — fuzzy-поиск по нормализованному имени:
//      нормализованный Левенштейн ≥ THRESHOLD (0.9). Учитываем aliases.
//      При совпадении: если у найденной строки inn пустой, а у нас есть —
//      дописываем (справочник enriches). Если у строки уже есть inn, и он
//      отличается от нашего — пропускаем кандидата (это другая компания
//      с похожим названием).
//   3. Не нашли → INSERT новую запись в suppliers под защитой
//      pg_advisory_xact_lock (от гонок при параллельной загрузке).
//
// Возвращает каноничное name из справочника — оно и пойдёт в шапку документа.

const FUZZY_THRESHOLD = 0.9;

export type ParsedSupplier = {
  inn: string | null;
  kpp: string | null;
  name: string | null;
};

export type SupplierMatch = {
  id: string;
  name: string;
  source: 'inn' | 'name' | 'created';
};

// ─── Чистые функции (нормализация, similarity) — экспортируем для тестов ───

/**
 * Нормализация имени поставщика для fuzzy-сравнения. Не для отображения.
 * - toLowerCase
 * - ё → е
 * - убираем кавычки всех видов
 * - сворачиваем пробелы / дефисы / точки / запятые в один пробел
 * - trim
 *
 * «ООО "ТД "ТУЛА-СТАЛЬ"»  →  «ооо тд тула сталь»
 * «ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "Завод-Лит"»
 *                        →  «общество с ограниченной ответственностью завод лит»
 *
 * Префиксы организационно-правовой формы (ООО/АО/ПАО/«Общество с
 * ограниченной ответственностью») сознательно НЕ удаляются: тогда «ООО
 * "Стройдеталь"» и «АО "Стройдеталь"» считались бы одинаковыми, что
 * неверно — это разные юрлица. Уловить «ООО vs ОБЩЕСТВО С ОГРАНИЧЕННОЙ
 * ОТВЕТСТВЕННОСТЬЮ» можно через явный alias в справочнике.
 */
export function normalizeSupplierName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    // Все варианты кавычек: «»"'""''ʼ`
    .replace(/[«»"'‘’“”„‚ʼ`]/g, '')
    // Знаки препинания и разделители → пробел
    .replace(/[\s\-_.,;:/\\()[\]]+/g, ' ')
    .trim();
}

/**
 * Расстояние Левенштейна между двумя строками. Динамическое программирование
 * двумя массивами (O(n) памяти).
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1);
  let curr = new Array<number>(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m] ?? 0;
}

/**
 * Сходство двух имён поставщиков (0..1). Нормализуем оба, потом
 * 1 - dist/maxLen. Пустые → 0.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeSupplierName(a);
  const nb = normalizeSupplierName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dist = levenshteinDistance(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
}

// ─── DB-функция ────────────────────────────────────────────────────────────

/**
 * Найти существующего поставщика в справочнике, либо создать новый.
 * Все БД-операции внутри транзакции (advisory_xact_lock держится до commit).
 *
 * Returns `null` только если parsed целиком пустой (ни inn, ни name).
 */
export async function matchOrCreateSupplier(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: { db: any },
  parsed: ParsedSupplier,
): Promise<SupplierMatch | null> {
  const inn = parsed.inn?.trim() || null;
  const name = parsed.name?.trim() || null;
  if (!inn && !name) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.db.transaction(async (tx: any): Promise<SupplierMatch | null> => {
    // Шаг 1: exact по ИНН.
    if (inn) {
      const found = await tx
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.inn, inn))
        .limit(1);
      if (found[0]) {
        return { id: found[0].id, name: found[0].name, source: 'inn' };
      }
    }

    // Шаг 2: fuzzy по имени (учитываем aliases).
    if (name) {
      // Тянем все 982+ записи — для текущих объёмов это 10-20мс, без индексов
      // по нормализованному имени. На масштабе >10k нужно будет добавить
      // pg_trgm + индекс по lower(name) с similarity-функцией.
      const all = await tx
        .select({
          id: suppliers.id,
          name: suppliers.name,
          inn: suppliers.inn,
          aliases: suppliers.aliases,
        })
        .from(suppliers);
      let best: { id: string; name: string; inn: string; sim: number } | null = null;
      for (const c of all) {
        // Если у кандидата ИНН непустой и не совпадает с нашим — это другая
        // компания с похожим именем, пропускаем.
        if (inn && c.inn && c.inn !== inn) continue;
        // Сравниваем с основным именем И с aliases — берём максимум.
        let sim = nameSimilarity(name, c.name);
        for (const alias of c.aliases ?? []) {
          const s = nameSimilarity(name, alias);
          if (s > sim) sim = s;
        }
        if (sim >= FUZZY_THRESHOLD && (!best || sim > best.sim)) {
          best = { id: c.id, name: c.name, inn: c.inn, sim };
        }
      }
      if (best) {
        // Бонус: дописать ИНН в справочную запись, если там пусто, а у нас есть.
        if (inn && !best.inn) {
          await tx
            .update(suppliers)
            .set({ inn, updatedAt: new Date() })
            .where(eq(suppliers.id, best.id));
        }
        return { id: best.id, name: best.name, source: 'name' };
      }
    }

    // Шаг 3: создать нового. Блокировка от гонок — advisory_xact_lock по
    // hashtext(inn). Если inn пустой — по hashtext(нормализованное имя).
    // Lock держится до конца транзакции, что гарантирует: две параллельные
    // загрузки одного нового поставщика не создадут дубль.
    const lockKey = inn ? inn : normalizeSupplierName(name ?? '');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    // Перепроверка после lock — другая транзакция могла создать запись,
    // пока мы ждали блокировку.
    if (inn) {
      const recheck = await tx
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.inn, inn))
        .limit(1);
      if (recheck[0]) {
        return { id: recheck[0].id, name: recheck[0].name, source: 'inn' };
      }
    }

    if (!name) return null; // нет имени — создавать пустую запись не хотим
    const inserted = await tx
      .insert(suppliers)
      .values({
        inn: inn ?? '',
        name,
      })
      .returning({ id: suppliers.id, name: suppliers.name });
    const row = inserted[0];
    if (!row) return null;
    return { id: row.id, name: row.name, source: 'created' };
  });
}
