/**
 * Работа с номерами документов: нормализация, сравнение и поиск пропусков в
 * нумерации пакета.
 *
 * Зачем отдельный модуль. Номер приезжает из двух независимых источников —
 * от классификатора страниц (что напечатано в шапке) и от парсера документа
 * (что он извлёк). Сравнивать их «как есть» нельзя: OCR путает кириллические
 * и латинские буквы, теряет префикс, добавляет пробелы вокруг дефиса. При
 * этом цена ошибки несимметрична: лишний разрез рвёт настоящий документ
 * пополам, поэтому все правила здесь СОЗНАТЕЛЬНО консервативны — сомнение
 * всегда трактуется как «это один и тот же документ».
 */

/**
 * Кириллические буквы, неотличимые на глаз от латинских. OCR подставляет то
 * одну, то другую в одном и том же номере одного и того же поставщика.
 */
const HOMOGLYPHS: ReadonlyMap<string, string> = new Map([
  ['А', 'A'],
  ['В', 'B'],
  ['Е', 'E'],
  ['К', 'K'],
  ['М', 'M'],
  ['Н', 'H'],
  ['О', 'O'],
  ['Р', 'P'],
  ['С', 'C'],
  ['Т', 'T'],
  ['Х', 'X'],
  ['У', 'Y'],
]);

/** Разновидности тире и минуса, которыми печатают один и тот же номер. */
const DASHES = /[‐-―−]/g;

/**
 * Приводит номер к сравнимому виду: без «№», в верхнем регистре, без лишних
 * пробелов, с латинскими буквами вместо гомоглифов.
 *
 * Возвращает null, если в номере нет ни одной цифры: «б/н» и подобное
 * сравнивать бессмысленно — по такому «номеру» документы не различить.
 */
export function normalizeDocNumber(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const upper = trimmed
    .replace(/^[№#N]\s*/iu, '')
    .replace(DASHES, '-')
    .toUpperCase();
  const mapped = [...upper].map((ch) => HOMOGLYPHS.get(ch) ?? ch).join('');
  const collapsed = mapped.replace(/\s+/g, ' ').trim();
  if (collapsed === '' || !/\d/.test(collapsed)) return null;
  return collapsed;
}

/**
 * Последняя группа цифр номера — то, что реально различает документы одной
 * серии: «УТ-4308» → 4308, «0000-0082606» → 0082606.
 */
export function numericTail(normalized: string): string | null {
  const m = normalized.match(/(\d+)\s*$/u);
  return m ? (m[1] ?? null) : null;
}

/**
 * Разные ли это документы.
 *
 * true возвращается ТОЛЬКО когда оба номера читаются и их числовые хвосты
 * различны. Все остальные случаи — «не знаем» — дают false:
 *
 *  - любой номер отсутствует или без цифр: резать нечем;
 *  - «УТ-4305» против «4305»: хвосты равны, а префикс мог потеряться при
 *    распознавании — это один документ, а не два.
 */
export function differentDocNumber(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeDocNumber(a);
  const nb = normalizeDocNumber(b);
  if (na == null || nb == null) return false;
  const ta = numericTail(na);
  const tb = numericTail(nb);
  if (ta == null || tb == null) return false;
  return ta.replace(/^0+/, '') !== tb.replace(/^0+/, '');
}

export type NumberGap = {
  /**
   * Общая часть номера до числового хвоста: «УТ-», «0000-».
   *
   * Берётся из ИСХОДНОГО номера, а не из нормализованного: нормализация
   * заменяет кириллические буквы латинскими двойниками, и менеджеру в
   * предупреждении показалось бы «YT-4308» вместо «УТ-4308».
   */
  prefix: string;
  from: number;
  to: number;
  /** Отсутствующие числа ряда. */
  missing: number[];
};

/** Больше пропусков подряд — это уже не «потеряли документ», а разные отгрузки. */
const MAX_GAP = 3;
/** Ряд короче трёх номеров о непрерывности нумерации ничего не говорит. */
const MIN_SERIES = 3;

/**
 * Ищет пропуски в нумерации внутри одного пакета.
 *
 * Эвристика, а не доказательство: непоследовательная нумерация законна —
 * поставщик мог выписать соседние номера на другую машину. Поэтому условия
 * узкие (общий префикс, ряд от трёх документов, пропуск не длиннее трёх), а
 * результат — повод открыть файл, а не признак ошибки.
 */
export function findNumberGaps(numbers: ReadonlyArray<string | null | undefined>): NumberGap[] {
  const series = new Map<string, { values: Set<number>; displayPrefix: string }>();
  for (const raw of numbers) {
    const normalized = normalizeDocNumber(raw);
    if (normalized == null) continue;
    const tail = numericTail(normalized);
    if (tail == null) continue;
    // Хвост длиннее пятнадцати цифр — это не серия, а идентификатор ЭДО;
    // Number на нём теряет точность, и «пропуски» получились бы выдуманные.
    if (tail.length > 15) continue;
    const prefix = normalized.slice(0, normalized.length - tail.length);
    if (prefix === '') continue;
    const bucket = series.get(prefix) ?? {
      values: new Set<number>(),
      // Как этот префикс напечатан в документе — для текста предупреждения.
      displayPrefix:
        (raw ?? '')
          .trim()
          .replace(/^[№#N]\s*/iu, '')
          .slice(0, -tail.length) || prefix,
    };
    bucket.values.add(Number(tail));
    series.set(prefix, bucket);
  }

  const gaps: NumberGap[] = [];
  for (const [, { values, displayPrefix }] of series) {
    if (values.size < MIN_SERIES) continue;
    const sorted = [...values].sort((a, b) => a - b);
    const from = sorted[0]!;
    const to = sorted[sorted.length - 1]!;
    const span = to - from + 1;
    const missingCount = span - sorted.length;
    if (missingCount <= 0 || missingCount > MAX_GAP) continue;
    const present = new Set(sorted);
    const missing: number[] = [];
    for (let n = from; n <= to; n++) if (!present.has(n)) missing.push(n);
    gaps.push({ prefix: displayPrefix, from, to, missing });
  }
  return gaps;
}
