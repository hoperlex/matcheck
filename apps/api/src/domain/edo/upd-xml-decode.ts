/**
 * Приведение XML-файла УПД к строке с учётом объявленной кодировки.
 *
 * Зачем отдельно. Документы ФНС регулярно приходят в windows-1251 — так их
 * выгружает 1С, и это законный вариант формата. Прочитав такой файл как UTF-8,
 * мы получим не «немного кривые буквы», а мусор во всех наименованиях,
 * названиях организаций и единицах измерения: документ разберётся «успешно» и
 * уедет в карточку нечитаемым. Поэтому кодировка берётся из XML-декларации, а
 * не предполагается.
 *
 * Декларация ищется в первых байтах и только среди ASCII-символов: до того, как
 * кодировка известна, доверять можно лишь им.
 */

/** Сколько байт от начала файла просматривать в поисках декларации. */
const DECLARATION_WINDOW = 200;

const CODEPAGE_ALIASES: Record<string, string> = {
  'windows-1251': 'windows-1251',
  win1251: 'windows-1251',
  cp1251: 'windows-1251',
  'windows-1252': 'windows-1252',
  'koi8-r': 'koi8-r',
  'iso-8859-5': 'iso-8859-5',
  'utf-8': 'utf-8',
  utf8: 'utf-8',
};

export function detectXmlEncoding(buffer: Buffer): string {
  // BOM однозначен и приоритетнее декларации.
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8';
  }
  const head = buffer.subarray(0, DECLARATION_WINDOW).toString('latin1');
  const match = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  if (!match) return 'utf-8';
  const declared = match[1]?.toLowerCase() ?? 'utf-8';
  return CODEPAGE_ALIASES[declared] ?? declared;
}

/**
 * Декодирует файл. Неизвестная кодировка — не повод потерять документ: читаем
 * как UTF-8 и оставляем разбор решать, получилось ли что-то осмысленное.
 */
export function decodeXmlBuffer(buffer: Buffer): string {
  const encoding = detectXmlEncoding(buffer);
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    return buffer.toString('utf-8');
  }
}
