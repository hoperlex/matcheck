import { PDFParse } from 'pdf-parse';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { loadActiveProvidersOrdered } from '../llm/registry.js';
import { loadActivePromptWithMeta } from '../prompts/registry.js';
import { loggedComplete } from '../llm/logged-complete.js';

const MIN_TEXT_LENGTH = 200;

export class PdfNoTextError extends Error {
  constructor(public textLength: number) {
    super('PDF has no extractable text (likely a scan)');
    this.name = 'PdfNoTextError';
  }
}

// Кидается когда pdf-parse вернул >MIN_TEXT_LENGTH символов, но текст
// похож на OCR-артефакты, а не на нормальный УПД. Worker'у это сигнал
// сразу делать fallback на Vision, не тратя токены на мусор в text-LLM.
// До добавления этой ошибки сканированные PDF с «мусорным» text-layer
// уходили в text-LLM, который возвращал {items:[], confidence:0.1} —
// документ зависал в partial_parse без каких-либо распознанных полей.
export class PdfTextGarbageError extends Error {
  constructor(
    public textLength: number,
    public reason: string,
  ) {
    super(`PDF text looks like OCR garbage: ${reason}`);
    this.name = 'PdfTextGarbageError';
  }
}

// Эвристика: текст из pdf-parse похож на нормальный УПД или это
// OCR-артефакты со скана? Чек дешёвый (без LLM), запускается перед
// отправкой в text-LLM. Возвращает причину если текст похож на мусор.
//
// Критерии (любой из):
//   1) Нет ни одного ключевого слова УПД (счёт-фактура / продавец /
//      покупатель / ИНН / товар / Всего / накладная). Нормальный УПД
//      содержит как минимум 2-3 из этих слов.
//   2) Доля «странных» символов (не буквы/цифры/знаки препинания/пробелы)
//      превышает 25%. У OCR-мусора такие символы зашкаливают: ý, Ё,
//      ffi, l=l, ╪ и т.п.
//   3) Средняя длина «слова» (последовательности букв) меньше 2.5 —
//      признак того, что распознавание разбило слова на 1-символьные
//      фрагменты.
//
// Возвращает null если текст ОК, или строку с причиной если мусор.
export function checkPdfTextQuality(cleanText: string): string | null {
  if (cleanText.length < MIN_TEXT_LENGTH) return null; // отдельная ветка
  const lower = cleanText.toLowerCase();
  // Ключевые слова УПД (русский + латинизированные варианты).
  const upgKeywords = [
    'счет-фактур',
    'счёт-фактур',
    'универсальн',
    'передаточн',
    'продавец',
    'покупател',
    'грузоотправ',
    'грузополуч',
    'инн',
    'кпп',
    'товар',
    'всего к оплате',
    'наименование',
    'количеств',
    'налоговая ставка',
    'накладная',
    'договор',
  ];
  const hasKeywordCount = upgKeywords.filter((k) => lower.includes(k)).length;
  if (hasKeywordCount < 2) {
    return `no_upd_keywords (found ${hasKeywordCount}/2 minimum)`;
  }
  // Доля «странных» символов.
  // Считаем нормальными: кириллицу, латиницу, цифры, пробелы, переводы
  // строк, знаки препинания и распространённые скобки/единицы измерения.
  const NORMAL_CHARS = /[a-zA-Zа-яА-ЯёЁ0-9\s.,;:!?()[\]{}"'/\\\-—–_+=%№*<>«»°²³%§®©™]/;
  let strangeCount = 0;
  for (const ch of cleanText) {
    if (!NORMAL_CHARS.test(ch)) strangeCount += 1;
  }
  const strangeRatio = strangeCount / cleanText.length;
  if (strangeRatio > 0.25) {
    return `strange_chars_ratio ${(strangeRatio * 100).toFixed(1)}%`;
  }
  // Средняя длина «слова» (буква-последовательность).
  const words = cleanText.match(/[a-zA-Zа-яА-ЯёЁ]+/g) ?? [];
  if (words.length > 0) {
    const avgWordLen =
      words.reduce((s, w) => s + w.length, 0) / words.length;
    if (avgWordLen < 2.5) {
      return `avg_word_length ${avgWordLen.toFixed(2)} < 2.5`;
    }
  }
  return null;
}

// JSON-схема ответа LLM. vatRate/vatSum по позициям нужны веб-порталу
// (колонка «Сумма НДС» в материалах приёмки), модель извлекает их
// промптом v5+. На уровне шапки vatSum тоже сохранён.
const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  required: ['items', 'confidence'],
  properties: {
    docNumber: { type: ['string', 'null'] },
    docDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalSum: { type: ['number', 'null'] },
    vatSum: { type: ['number', 'null'] },
    itemsCount: {
      type: ['integer', 'null'],
      description:
        'Значение из строки УПД «Всего наименований», «Количество позиций» — целое число строк таблицы товаров.',
    },
    supplier: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        kpp: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    recipient: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        kpp: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nameRaw'],
        properties: {
          nameRaw: { type: 'string' },
          // qty/unit допускают null: строки-услуги (доставка и т.п.) идут без
          // количества и единицы (прочерки в графах 3/2а формы УПД).
          qty: {
            type: ['number', 'null'],
            description:
              'Количество (колонка 6 формы УПД). НЕ путать с кодом товара или кодом ОКЕИ (796/006/166 и т.п.). null для строк-услуг без количества.',
          },
          unit: {
            type: ['string', 'null'],
            description: 'Единица измерения текстом. null для строк-услуг без единицы.',
          },
          price: {
            type: ['number', 'null'],
            description:
              'Цена за единицу БЕЗ НДС — графа 4 формы УПД «Цена (тариф) за единицу измерения». Берётся как есть; НЕ деление sum/qty.',
          },
          sum: {
            type: ['number', 'null'],
            description:
              'Стоимость С НАЛОГОМ — всего по строке (графа 9 формы УПД, ПП №1137). НЕ путать с графой 5 «Стоимость без налога».',
          },
          vatRate: {
            type: ['number', 'null'],
            description:
              'Налоговая ставка по строке в процентах: 20, 10, 0. null — если в строке «Без НДС» / прочерк.',
          },
          vatSum: {
            type: ['number', 'null'],
            description:
              'Сумма налога (НДС) по строке в рублях. Отдельная колонка формы УПД «Сумма налога, предъявляемая покупателю», НЕ путать с sum.',
          },
          volumeM3: {
            type: ['number', 'null'],
            description: 'Объём ОДНОЙ единицы товара в м³. null только если совсем нет данных.',
          },
          massKg: {
            type: ['number', 'null'],
            description: 'Масса ОДНОЙ единицы в кг с упаковкой',
          },
          volumeConfidence: {
            type: ['string', 'null'],
            enum: ['low', 'medium', 'high', null],
            description: 'Уверенность в оценке объёма/массы',
          },
          groupName: {
            type: ['string', 'null'],
            description: 'Семантическая группа позиции (Воздуховоды/Бетон/Кабель/...)',
          },
        },
      },
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description:
        'Оценка качества распознавания. ОБЯЗАТЕЛЬНО заполнять. Шкала: 0.9–1.0 — всё распозналось чётко, qty × price ≈ sum для всех строк, шапочные реквизиты на месте; 0.7–0.9 — мелкие округления (qty × price расходится с sum в пределах рубля); 0.4–0.7 — есть сомнительные строки или подозрение на перепутанные колонки; 0.0–0.4 — серьёзные проблемы (часть таблицы не распознана, нет шапки).',
    },
  },
};

export type ParsePdfResult = {
  parsed: UpdPdfParsed;
  textLength: number;
  llmProviderId: string | null;
};

// Извлечение текста из PDF + распознавание через LLM. Вызывается из воркера
// asynchronous-очереди (см. apps/api/src/worker.ts) и должен быть устойчив
// к долгим LLM-вызовам (5–10 минут на тяжёлых документах).
export async function parseUpdPdf(
  buffer: Buffer,
  ctx: { sourceDocumentId: string | null } = { sourceDocumentId: null },
): Promise<ParsePdfResult> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text = '';
  try {
    const result = await parser.getText();
    text = result.text;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (cleanText.length < MIN_TEXT_LENGTH) {
    throw new PdfNoTextError(cleanText.length);
  }
  // Дополнительная проверка качества текста — отлавливаем OCR-мусор,
  // который прошёл порог MIN_TEXT_LENGTH (200+ символов), но не похож
  // на УПД. Если мусор — кидаем PdfTextGarbageError, worker сразу
  // делает Vision-fallback без бесполезного text-LLM вызова.
  const garbageReason = checkPdfTextQuality(cleanText);
  if (garbageReason) {
    throw new PdfTextGarbageError(cleanText.length, garbageReason);
  }

  const { parsed, llmProviderId } = await extractUpdFromText(cleanText, ctx);
  return {
    parsed,
    textLength: cleanText.length,
    llmProviderId,
  };
}

/**
 * Извлечение УПД из готового текстового слоя через text-LLM. Вынесено из
 * parseUpdPdf, чтобы переиспользовать в text multi-UPD bundle
 * (upd-text-bundle.parser.ts): там каждый сегмент-блок одного УПД проходит
 * ровно этот же вызов. parseUpdPdf остаётся владельцем pdf-parse и проверок
 * качества текста (PdfNoTextError / PdfTextGarbageError) и делегирует сюда
 * только финальный LLM-вызов — поведение одиночного пути не меняется.
 */
export async function extractUpdFromText(
  cleanText: string,
  ctx: { sourceDocumentId: string | null } = { sourceDocumentId: null },
): Promise<{ parsed: UpdPdfParsed; llmProviderId: string | null }> {
  const [providers, prompt] = await Promise.all([
    loadActiveProvidersOrdered(),
    loadActivePromptWithMeta('upd'),
  ]);
  if (providers.length === 0) {
    throw new Error('Нет активных LLM-провайдеров для распознавания УПД');
  }
  // Fallback-цепочка: default-провайдер первым, при его сбое (пустой ответ /
  // упор в max_tokens / ошибка) — следующий включённый. Каждую попытку логирует
  // loggedComplete (запись в llm_calls с errorCode), поэтому в журнале видно,
  // какая модель и почему упала. Успешная первая попытка = прежнее поведение.
  let lastErr: unknown = null;
  for (const provider of providers) {
    try {
      const result = await loggedComplete(
        provider,
        {
          messages: [
            { role: 'system', content: prompt.content },
            { role: 'user', content: cleanText.slice(0, 100_000) },
          ],
          jsonSchema: RESPONSE_JSON_SCHEMA,
        },
        UpdPdfParsedSchema,
        {
          sourceDocumentId: ctx.sourceDocumentId,
          docKind: 'upd',
          promptId: prompt.id,
        },
      );
      return {
        parsed: result.data as UpdPdfParsed,
        llmProviderId: provider.id,
      };
    } catch (err) {
      lastErr = err;
      // пробуем следующий включённый провайдер (резервная модель)
    }
  }
  throw lastErr ?? new Error('Все LLM-провайдеры не смогли распознать УПД');
}
