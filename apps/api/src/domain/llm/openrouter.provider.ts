import type { z } from 'zod';
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
  LlmProviderConfig,
} from './provider.js';

export class OpenRouterProvider implements LlmProvider {
  readonly kind = 'openrouter' as const;
  readonly id: string;
  readonly model: string;
  constructor(private readonly cfg: LlmProviderConfig) {
    this.id = cfg.id;
    this.model = cfg.model;
  }

  async complete<T>(
    req: LlmCompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<LlmCompletionResult<T>> {
    const body = {
      model: this.cfg.model,
      messages: req.messages,
      temperature: req.temperature ?? this.cfg.temperature,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
      ...(req.jsonSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'response', strict: true, schema: req.jsonSchema },
            },
          }
        : { response_format: { type: 'json_object' as const } }),
    };
    const res = await fetch(`${this.cfg.apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'matcheck',
      },
      body: JSON.stringify(body),
      // Потолок ожидания, не задержка: тяжёлые УПД-PDF с 50+ позициями требуют больше времени.
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    // ВАЖНО: `?.` ставим ПЕРЕД [0]. Иначе при ответе без `choices` (пустой
    // ответ модели, ошибка провайдера, reasoning-модель исчерпала max_tokens
    // на «мысли» и не выдала контент) `json.choices[0]` падал с
    // «Cannot read properties of undefined (reading '0')» → весь документ
    // уходил в internal_error вместо понятной ошибки/ретрая.
    const choice = json.choices?.[0];
    const raw = choice?.message?.content ?? '';
    if (!raw) {
      const finish = choice?.finish_reason;
      throw new Error(
        `OpenRouter: пустой ответ модели${finish ? ` (finish_reason=${finish})` : ''} — ` +
          `модель не вернула контент (вероятно, reasoning-модель исчерпала ` +
          `max_tokens=${body.max_tokens} на размышления; смените модель или поднимите лимит)`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Прокидываем raw через свойство ошибки, чтобы logged-complete сохранил
      // сырой ответ в llm_calls.response_raw — без этого админ не увидит,
      // на каком месте оборвался JSON (типичный симптом упора в max_tokens).
      const e = err instanceof Error ? err : new Error(String(err));
      (e as Error & { rawResponse?: string }).rawResponse = raw;
      e.message = `OpenRouter: JSON.parse failed (likely truncated by max_tokens=${body.max_tokens}): ${e.message}`;
      throw e;
    }
    const data = schema.parse(parsed);
    return {
      data,
      raw,
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
    };
  }

  async testConnection(): Promise<{ ok: boolean; output?: string; error?: string }> {
    try {
      const res = await fetch(`${this.cfg.apiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
          max_tokens: 16,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok)
        return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return { ok: true, output: j.choices?.[0]?.message?.content ?? '' };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
