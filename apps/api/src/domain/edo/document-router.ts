// Классификатор документов для единого входа «Загрузить документы».
// Скучный и наблюдаемый: дешёвый ДЕТЕРМИНИРОВАННЫЙ разбор (расширение + проба
// текстового слоя), без LLM. Возвращает решение + confidence + сигналы для
// журнала (bundle_import_items). Файлы, которые детерминированно не
// классифицируются (сканы/фото/неясный текст), помечаются needsVision=true —
// их доклассифицирует vision-слой (Этап 4) через prefilterUpdPages.
//
// Принцип: НЕ парсим здесь документ целиком и НЕ пишем данные — только решаем,
// КУДА его маршрутизировать. Реальный парсинг — существующими парсерами в
// worker. Тип наугад не назначаем: при сомнении → unknown + needsVision.

import { PDFParse } from 'pdf-parse';
import { countUniqueUpdInvoices } from './upd-text-bundle.parser.js';
import { parseUpdXlsx } from './upd-xlsx.parser.js';

// 'supplementary' — сопроводительный документ качества: сертификат, паспорт
// качества, декларация о соответствии, протокол испытаний. Реквизиты из него не
// нужны, распознавание не запускается — файл просто хранится и показывается
// менеджеру. Раньше такие файлы уходили в УПД-flow и оседали пустыми
// черновиками, попутно занимая слот воркера и тратя vision-вызовы.
export type DocClass =
  | 'upd'
  | 'transport_waybill'
  | 'os2_transfer'
  | 'm15'
  | 'supplementary'
  | 'unknown';

export type FileClassification = {
  detectedKind: DocClass;
  confidence: number; // 0..1
  // true — детерминированно не определили (скан/фото/неясный текст): нужен
  // vision-слой (Этап 4). false — решение принято по тексту/расширению.
  needsVision: boolean;
  // предполагаемый парсер (для журнала parserUsed); 'none' — не парсим
  parserUsed:
    | 'parseUpdXlsx'
    | 'parseUpdPdf'
    | 'tryParseTextUpdBundle'
    | 'parseWaybillBatch'
    | 'none';
  signals: string[];
  // для текстовых УПД — сколько уникальных счёт-фактур (≥2 → multi-UPD bundle)
  updInvoiceCount?: number;
};

const IMAGE_RE = /\.(jpe?g|png|webp|heic|heif)$/i;
const EXCEL_RE = /\.(xlsx|xls)$/i;
const PDF_RE = /\.pdf$/i;
const MIN_TEXT = 200;
// Имя файла как офлайн-сигнал М-15 (накладная на отпуск материалов): когда у
// фото/скана нет текстового слоя или он «битый» (шрифты 1С), тип по содержимому
// не определить. Маркеры в имени: «М-15», «накладная на отпуск», «отпуск
// материалов». Используется в fallback-ветках (image/scan/parse_error/ambiguous).
const M15_NAME_RE = /м-?15|m-?15|накладная на отпуск|отпуск\s+материал/i;
// Маркеры сопроводительных документов качества. Перечень намеренно узкий:
// только качество и соответствие. «Акт» и «спецификация» сюда НЕ входят — в них
// бывают позиции и суммы, и увести их из распознавания значило бы потерять
// данные.
const SUPPLEMENTARY_RE =
  /сертификат\s+(соответстви|качеств)|паспорт\s+качеств|декларац\w*\s+о\s+соответстви|протокол\s+испытани/i;

// «Грузоотправитель» встречается не только в транспортной накладной: это
// штатная графа ТОРГ-12 и УПД. Поэтому одного этого слова для маршрута в
// parseWaybillBatch недостаточно. ТН подтверждаем заголовком И признаком
// формы: постановлением № 2116, формой 1-Т/ТТН либо нумерованными разделами.
//
// Важно: без флага `u` JS-класс `\w` не включает кириллицу. Во всех новых
// выражениях ниже используются явные `[а-яё]`, иначе окончания слов снова
// окажутся мёртвыми альтернативами.
const TORG12_RE = /форма\s+(?:по\s+окуд\s+)?№?\s*торг\s*-?\s*12|товарн[а-яё]*\s+накладн[а-яё]*/i;
const TRANSPORT_WAYBILL_TITLE_RE = /транспортн[а-яё]*\s+накладн[а-яё]*/i;
const TRANSPORT_WAYBILL_FORM_RE =
  /постановлен[а-яё]*[^.]{0,160}№?\s*2116|товарно\s*-?\s*транспортн[а-яё]*\s+накладн[а-яё]*|(?:^|\s)ттн(?:\s|№|$)|типов[а-яё]*\s+(?:межотраслев[а-яё]*\s+)?форм[а-яё]*\s+№?\s*1\s*-\s*т/i;

/** Есть ли в тексте хотя бы два разных нумерованных раздела формы ТН. */
function hasNumberedWaybillSections(text: string): boolean {
  const sections = new Set<string>();
  // Требуем пробел после точки и буквенный/кавычечный заголовок. Это не даёт
  // датам и десятичным числам вроде 28.06 или 1.75 подтвердить форму.
  const re = /(?:^|\s)([1-9]|1\d)(?:[а-яё])?\.\s+(?=[«"'(а-яёa-z])/gi;
  for (const match of text.matchAll(re)) sections.add(match[1]!);
  return sections.size >= 2;
}

function isTransportWaybillText(text: string): boolean {
  if (!TRANSPORT_WAYBILL_TITLE_RE.test(text)) return false;
  return TRANSPORT_WAYBILL_FORM_RE.test(text) || hasNumberedWaybillSections(text);
}
function m15ByName(signals: string[]): FileClassification {
  // needsVision=true: М-15 всегда распознаём через vision (своим m15-промптом).
  return { detectedKind: 'm15', confidence: 0, needsVision: true, parserUsed: 'none', signals };
}

async function extractPdfText(
  buffer: Buffer,
): Promise<{ pages: { num: number; text: string }[]; full: string }> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const r = await parser.getText();
    const pages = (r.pages ?? []).map((p) => ({
      num: typeof p.num === 'number' ? p.num : 0,
      text: p.text ?? '',
    }));
    const full = (r.text ?? '').replace(/\s+/g, ' ').trim();
    return { pages, full };
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Детерминированная классификация одного файла. Без LLM, без записи данных.
 * Excel → УПД (structural); PDF с текстом → по маркерам формы; скан/фото/
 * неясный текст → needsVision (доклассификация в Этапе 4).
 */
export async function classifyFile(
  buffer: Buffer,
  mime: string,
  filename: string,
): Promise<FileClassification> {
  const lower = filename.toLowerCase();
  const m = (mime || '').toLowerCase();

  // ── Excel: УПД/реализация, но только если книга на него похожа ──
  //
  // Раньше расширения хватало, и любая таблица — спецификация, прайс, реестр —
  // становилась УПД и оседала пустым черновиком. Проверяем структурно тем же
  // парсером, который потом и будет разбирать файл: confidence === 0 означает,
  // что не нашлось НИ ОДНОГО поля шапки (ни номера, ни даты, ни сторон).
  // Условие намеренно узкое — книга хоть с чем-то распознанным остаётся УПД,
  // как и раньше. Сбой парсера тоже оставляет прежнее поведение: потерять
  // распознаваемое хуже, чем принять лишний файл.
  if (/spreadsheetml|ms-excel/.test(m) || EXCEL_RE.test(lower)) {
    let looksLikeUpd = true;
    let signal = 'ext:excel';
    try {
      const probe = await parseUpdXlsx(buffer);
      looksLikeUpd = probe.confidence > 0 || probe.items.length > 0;
      if (!looksLikeUpd) signal = 'excel:not-upd';
    } catch {
      signal = 'excel:probe-failed';
    }
    if (!looksLikeUpd) {
      // needsVision: true — приговор выносит не регулярка по чужому шаблону, а
      // модель по картинке. Сама доклассификация живёт в worker и включается
      // флагом EXCEL_VISION_ROUTING; без него ветка unknown ниже отработает
      // ровно как раньше — заглушка «не распознано».
      return {
        detectedKind: 'unknown',
        confidence: 0,
        needsVision: true,
        parserUsed: 'none',
        signals: [signal],
      };
    }
    return {
      detectedKind: 'upd',
      confidence: 0.99,
      needsVision: false,
      parserUsed: 'parseUpdXlsx',
      signals: [signal],
    };
  }

  // ── Изображения: текстового слоя нет → vision (Этап 4) ──
  if (IMAGE_RE.test(lower) || /^image\//.test(m)) {
    if (M15_NAME_RE.test(lower)) return m15ByName(['image', 'name:m15']);
    return {
      detectedKind: 'unknown',
      confidence: 0,
      needsVision: true,
      parserUsed: 'none',
      signals: ['image'],
    };
  }

  // ── PDF: пробуем текстовый слой ──
  if (/pdf/.test(m) || PDF_RE.test(lower)) {
    let pages: { num: number; text: string }[];
    let full: string;
    try {
      ({ pages, full } = await extractPdfText(buffer));
    } catch (err) {
      // pdf-parse падает на битых/защищённых/нестандартных PDF. Это НЕ повод
      // ронять весь router-job (иначе пакет уйдёт в retry с backoff 60с и
      // «зависнет» на одном файле). Деградируем в vision-доклассификацию.
      if (M15_NAME_RE.test(lower)) return m15ByName(['pdf:parse_error', 'name:m15']);
      return {
        detectedKind: 'unknown',
        confidence: 0,
        needsVision: true,
        parserUsed: 'none',
        signals: ['pdf:parse_error', err instanceof Error ? err.message.slice(0, 80) : 'unknown'],
      };
    }
    // УПД-маркер проверяем ДО порога: он решает приоритет и ниже, и в ветке
    // короткого текста — сертификат не должен перехватить документ, в котором
    // есть «счёт-фактура».
    const hasUpd = /сч[её]т-фактур|универсальный передаточн/i.test(full);

    if (full.length < MIN_TEXT) {
      // скан без текста — vision
      if (M15_NAME_RE.test(lower))
        return m15ByName(['pdf:scan', 'name:m15', `textLen:${full.length}`]);
      // У сертификата текстовый слой часто короткий: пара строк заголовка и
      // номера. Без этой ветки он ушёл бы в vision — то есть в лишний вызов
      // модели ради файла, который распознавать не нужно.
      if (!hasUpd && SUPPLEMENTARY_RE.test(full)) {
        return {
          detectedKind: 'supplementary',
          confidence: 0.9,
          needsVision: false,
          parserUsed: 'none',
          signals: ['pdf:scan', 'text:supplementary', `textLen:${full.length}`],
        };
      }
      return {
        detectedKind: 'unknown',
        confidence: 0,
        needsVision: true,
        parserUsed: 'none',
        signals: ['pdf:scan', `textLen:${full.length}`],
      };
    }
    // УПД имеет ПРИОРИТЕТ: «Счёт-фактура»/«Универсальный передаточный» — даже
    // если в теле упоминается транспортная накладная (раздел «Данные о
    // транспортировке»). Иначе УПД-пачки ложно ушли бы в накладные.
    if (hasUpd) {
      const uniq = countUniqueUpdInvoices(pages);
      return {
        detectedKind: 'upd',
        confidence: 0.95,
        needsVision: false,
        parserUsed: uniq >= 2 ? 'tryParseTextUpdBundle' : 'parseUpdPdf',
        signals: ['text:upd', `invoices:${uniq}`],
        updInvoiceCount: uniq,
      };
    }
    // М-15 (накладная на отпуск материалов) — роутер направит в отдельную
    // ветку и распознает своим vision-промптом m15 (надёжнее текстового парса:
    // у М-15-PDF из 1С текстовый слой часто «битый»).
    if (
      /типовая\s+межотраслевая\s+форма\s+№?\s*м-?15|на отпуск материалов на сторону/i.test(full)
    ) {
      return {
        detectedKind: 'm15',
        confidence: 0.7,
        needsVision: false,
        parserUsed: 'none',
        signals: ['text:m15'],
      };
    }
    if (
      /внутреннее перемещение объектов основных средств|унифицированн\w*\s+форм\w*\s+№?\s*ос-?2/i.test(
        full,
      )
    ) {
      return {
        detectedKind: 'os2_transfer',
        confidence: 0.8,
        needsVision: false,
        parserUsed: 'parseWaybillBatch',
        signals: ['text:os2'],
      };
    }
    // ТОРГ-12 — товарный документ с позициями. Направляем его в общий
    // УПД-путь, а не в waybill-промпт, который по контракту понимает только
    // ТН-2116 и ОС-2. Проверка стоит перед ТН: у товарной накладной тоже есть
    // графа «Грузоотправитель».
    if (TORG12_RE.test(full) && !isTransportWaybillText(full)) {
      return {
        detectedKind: 'upd',
        confidence: 0.9,
        needsVision: false,
        parserUsed: 'parseUpdPdf',
        signals: ['text:torg12'],
      };
    }
    if (isTransportWaybillText(full)) {
      return {
        detectedKind: 'transport_waybill',
        confidence: 0.8,
        needsVision: false,
        parserUsed: 'parseWaybillBatch',
        signals: ['text:tn'],
      };
    }
    // Сопроводительный документ качества. Проверяется ПОСЛЕ всех известных
    // форм: так ветка ловит ровно то, что раньше уходило в unknown, и не может
    // перехватить УПД, М-15, ОС-2 или ТН, где сертификат лишь упомянут.
    if (SUPPLEMENTARY_RE.test(full)) {
      return {
        detectedKind: 'supplementary',
        confidence: 0.9,
        needsVision: false,
        parserUsed: 'none',
        signals: ['text:supplementary'],
      };
    }
    // текст есть, но тип неясен. М-15 с «битым» текстовым слоем (нечитаемые
    // глифы 1С) сюда и попадает — ловим по имени файла.
    if (M15_NAME_RE.test(lower)) return m15ByName(['text:ambiguous', 'name:m15']);
    // иначе — пусть vision доклассифицирует (Этап 4)
    return {
      detectedKind: 'unknown',
      confidence: 0.3,
      needsVision: true,
      parserUsed: 'none',
      signals: ['text:ambiguous'],
    };
  }

  // ── неизвестный mime/расширение ──
  return {
    detectedKind: 'unknown',
    confidence: 0,
    needsVision: true,
    parserUsed: 'none',
    signals: [`mime:${m || 'unknown'}`],
  };
}
