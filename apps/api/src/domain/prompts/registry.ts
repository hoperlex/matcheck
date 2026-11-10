import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { prompts } from '../../db/schema.js';
import type { PromptDocKind } from '@matcheck/contracts';

const CACHE_TTL_MS = 60_000;

export type ActivePrompt = { id: string; content: string };

type CacheEntry = ActivePrompt & { loadedAt: number };
const cache = new Map<PromptDocKind, CacheEntry>();
/** Кэш промптов по имени (loadPromptByName), ключ — «doc_kind + имя». */
const byNameCache = new Map<string, CacheEntry>();

export function invalidatePromptCache(docKind?: PromptDocKind): void {
  if (docKind) cache.delete(docKind);
  else cache.clear();
  // Правка любого промпта через админку сбрасывает и кэш «по имени»: текст
  // версии мог измениться, а ключ (имя) остался прежним.
  byNameCache.clear();
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
 * Промпт по ИМЕНИ, без учёта активности.
 *
 * Нужен узкому разбору ТОРГ-12 (TORG12_PROMPT): накладные поставщиков из
 * списка переразбираются версией с разделом ТОРГ-12, а активным для всех
 * остальных остаётся прежний промпт. Тот же кэш на 60 с, что у активного, —
 * правка текста через админку доходит до воркера так же быстро.
 */
export async function loadPromptByName(
  docKind: PromptDocKind,
  name: string,
): Promise<ActivePrompt> {
  const key = `${docKind}\u0000${name}`;
  const cached = byNameCache.get(key);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return { id: cached.id, content: cached.content };
  }
  const [row] = await db
    .select({ id: prompts.id, content: prompts.content })
    .from(prompts)
    .where(and(eq(prompts.docKind, docKind), eq(prompts.name, name)))
    .limit(1);
  if (!row) {
    throw new Error(`Промпт «${name}» для doc_kind=${docKind} не найден`);
  }
  byNameCache.set(key, { id: row.id, content: row.content, loadedAt: Date.now() });
  return { id: row.id, content: row.content };
}

/**
 * Промпт и температура, заданные в обход БД.
 *
 * Потребители:
 *   * scripts/upd-prompt-ab.ts — гоняет две версии промпта по корпусу и
 *     сравнивает результат, не делая новую версию активной;
 *   * воркер, узкий разбор ТОРГ-12 (TORG12_PROMPT) — переразбирает версией с
 *     разделом ТОРГ-12 ТОЛЬКО накладные поставщиков из списка.
 *
 * Все остальные боевые пути override не передают: undefined = прежнее
 * поведение (активный промпт из БД, температура из настроек провайдера).
 */
export type PromptOverride = { prompt?: ActivePrompt; temperature?: number };

export async function resolvePrompt(
  docKind: PromptDocKind,
  override?: PromptOverride,
): Promise<ActivePrompt> {
  return override?.prompt ?? (await loadActivePromptWithMeta(docKind));
}
