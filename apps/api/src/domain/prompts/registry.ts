import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { prompts } from '../../db/schema.js';
import type { PromptDocKind } from '@matcheck/contracts';

const CACHE_TTL_MS = 60_000;

export type ActivePrompt = { id: string; content: string };

type CacheEntry = ActivePrompt & { loadedAt: number };
const cache = new Map<PromptDocKind, CacheEntry>();

export function invalidatePromptCache(docKind?: PromptDocKind): void {
  if (docKind) cache.delete(docKind);
  else cache.clear();
}

export async function loadActivePromptWithMeta(docKind: PromptDocKind): Promise<ActivePrompt> {
  const cached = cache.get(docKind);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return { id: cached.id, content: cached.content };
  }
  const [row] = await db
    .select({ id: prompts.id, content: prompts.content })
    .from(prompts)
    .where(and(eq(prompts.docKind, docKind), eq(prompts.isActive, true)))
    .limit(1);
  if (!row) {
    throw new Error(`Активный промпт для doc_kind=${docKind} не найден`);
  }
  cache.set(docKind, { id: row.id, content: row.content, loadedAt: Date.now() });
  return { id: row.id, content: row.content };
}

export async function loadActivePrompt(docKind: PromptDocKind): Promise<string> {
  const p = await loadActivePromptWithMeta(docKind);
  return p.content;
}

/**
 * Промпт и температура, заданные в обход БД.
 *
 * Нужны ровно одному потребителю — scripts/upd-prompt-ab.ts, который гоняет
 * две версии промпта по корпусу и сравнивает результат. Без этого сверить
 * новую версию можно было бы только сделав её активной, то есть на проде.
 *
 * Боевые пути override не передают: undefined = прежнее поведение (активный
 * промпт из БД, температура из настроек провайдера).
 */
export type PromptOverride = { prompt?: ActivePrompt; temperature?: number };

export async function resolvePrompt(
  docKind: PromptDocKind,
  override?: PromptOverride,
): Promise<ActivePrompt> {
  return override?.prompt ?? (await loadActivePromptWithMeta(docKind));
}
