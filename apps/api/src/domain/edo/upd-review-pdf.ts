/**
 * УПД из ЭДО для сверки глазами: PDF, собранный из разобранного XML.
 *
 * Это НЕ печатная форма и не оригинал документа. PDF строится только из
 * UpdParsed, поэтому в нём ровно то, что умеет читать парсер: адресов продавца
 * и покупателя в UpdParsed нет, подписей ЭП и сведений об операторе — тоже.
 * Так документ и подписан, чтобы менеджер не принял его за бланк.
 *
 * Чего парсер не различает, мы не выдумываем. «Без НДС» и пустая ставка
 * приходят одинаковым null, отсутствующее количество — нулём (upd.parser.ts,
 * num() и разбор СведТов). Такие ячейки печатаются «—», а не числом.
 *
 * Неполный разбор не прячется: updCompletenessWarnings перечисляет, что не
 * сходится, и список выводится красной рамкой вверху первой страницы.
 *
 * pdfmake подключается лениво, при первом рендере: если с пакетом или его
 * шрифтами что-то не так, падает один этот маршрут, а не старт всего API.
 */
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import type { PdfContent, PdfDocumentDefinition, PdfMake } from 'pdfmake';
import type { UpdDocRef, UpdItem, UpdParsed, UpdParty, UpdShipParty } from './upd.parser.js';

/** Больше не читаем из S3: реальный максимум реестра — 401 КБ (замер 12.10.2026). */
export const UPD_PDF_MAX_XML_BYTES = 2 * 1024 * 1024;
/** Реальный максимум — 458 позиций; 1000 строк рендерятся за полсекунды. */
export const UPD_PDF_MAX_ITEMS = 1000;
/** Потолок готового файла: 1000 строк дают около 300 КБ. */
export const UPD_PDF_MAX_BYTES = 10 * 1024 * 1024;
/**
 * Потолок времени одного рендера. Промис getBuffer у pdfmake не слушает
 * ошибку потока и при сбое посреди записи ждал бы вечно, держа слот.
 */
const RENDER_TIMEOUT_MS = 20_000;

/** PDF не построился или не прошёл проверку готового файла. */
export class UpdPdfRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpdPdfRenderError';
  }
}

const DASH = '—';

function positionsWord(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'позиции' : 'позиций';
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Число по-русски. Разделитель разрядов — неразрывный пробел U+00A0: ICU даёт
 * узкий U+202F, а его глифа в шрифте может не быть; к тому же число не должно
 * разрываться переносом строки в узкой колонке.
 */
function formatNumber(value: number, minFraction: number, maxFraction: number): string {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: minFraction,
    maximumFractionDigits: maxFraction,
  })
    .format(value)
    .replace(/\s/g, ' ');
}

function money(value: number | null): string {
  return value === null ? DASH : formatNumber(value, 2, 2);
}

function price(value: number | null): string {
  return value === null ? DASH : formatNumber(value, 2, 6);
}

/** Количество 0 — это и «ноль», и «не указано»: парсер их не различает. */
function quantity(value: number): string {
  return value === 0 ? DASH : formatNumber(value, 0, 6);
}

function vatRate(value: number | null): string {
  return value === null ? DASH : `${formatNumber(value, 0, 2)}%`;
}

/** ISO → ДД.ММ.ГГГГ; всё прочее печатаем как пришло. */
function date(value: string | null | undefined): string {
  if (!value) return DASH;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return iso ? `${iso[3]}.${iso[2]}.${iso[1]}` : value;
}

function sumOf(values: Array<number | null>): { total: number; missing: number } {
  let total = 0;
  let missing = 0;
  for (const v of values) {
    if (v === null) missing++;
    else total += v;
  }
  return { total: round2(total), missing };
}

/**
 * Что в разборе не сходится или не прочиталось. Пустой список — документ
 * разобран целиком и итог совпадает с суммой позиций.
 */
export function updCompletenessWarnings(parsed: UpdParsed): string[] {
  const warnings: string[] = [];
  if (!parsed.docNumber.trim()) warnings.push('Номер документа не прочитан.');
  if (!parsed.docDate.trim()) warnings.push('Дата документа не прочитана.');

  const items = parsed.items;
  if (items.length === 0) {
    warnings.push('В документе не прочитано ни одной позиции.');
    return warnings;
  }

  const noQty = items.filter((item) => item.qty === 0).length;
  if (noQty > 0) {
    warnings.push(`У ${noQty} ${positionsWord(noQty)} количество не прочитано или равно нулю.`);
  }

  if (parsed.totalSum === null && parsed.totalExVat === null) {
    warnings.push('Итог документа не прочитан — сверить сумму позиций не с чем.');
    return warnings;
  }

  // Округление строк даёт копейки расхождения — допуск растёт с числом строк.
  const tolerance = Math.max(0.05, 0.01 * items.length);
  const compare = (values: Array<number | null>, total: number | null, label: string) => {
    if (total === null) return;
    const { total: sum, missing } = sumOf(values);
    if (missing > 0) {
      warnings.push(
        `У ${missing} ${positionsWord(missing)} не прочитана стоимость ${label} — сумму с итогом не сверить.`,
      );
      return;
    }
    const diff = round2(Math.abs(sum - total));
    if (diff > tolerance) {
      warnings.push(
        `Сумма позиций ${label} (${money(sum)} ₽) не сходится с итогом документа (${money(total)} ₽), разница ${money(diff)} ₽.`,
      );
    }
  };
  compare(
    items.map((item) => item.sum),
    parsed.totalSum,
    'с НДС',
  );
  compare(
    items.map((item) => item.sumExVat),
    parsed.totalExVat,
    'без НДС',
  );
  return warnings;
}

function innKpp(inn: string | null, kpp: string | null): string {
  const parts: string[] = [];
  if (inn) parts.push(`ИНН ${inn}`);
  if (kpp) parts.push(`КПП ${kpp}`);
  return parts.join(', ');
}

function partyText(party: UpdParty): string {
  return [party.name || DASH, innKpp(party.inn || null, party.kpp)].filter(Boolean).join(', ');
}

function shipPartyText(party: UpdShipParty | null): string {
  if (!party) return DASH;
  const text = [
    party.name,
    innKpp(party.inn, party.kpp),
    party.address ? `адрес: ${party.address}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return text || DASH;
}

function docRefText(ref: UpdDocRef): string {
  return [ref.name, ref.number ? `№ ${ref.number}` : null, ref.date ? `от ${date(ref.date)}` : null]
    .filter(Boolean)
    .join(' ');
}

const FUNCTION_TITLES: Record<string, string> = {
  СЧФДОП: 'СЧФДОП — счёт-фактура и передаточный документ',
  СЧФ: 'СЧФ — счёт-фактура',
  ДОП: 'ДОП — передаточный документ',
};

function currencyText(code: string | null): string {
  if (!code) return DASH;
  return code === '643' ? '643 — российский рубль' : code;
}

function unitText(item: UpdItem): string {
  return item.unitCode && item.unitCode !== item.unit
    ? `${item.unit} (${item.unitCode})`
    : item.unit;
}

const ITEM_HEADERS = [
  '№',
  'Код товара',
  'Наименование товара (работ, услуг)',
  'Ед. изм. (ОКЕИ)',
  'Кол-во',
  'Цена без НДС',
  'Стоимость без НДС',
  'Ставка',
  'Сумма НДС',
  'Стоимость с НДС',
];

function itemsTable(parsed: UpdParsed): PdfContent {
  const num = (text: string) => ({ text, alignment: 'right', noWrap: true });
  const body: PdfContent[][] = [
    ITEM_HEADERS.map((text) => ({ text, bold: true, fillColor: '#eeeeee' })),
    ...parsed.items.map((item): PdfContent[] => [
      String(item.lineNo),
      item.productCode ?? DASH,
      item.nameRaw || DASH,
      unitText(item),
      num(quantity(item.qty)),
      num(price(item.price)),
      num(money(item.sumExVat)),
      num(vatRate(item.vatRate)),
      num(money(item.vatSum)),
      num(money(item.sum)),
    ]),
    [
      { text: 'Всего к оплате', bold: true, colSpan: 6 },
      '',
      '',
      '',
      '',
      '',
      { ...num(money(parsed.totalExVat)), bold: true },
      num(''),
      { ...num(money(parsed.vatSum)), bold: true },
      { ...num(money(parsed.totalSum)), bold: true },
    ],
  ];
  return {
    table: {
      headerRows: 1,
      dontBreakRows: true,
      widths: [20, 52, '*', 52, 48, 62, 66, 34, 58, 66],
      body,
    },
    layout: {
      hLineWidth: () => 0.5,
      vLineWidth: () => 0.5,
      hLineColor: () => '#999999',
      vLineColor: () => '#999999',
    },
  };
}

function requisitesTable(parsed: UpdParsed): PdfContent {
  const rows: Array<[string, string]> = [
    ['Статус', parsed.function ? (FUNCTION_TITLES[parsed.function] ?? parsed.function) : DASH],
  ];
  if (parsed.correction) {
    rows.push([
      'Исправление',
      `№ ${parsed.correction.number ?? DASH} от ${date(parsed.correction.date)}`,
    ]);
  }
  const sellers = parsed.suppliers.length ? parsed.suppliers : [parsed.supplier];
  rows.push([sellers.length > 1 ? 'Продавцы' : 'Продавец', sellers.map(partyText).join('\n')]);
  rows.push([
    'Грузоотправитель',
    parsed.consignorSameAsSeller ? 'он же' : shipPartyText(parsed.consignor),
  ]);
  rows.push(['Грузополучатель', shipPartyText(parsed.consignee)]);
  const buyers = parsed.buyers.length ? parsed.buyers : parsed.recipient ? [parsed.recipient] : [];
  rows.push([
    buyers.length > 1 ? 'Покупатели' : 'Покупатель',
    buyers.map(partyText).join('\n') || DASH,
  ]);
  rows.push(['Валюта', currencyText(parsed.currencyCode)]);
  if (parsed.transfer) {
    rows.push(['Дата отгрузки (передачи)', date(parsed.transfer.date)]);
    if (parsed.transfer.operation) rows.push(['Содержание операции', parsed.transfer.operation]);
    if (parsed.transfer.basis.length) {
      rows.push(['Основание передачи', parsed.transfer.basis.map(docRefText).join('\n')]);
    }
  }
  if (parsed.shippingDocs.length) {
    rows.push(['Документы об отгрузке', parsed.shippingDocs.map(docRefText).join('\n')]);
  }
  return {
    table: {
      widths: [130, '*'],
      body: rows.map(([label, value]) => [{ text: label, color: '#555555' }, value]),
    },
    layout: 'noBorders',
  };
}

function warningsBox(warnings: string[]): PdfContent {
  return {
    table: {
      widths: ['*'],
      body: [
        [
          {
            stack: [
              { text: 'Проверьте по XML: разбор документа неполный или не сходится', bold: true },
              // Копия: pdfmake правит описание документа на месте и заменил
              // бы строки объектами в массиве, который вернётся вызывающему.
              { ul: [...warnings] },
            ],
            fillColor: '#fdecea',
            color: '#a8071a',
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1,
      vLineWidth: () => 1,
      hLineColor: () => '#cf1322',
      vLineColor: () => '#cf1322',
    },
    margin: [0, 0, 0, 8],
  };
}

export function buildUpdPdfDefinition(
  parsed: UpdParsed,
  warnings: string[],
): PdfDocumentDefinition {
  const title = `Универсальный передаточный документ № ${parsed.docNumber || DASH} от ${date(parsed.docDate)}`;
  const content: PdfContent[] = [
    { text: title, fontSize: 13, bold: true },
    {
      text: 'Представление для сверки: построено порталом из XML документа ЭДО. Это не печатная форма и не оригинал документа.',
      color: '#555555',
      margin: [0, 2, 0, 8],
    },
  ];
  if (warnings.length) content.push(warningsBox(warnings));
  content.push(requisitesTable(parsed), { text: '', margin: [0, 6, 0, 0] }, itemsTable(parsed));
  content.push({
    stack: [
      '«—» — значение не указано в XML либо не прочитано (в том числе ставка «без НДС» и пустое количество).',
      'В представление не входят: адреса продавца и покупателя, электронные подписи, сведения об операторе ЭДО. Источник правды — XML документа.',
    ],
    color: '#555555',
    fontSize: 7,
    margin: [0, 8, 0, 0],
  });
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 28, 28, 36],
    info: { title, creator: 'MatCheck', producer: 'MatCheck' },
    defaultStyle: { font: 'Roboto', fontSize: 8 },
    content,
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        {
          text: `ИдФайл ${parsed.fileId ?? DASH} · формат ${parsed.formatVersion ?? DASH} · КНД ${parsed.knd ?? DASH}`,
          fontSize: 6,
          color: '#777777',
        },
        {
          text: `стр. ${currentPage} из ${pageCount}`,
          alignment: 'right',
          fontSize: 7,
          color: '#777777',
        },
      ],
      margin: [28, 12, 28, 0],
    }),
  };
}

let engine: Promise<PdfMake> | null = null;

/**
 * pdfmake 0.3 — синглтон с глобальными шрифтами и политиками доступа.
 * Настраиваем один раз: сеть запрещена совсем (в документе только текст),
 * с диска можно читать лишь каталог шрифтов Roboto из самого пакета —
 * в нём есть кириллица, а путь не зависит от шрифтов, установленных в образе.
 */
function loadEngine(): Promise<PdfMake> {
  engine ??= (async () => {
    const pdfmake = (await import('pdfmake')).default;
    const fontDir = join(
      dirname(createRequire(import.meta.url).resolve('pdfmake/package.json')),
      'fonts',
      'Roboto',
    );
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy((path) => path.startsWith(fontDir + sep));
    pdfmake.setFonts({
      Roboto: {
        normal: join(fontDir, 'Roboto-Regular.ttf'),
        bold: join(fontDir, 'Roboto-Medium.ttf'),
        italics: join(fontDir, 'Roboto-Italic.ttf'),
        bolditalics: join(fontDir, 'Roboto-MediumItalic.ttf'),
      },
    });
    return pdfmake;
  })().catch((err: unknown) => {
    // Не запоминаем сбой: следующая попытка загрузит модуль заново.
    engine = null;
    throw err;
  });
  return engine;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpdPdfRenderError(`рендер дольше ${ms} мс`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * PDF-представление УПД. Лимиты на размер XML и число позиций проверяет
 * вызывающий — до чтения S3 и до рендера; здесь проверяется готовый файл.
 *
 * @throws {UpdPdfRenderError} pdfmake не загрузился, рендер упал или
 *   затянулся, файл больше потолка или без сигнатуры PDF.
 */
export async function renderUpdPdf(
  parsed: UpdParsed,
): Promise<{ pdf: Buffer; warnings: string[] }> {
  const warnings = updCompletenessWarnings(parsed);
  let pdf: Buffer;
  try {
    const pdfmake = await loadEngine();
    pdf = await withTimeout(
      pdfmake.createPdf(buildUpdPdfDefinition(parsed, warnings)).getBuffer(),
      RENDER_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof UpdPdfRenderError) throw err;
    throw new UpdPdfRenderError('pdfmake не построил документ', { cause: err });
  }
  if (pdf.length > UPD_PDF_MAX_BYTES) {
    throw new UpdPdfRenderError(`PDF ${pdf.length} байт больше потолка ${UPD_PDF_MAX_BYTES}`);
  }
  if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new UpdPdfRenderError('в результате нет сигнатуры %PDF-');
  }
  return { pdf, warnings };
}
