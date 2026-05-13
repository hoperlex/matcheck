import { PDFParse } from 'pdf-parse';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { loadDefaultProvider } from '../llm/registry.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { llmProviders } from '../../db/schema.js';

const MIN_TEXT_LENGTH = 200;

export class PdfNoTextError extends Error {
  constructor(public textLength: number) {
    super('PDF has no extractable text (likely a scan)');
    this.name = 'PdfNoTextError';
  }
}

const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  required: ['items'],
  properties: {
    docNumber: { type: ['string', 'null'] },
    docDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalSum: { type: ['number', 'null'] },
    vatSum: { type: ['number', 'null'] },
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
          qty: { type: 'number' },
          unit: { type: 'string' },
          price: { type: ['number', 'null'] },
          sum: { type: ['number', 'null'] },
          vatRate: { type: ['number', 'null'] },
          vatSum: { type: ['number', 'null'] },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const SYSTEM_PROMPT = `Ты извлекаешь данные из текста российского УПД (универсального передаточного документа), полученного через распознавание PDF.

Главный приоритет — таблица позиций: для каждой строки извлеки nameRaw (наименование материала/товара/услуги как есть), qty (количество, число), unit (единица измерения), price (цена за единицу), sum (стоимость без НДС или с НДС).

Второстепенно — заголовок документа: docNumber, docDate (YYYY-MM-DD), totalSum, vatSum, реквизиты supplier и recipient (ИНН, КПП, название).

Правила:
- Числа без пробелов как разделителей тысяч (12500 вместо "12 500").
- Запятая в числах = десятичный разделитель (2,5 → 2.5).
- Если поле не нашёл — null. Не выдумывай данные.
- Игнорируй итоговые строки таблицы («Итого», «Всего», «Сумма НДС»).
- Если разбор сомнителен (плохое OCR-качество, неполные данные) — confidence < 0.7.

Отвечай ТОЛЬКО валидным JSON по предоставленной схеме.`;

export type ParsePdfResult = {
  parsed: UpdPdfParsed;
  textLength: number;
  llmProviderId: string | null;
};

export async function parseUpdPdf(buffer: Buffer): Promise<ParsePdfResult> {
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

  const provider = await loadDefaultProvider();
  const result = await provider.complete(
    {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: cleanText.slice(0, 100_000) },
      ],
      jsonSchema: RESPONSE_JSON_SCHEMA,
    },
    UpdPdfParsedSchema,
  );

  const [defaultProvider] = await db
    .select({ id: llmProviders.id })
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);

  return {
    parsed: result.data as UpdPdfParsed,
    textLength: cleanText.length,
    llmProviderId: defaultProvider?.id ?? null,
  };
}
