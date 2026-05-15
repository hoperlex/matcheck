import { z } from 'zod';
import { db } from '../../db/client.js';
import { llmCalls } from '../../db/schema.js';
import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from './provider.js';

// Ограничение по размеру одного сообщения в логах LLM-вызовов. Чистый текст
// УПД редко превышает 100 КБ; 200 КБ — запас на случай больших документов,
// но при этом таблица llm_calls не разрастается катастрофически.
const MAX_MESSAGE_BYTES = 200_000;

export type LoggedCompleteContext = {
  sourceDocumentId: string | null;
  docKind: string;
  promptId: string | null;
};

function truncateMessages(messages: LlmCompletionRequest['messages']) {
  return messages.map((m) => {
    if (m.content.length <= MAX_MESSAGE_BYTES) return m;
    return {
      ...m,
      content: `${m.content.slice(0, MAX_MESSAGE_BYTES)}…[обрезано до ${MAX_MESSAGE_BYTES} байт]`,
    };
  });
}

/**
 * Прозрачная обёртка над provider.complete, которая дополнительно сохраняет
 * запрос и ответ в таблицу llm_calls. Используется в воркере распознавания
 * УПД: при ошибках LLM (перепутанные колонки, null в volumeM3 и т.п.)
 * админ может через UI открыть журнал и увидеть, что именно вернула модель.
 */
export async function loggedComplete<T>(
  provider: LlmProvider,
  req: LlmCompletionRequest,
  schema: z.ZodType<T>,
  ctx: LoggedCompleteContext,
): Promise<LlmCompletionResult<T>> {
  const startedAt = Date.now();
  let result: LlmCompletionResult<T> | null = null;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  let rawForLog: string | null = null;
  try {
    result = await provider.complete(req, schema);
    rawForLog = result.raw;
    return result;
  } catch (err) {
    errorCode = err instanceof z.ZodError ? 'zod_failed' : 'provider_error';
    errorMessage = err instanceof Error ? err.message : String(err);
    // Провайдер мог получить raw до падения JSON.parse — провайдеры
    // прокидывают его через rawResponse, чтобы он попал в журнал.
    const maybeRaw = (err as { rawResponse?: unknown })?.rawResponse;
    if (typeof maybeRaw === 'string') rawForLog = maybeRaw;
    throw err;
  } finally {
    const latencyMs = Date.now() - startedAt;
    try {
      await db.insert(llmCalls).values({
        sourceDocumentId: ctx.sourceDocumentId,
        providerId: provider.id,
        promptId: ctx.promptId,
        docKind: ctx.docKind,
        model: provider.model,
        requestMessages: truncateMessages(req.messages),
        requestSchema: (req.jsonSchema ?? null) as object | null,
        responseRaw: rawForLog,
        responseParsed: result ? (result.data as unknown as object) : null,
        promptTokens: result?.promptTokens ?? null,
        completionTokens: result?.completionTokens ?? null,
        latencyMs,
        errorCode,
        errorMessage,
      });
    } catch {
      // Лог LLM-вызовов — не критичен; ошибки записи в журнал не должны
      // ломать основной флоу распознавания.
    }
  }
}
