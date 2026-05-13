import type { z } from 'zod';
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
  LlmProviderConfig,
} from './provider.js';

export class GoogleAiStudioProvider implements LlmProvider {
  readonly kind = 'google_ai_studio' as const;
  constructor(private readonly cfg: LlmProviderConfig) {}

  private url(path: string): string {
    const base = this.cfg.apiBaseUrl.replace(/\/$/, '');
    return `${base}${path}?key=${encodeURIComponent(this.cfg.apiKey)}`;
  }

  async complete<T>(
    req: LlmCompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<LlmCompletionResult<T>> {
    const systemMsg = req.messages.find((m) => m.role === 'system');
    const userMsgs = req.messages.filter((m) => m.role !== 'system');
    const body: Record<string, unknown> = {
      ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg.content }] } } : {}),
      contents: userMsgs.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature: req.temperature ?? this.cfg.temperature,
        maxOutputTokens: req.maxTokens ?? this.cfg.maxTokens,
        responseMimeType: 'application/json',
        ...(req.jsonSchema ? { responseSchema: req.jsonSchema } : {}),
      },
    };
    const res = await fetch(this.url(`/v1beta/models/${this.cfg.model}:generateContent`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google AI Studio HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!raw) throw new Error('Google AI Studio: empty content');
    const data = schema.parse(JSON.parse(raw));
    return {
      data,
      raw,
      promptTokens: json.usageMetadata?.promptTokenCount,
      completionTokens: json.usageMetadata?.candidatesTokenCount,
    };
  }

  async testConnection(): Promise<{ ok: boolean; output?: string; error?: string }> {
    try {
      const res = await fetch(this.url(`/v1beta/models/${this.cfg.model}:generateContent`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: pong' }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 16 },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok)
        return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const j = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      return { ok: true, output: j.candidates?.[0]?.content?.parts?.[0]?.text ?? '' };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
