import { z } from 'zod';
import { loadDefaultProvider } from '../llm/registry.js';
import { loadActivePrompt } from '../prompts/registry.js';
import { extractToMarkdown } from './extractors.js';

export const ParsedRequestSchema = z.object({
  supplier: z
    .object({
      inn: z.string().optional(),
      kpp: z.string().nullable().optional(),
      name: z.string().optional(),
    })
    .optional(),
  docNumber: z.string().nullable().optional(),
  docDate: z.string().nullable().optional(),
  expectedDate: z.string().nullable().optional(),
  items: z.array(
    z.object({
      nameRaw: z.string(),
      qty: z.number(),
      unit: z.string().catch('шт'),
      price: z.number().nullable().optional(),
      expectedDate: z.string().nullable().optional(),
    }),
  ),
  confidence: z.number().min(0).max(1).optional(),
});
export type ParsedRequest = z.infer<typeof ParsedRequestSchema>;

const responseJsonSchema = {
  type: 'object',
  properties: {
    supplier: {
      type: 'object',
      properties: {
        inn: { type: 'string' },
        kpp: { type: ['string', 'null'] },
        name: { type: 'string' },
      },
    },
    docNumber: { type: ['string', 'null'] },
    docDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    expectedDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
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
          expectedDate: { type: ['string', 'null'] },
        },
      },
    },
    confidence: { type: 'number' },
  },
  required: ['items'],
};

export type ParseInput = {
  emailBody: string;
  attachments: { filename: string; mimeType: string; buffer: Buffer }[];
};

export type ParseOutput = {
  data: ParsedRequest;
  providerId: string;
  rawPrompt: string;
};

export async function parseRequestFromMail(input: ParseInput): Promise<ParseOutput> {
  const [provider, systemPrompt] = await Promise.all([
    loadDefaultProvider(),
    loadActivePrompt('request'),
  ]);

  const parts: string[] = [];
  if (input.emailBody.trim()) {
    parts.push(`### Email body\n\n${input.emailBody.trim().slice(0, 20_000)}`);
  }
  for (const att of input.attachments) {
    try {
      const extracted = await extractToMarkdown(att.buffer, att.filename || att.mimeType);
      parts.push(
        `### Attachment: ${att.filename} (${extracted.format})\n\n${extracted.markdown.slice(0, 50_000)}`,
      );
    } catch (err) {
      parts.push(`### Attachment ${att.filename}: extraction failed (${(err as Error).message})`);
    }
  }
  const userContent = parts.join('\n\n---\n\n');
  const rawPrompt = userContent.slice(0, 200_000);

  const result = await provider.complete(
    {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: rawPrompt },
      ],
      jsonSchema: responseJsonSchema,
    },
    ParsedRequestSchema,
  );
  return {
    data: result.data as ParsedRequest,
    providerId: '',
    rawPrompt,
  };
}
