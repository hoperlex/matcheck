import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { llmProviders } from '../../db/schema.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import { OpenRouterProvider } from './openrouter.provider.js';
import { GoogleAiStudioProvider } from './google-ai-studio.provider.js';
import type { LlmProvider, LlmProviderConfig } from './provider.js';

export async function loadProviderById(id: string): Promise<LlmProvider> {
  const [row] = await db.select().from(llmProviders).where(eq(llmProviders.id, id)).limit(1);
  if (!row) throw new Error(`LLM provider ${id} not found`);
  return buildProviderFromRow(row);
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

export function buildProviderFromRow(row: typeof llmProviders.$inferSelect): LlmProvider {
  const apiKey = decryptField(row.apiKeyEncrypted, buildAad('llm_providers', row.id));
  const cfg: LlmProviderConfig = {
    id: row.id,
    kind: row.kind,
    apiBaseUrl: row.apiBaseUrl,
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
