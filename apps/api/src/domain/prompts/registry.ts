import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { prompts } from '../../db/schema.js';
import type { PromptDocKind } from '@matcheck/contracts';

const CACHE_TTL_MS = 60_000;

type CacheEntry = { content: string; loadedAt: number };
const cache = new Map<PromptDocKind, CacheEntry>();

export function invalidatePromptCache(docKind?: PromptDocKind): void {
  if (docKind) cache.delete(docKind);
  else cache.clear();
}

export async function loadActivePrompt(docKind: PromptDocKind): Promise<string> {
  const cached = cache.get(docKind);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.content;
  }
  const [row] = await db
    .select({ content: prompts.content })
    .from(prompts)
    .where(and(eq(prompts.docKind, docKind), eq(prompts.isActive, true)))
    .limit(1);
  if (!row) {
    throw new Error(`Активный промпт для doc_kind=${docKind} не найден`);
  }
  cache.set(docKind, { content: row.content, loadedAt: Date.now() });
  return row.content;
}
