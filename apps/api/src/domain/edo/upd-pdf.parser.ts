import { PDFParse } from 'pdf-parse';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { loadDefaultProvider } from '../llm/registry.js';
import { loadActivePromptWithMeta } from '../prompts/registry.js';
import { loggedComplete } from '../llm/logged-complete.js';

const MIN_TEXT_LENGTH = 200;

export class PdfNoTextError extends Error {
  constructor(public textLength: number) {
    super('PDF has no extractable text (likely a scan)');
    this.name = 'PdfNoTextError';
  }
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
        required: ['nameRaw', 'qty', 'unit'],
        properties: {
          nameRaw: { type: 'string' },
          qty: {
            type: 'number',
            description:
              'Количество (колонка 6 формы УПД). НЕ путать с кодом товара или кодом ОКЕИ (796/006/166 и т.п.).',
          },
          unit: { type: 'string', description: 'Единица измерения текстом' },
          price: { type: ['number', 'null'], description: 'Цена за единицу' },
          sum: { type: ['number', 'null'], description: 'Стоимость по строке (без НДС или с НДС)' },
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

  const [provider, prompt] = await Promise.all([
    loadDefaultProvider(),
    loadActivePromptWithMeta('upd'),
  ]);
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
    textLength: cleanText.length,
    llmProviderId: provider.id,
  };
}
