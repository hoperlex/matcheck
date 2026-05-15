import type { FastifyInstance } from 'fastify';
import { count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../../lib/fastify.js';
import {
  LlmKindSchema,
  LlmProviderCredentialDtoSchema,
  LlmProviderCredentialUpsertSchema,
  LlmTestResponseSchema,
  ErrorResponseSchema,
  type LlmKind,
} from '@matcheck/contracts';
import { llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { buildAad, decryptField, encryptToString } from '../../domain/auth/crypto.js';
import { OpenRouterProvider } from '../../domain/llm/openrouter.provider.js';
import { GoogleAiStudioProvider } from '../../domain/llm/google-ai-studio.provider.js';
import type { LlmProvider, LlmProviderConfig } from '../../domain/llm/provider.js';

// Дефолтная модель для каждого kind — используется только в /test, чтобы проверить
// ключ без необходимости заранее иметь модель в llm_providers.
const KIND_DEFAULT_MODEL: Record<LlmKind, string> = {
  openrouter: 'anthropic/claude-sonnet-4.5',
  google_ai_studio: 'gemini-2.5-flash',
  qwen_self_hosted: 'qwen2.5-72b-instruct',
  vertex: 'gemini-2.5-pro',
};

function dto(c: typeof llmProviderCredentials.$inferSelect) {
  return {
    kind: c.kind,
    apiBaseUrl: c.apiBaseUrl,
    hasKey: c.apiKeyEncrypted.length > 0,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function buildTestProvider(kind: LlmKind, apiBaseUrl: string, apiKey: string): LlmProvider {
  const cfg: LlmProviderConfig = {
    id: `test-${kind}`,
    kind,
    apiBaseUrl,
    model: KIND_DEFAULT_MODEL[kind],
    apiKey,
    temperature: 0,
    maxTokens: 16,
  };
  switch (kind) {
    case 'openrouter':
      return new OpenRouterProvider(cfg);
    case 'google_ai_studio':
      return new GoogleAiStudioProvider(cfg);
    default:
      throw new Error(`Тест соединения для kind "${kind}" пока не реализован`);
  }
}

export async function llmProviderCredentialRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/admin/llm-provider-credentials',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { response: { 200: z.array(LlmProviderCredentialDtoSchema) } },
    },
    async () => {
      const rows = await app.db
        .select()
        .from(llmProviderCredentials)
        .orderBy(llmProviderCredentials.kind);
      return rows.map(dto);
    },
  );

  app.put(
    '/api/v1/admin/llm-provider-credentials/:kind',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ kind: LlmKindSchema }),
        body: LlmProviderCredentialUpsertSchema,
        response: { 200: LlmProviderCredentialDtoSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { kind } = req.params;
      const { apiBaseUrl, apiKey } = req.body;

      const [existing] = await app.db
        .select()
        .from(llmProviderCredentials)
        .where(eq(llmProviderCredentials.kind, kind))
        .limit(1);

      if (!existing && !apiKey) {
        return reply.code(400).send({
          error: 'api_key_required',
          message: 'При первом добавлении ключа поле apiKey обязательно',
        });
      }

      const encrypted = apiKey
        ? encryptToString(apiKey, buildAad('llm_provider_credentials', kind))
        : existing!.apiKeyEncrypted;

      const [saved] = await app.db
        .insert(llmProviderCredentials)
        .values({ kind, apiBaseUrl, apiKeyEncrypted: encrypted })
        .onConflictDoUpdate({
          target: llmProviderCredentials.kind,
          set: { apiBaseUrl, apiKeyEncrypted: encrypted, updatedAt: new Date() },
        })
        .returning();
      if (!saved) throw new Error('Failed to upsert credential');
      return dto(saved);
    },
  );

  app.delete(
    '/api/v1/admin/llm-provider-credentials/:kind',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ kind: LlmKindSchema }),
        response: { 200: z.object({ ok: z.literal(true) }), 409: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { kind } = req.params;
      const [usage] = await app.db
        .select({ n: count() })
        .from(llmProviders)
        .where(eq(llmProviders.kind, kind));
      if ((usage?.n ?? 0) > 0) {
        return reply.code(409).send({
          error: 'credential_in_use',
          message: `Сначала удалите модели этого типа (${usage?.n})`,
        });
      }
      await app.db
        .delete(llmProviderCredentials)
        .where(eq(llmProviderCredentials.kind, kind));
      return { ok: true as const };
    },
  );

  app.post(
    '/api/v1/admin/llm-provider-credentials/:kind/test',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ kind: LlmKindSchema }),
        response: { 200: LlmTestResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { kind } = req.params;
      const [cred] = await app.db
        .select()
        .from(llmProviderCredentials)
        .where(eq(llmProviderCredentials.kind, kind))
        .limit(1);
      if (!cred) return reply.code(404).send({ error: 'not_found' });
      const apiKey = decryptField(
        cred.apiKeyEncrypted,
        buildAad('llm_provider_credentials', kind),
      );
      const provider = buildTestProvider(kind, cred.apiBaseUrl, apiKey);
      const started = Date.now();
      const result = await provider.testConnection();
      return { ...result, durationMs: Date.now() - started };
    },
  );
}
