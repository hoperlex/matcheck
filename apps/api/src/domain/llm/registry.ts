import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import { OpenRouterProvider } from './openrouter.provider.js';
import { GoogleAiStudioProvider } from './google-ai-studio.provider.js';
import type { LlmProvider, LlmProviderConfig } from './provider.js';

export async function loadProviderById(id: string): Promise<LlmProvider> {
  const [row] = await db.select().from(llmProviders).where(eq(llmProviders.id, id)).limit(1);
  if (!row) throw new Error(`LLM provider ${id} not found`);
  return buildProviderFromRow(row);
}

// Лёгкая проба: kind default-провайдера без расшифровки ключей и без throw,
// если ключ не задан. Нужна worker'у, чтобы решить, конвертировать ли PDF
// накладной в PNG (OpenRouter не принимает PDF — см. waybill-pdf.ts).
export async function getDefaultProviderKind(): Promise<string | null> {
  const [row] = await db
    .select({ kind: llmProviders.kind })
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  return row?.kind ?? null;
}

export async function loadDefaultProvider(): Promise<LlmProvider> {
  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!row) throw new Error('No default LLM provider configured');
  return buildProviderFromRow(row);
}

export async function buildProviderFromRow(
  row: typeof llmProviders.$inferSelect,
): Promise<LlmProvider> {
  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, row.kind))
    .limit(1);
  if (!cred) {
    throw new Error(
      `No API key configured for provider kind "${row.kind}". Задайте ключ в админке через «Ключи провайдеров».`,
    );
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );
  const cfg: LlmProviderConfig = {
    id: row.id,
    kind: row.kind,
    apiBaseUrl: cred.apiBaseUrl,
    model: row.model,
    apiKey,
    temperature: Number(row.temperature),
    maxTokens: row.maxTokens,
  };
  switch (row.kind) {
    case 'openrouter':
      return new OpenRouterProvider(cfg);
    case 'google_ai_studio':
      return new GoogleAiStudioProvider(cfg);
    default:
      throw new Error(`LLM kind ${row.kind} is not implemented yet`);
  }
}
