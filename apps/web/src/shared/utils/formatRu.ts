// Форматирование данных для отображения в таблицах по русским стандартам.
// — даты: DD.MM.YYYY (как «01.01.2026»);
// — деньги: тысячи через неразрывный пробел, копейки через запятую,
//   суффикс «₽» (как «310 350,25 ₽»). Соответствует ГОСТ Р 7.0.97-2016.

/**
 * Принимает дату-строку (например ISO `2026-05-20` или `2026-05-20T…`) или null
 * и возвращает русский вид `20.05.2026`. На некорректный вход — «—».
 */
export function formatDateRu(input: string | null | undefined): string {
  if (!input) return '—';
  // Если строка короткая `YYYY-MM-DD` — парсим напрямую без таймзоны,
  // чтобы не сдвинуть на сутки в часовых поясах с отрицательным смещением.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (m) {
    return `${m[3]}.${m[2]}.${m[1]}`;
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Дата + время в русском виде: `20.05.2026 14:35`. Используется в колонках
 * таблиц с ISO-строками вида `2026-05-20T14:35:23.105Z`. Время — локальное
 * (браузерная таймзона), это важно для России (UTC+3): сервер пишет UTC,
 * пользователь видит московское время. На null/некорректный вход — «—».
 */
export function formatDateTimeRu(input: string | null | undefined): string {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${min}`;
}

/**
 * Деньги в русском формате с символом рубля: `310 350,25 ₽`.
 * Принимает число, строку-число (как в БД numeric) или null.
 * Возвращает «—» для null/NaN.
 */
export function formatMoneyRu(input: number | string | null | undefined): string {
  if (input === null || input === undefined || input === '') return '—';
  const n = typeof input === 'string' ? Number(input) : input;
  if (!Number.isFinite(n)) return '—';
  // Intl.NumberFormat ru-RU даёт тысячи через узкий неразрывный пробел
  // (U+202F) и запятую как разделитель десятичных — ровно то что нужно.
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted} ₽`;
}

/**
 * Formatter для antd InputNumber: число → «1 234,56» (с узким неразрывным
 * пробелом и запятой). Символ рубля не добавляем — он навешивается через
 * addonAfter, чтобы не мешать редактированию.
 */
export function inputNumberFormatterRu(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * Parser для antd InputNumber: «1 234,56 ₽» → «1234.56» (точкой, без
 * пробелов и валюты). Принимает любые «грязные» строки от пользователя.
 */
export function inputNumberParserRu(displayValue: string | undefined): string {
  if (!displayValue) return '';
  return displayValue
    .replace(/[\s  ]/g, '')
    .replace(/[^\d,.-]/g, '')
    .replace(',', '.');
}
