import type { z } from 'zod';
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
  LlmProviderConfig,
} from './provider.js';

export class OpenRouterProvider implements LlmProvider {
  readonly kind = 'openrouter' as const;
  constructor(private readonly cfg: LlmProviderConfig) {}

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
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const raw = json.choices[0]?.message?.content ?? '';
    if (!raw) throw new Error('OpenRouter: empty completion content');
    const data = schema.parse(JSON.parse(raw));
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
      const j = (await res.json()) as { choices: { message: { content: string } }[] };
      return { ok: true, output: j.choices[0]?.message?.content ?? '' };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
