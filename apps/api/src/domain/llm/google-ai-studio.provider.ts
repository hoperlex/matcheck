import type { z } from 'zod';
import type {
  LlmCompletionRequest,
  LlmCompletionResult,
  LlmProvider,
  LlmProviderConfig,
} from './provider.js';

export class GoogleAiStudioProvider implements LlmProvider {
  readonly kind = 'google_ai_studio' as const;
  readonly id: string;
  readonly model: string;
  constructor(private readonly cfg: LlmProviderConfig) {
    this.id = cfg.id;
    this.model = cfg.model;
  }

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
      // Потолок ожидания, не задержка: тяжёлые УПД-PDF с 50+ позициями требуют больше времени.
      signal: AbortSignal.timeout(600_000),
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
    const maxOutputTokens = (body.generationConfig as { maxOutputTokens?: number })
      .maxOutputTokens;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // См. комментарий в openrouter.provider.ts: raw нужен в журнале,
      // чтобы видно было, на каком месте модель оборвала ответ.
      const e = err instanceof Error ? err : new Error(String(err));
      (e as Error & { rawResponse?: string }).rawResponse = raw;
      e.message = `Google AI Studio: JSON.parse failed (likely truncated by maxOutputTokens=${maxOutputTokens}): ${e.message}`;
      throw e;
    }
    const data = schema.parse(parsed);
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
