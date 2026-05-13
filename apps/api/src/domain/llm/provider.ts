import type { z } from 'zod';

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LlmCompletionRequest = {
  messages: LlmMessage[];
  jsonSchema?: object;
  temperature?: number;
  maxTokens?: number;
};

export type LlmCompletionResult<T> = {
  data: T;
  raw: string;
  promptTokens?: number;
  completionTokens?: number;
  confidence?: number;
};

export interface LlmProvider {
  readonly kind: 'openrouter' | 'google_ai_studio' | 'qwen_self_hosted' | 'vertex';
  complete<T>(req: LlmCompletionRequest, schema: z.ZodType<T>): Promise<LlmCompletionResult<T>>;
  testConnection(): Promise<{ ok: boolean; output?: string; error?: string }>;
}

export type LlmProviderConfig = {
  id: string;
  kind: LlmProvider['kind'];
  apiBaseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
};
