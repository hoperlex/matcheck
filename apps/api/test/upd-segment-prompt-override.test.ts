/**
 * promptOverride в сегментном пути.
 *
 * Сегментный путь (сборка комплекта фотографий в логические УПД) — основной
 * сценарий портала, но до сих пор он был единственным, который нельзя было
 * прогнать на другой версии промпта: extractUpdSegment брал активный промпт из
 * БД жёстко. Из-за этого A/B промпта проверял всё, кроме главного.
 *
 * Тест закрывает обе стороны правки:
 *   * с override используется переданный промпт и его температура;
 *   * БЕЗ override поведение прежнее — промпт берётся из БД (регресс-защита,
 *     потому что боевой вызов параметр не передаёт).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolvePrompt = vi.fn();
const extractUpdFromPages = vi.fn();
const insertValues = vi.fn();

vi.mock('../src/db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: { _tableName?: string }) => ({
        where: () => ({
          limit: async () => {
            // Порядок обращений в extractUpdSegment: сначала провайдер, затем
            // учётные данные. Различаем их по вызванной таблице.
            const name = String(table?._tableName ?? '');
            if (name === 'llm_provider_credentials') {
              return [{ kind: 'openrouter', apiBaseUrl: 'https://api.test', apiKeyEncrypted: 'enc' }];
            }
            return [
              {
                id: 'provider-1',
                kind: 'openrouter',
                model: 'test-model',
                temperature: '0.2',
                maxTokens: 8192,
                isDefault: true,
              },
            ];
          },
        }),
      }),
    }),
    insert: () => ({ values: insertValues }),
  },
}));

vi.mock('../src/db/schema.js', () => ({
  llmCalls: { _tableName: 'llm_calls' },
  llmProviders: { _tableName: 'llm_providers' },
  llmProviderCredentials: { _tableName: 'llm_provider_credentials' },
}));

vi.mock('../src/domain/auth/crypto.js', () => ({
  buildAad: () => 'aad',
  decryptField: () => 'test-api-key',
}));

vi.mock('../src/domain/prompts/registry.js', () => ({
  resolvePrompt: (...args: unknown[]) => resolvePrompt(...args),
}));

vi.mock('../src/domain/edo/upd-vision-extract.js', () => ({
  extractUpdFromPages: (...args: unknown[]) => extractUpdFromPages(...args),
}));

const { extractUpdSegment } = await import('../src/domain/edo/upd-segment-extract.js');

const PAGE = Buffer.from('png');
const PARSED = { docNumber: '1', docDate: null, items: [], confidence: 0.9 };

describe('extractUpdSegment — источник промпта', () => {
  beforeEach(() => {
    resolvePrompt.mockReset();
    extractUpdFromPages.mockReset();
    insertValues.mockReset();
    insertValues.mockResolvedValue(undefined);
    extractUpdFromPages.mockResolvedValue({ parsed: PARSED });
  });

  it('без override: промпт берётся из БД, температура — провайдера', async () => {
    resolvePrompt.mockResolvedValue({ id: 'prompt-active', content: 'АКТИВНЫЙ ПРОМПТ' });

    await extractUpdSegment([PAGE], {
      sourceDocumentId: 'doc-1',
      bundleId: 'bundle-1',
      segmentIndex: 0,
    });

    // Второй аргумент resolvePrompt — override; в бою его быть не должно.
    expect(resolvePrompt).toHaveBeenCalledWith('upd', undefined);
    const call = extractUpdFromPages.mock.calls[0]![1] as { promptText: string; temperature: number };
    expect(call.promptText).toContain('АКТИВНЫЙ ПРОМПТ');
    expect(call.temperature).toBe(0.2);
  });

  it('с override: используется переданный промпт и его температура', async () => {
    const override = {
      prompt: { id: 'prompt-v9', content: 'ПРОМПТ V9', docKind: 'upd', name: 'default v9' },
      temperature: 0,
    };
    resolvePrompt.mockResolvedValue({ id: 'prompt-v9', content: 'ПРОМПТ V9' });

    await extractUpdSegment([PAGE], {
      sourceDocumentId: null,
      bundleId: 'ab',
      segmentIndex: 2,
      promptOverride: override as never,
    });

    expect(resolvePrompt).toHaveBeenCalledWith('upd', override);
    const call = extractUpdFromPages.mock.calls[0]![1] as { promptText: string; temperature: number };
    expect(call.promptText).toContain('ПРОМПТ V9');
    // Температура 0 обязана дойти как 0, а не провалиться в ?? провайдера.
    expect(call.temperature).toBe(0);
  });

  it('sourceDocumentId = null пишется в журнал вызовов (офлайн-прогон)', async () => {
    resolvePrompt.mockResolvedValue({ id: 'prompt-v9', content: 'ПРОМПТ V9' });

    await extractUpdSegment([PAGE], {
      sourceDocumentId: null,
      bundleId: 'ab',
      segmentIndex: 0,
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDocumentId: null, promptId: 'prompt-v9' }),
    );
  });
});
