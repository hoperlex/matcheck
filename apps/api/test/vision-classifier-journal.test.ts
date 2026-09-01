/**
 * Журнал классификатора типа документа.
 *
 * Два требования, и оба — про то, чтобы раздел «Документы» не заметил появления
 * фото-пути:
 *
 *  1. Вызов БЕЗ метки (так его делает воркер документов) пишет ровно ту строку,
 *     что писал всегда. Метка — только у фото, где нет source_document_id и
 *     разобрать жалобу иначе нечем.
 *  2. Ошибка провайдера у вызова С меткой попадает в llm_calls. Классификатор
 *     глушит любую ошибку в `null`, и до этого при 429 или таймауте в журнале не
 *     оставалось ничего — а именно этот вызов делается на каждое фото и стал
 *     самым массовым обращением к модели. У вызова без метки поведение прежнее:
 *     ни строки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  callOpenRouter: vi.fn(),
  callGemini: vi.fn(),
  inserted: [] as Record<string, unknown>[],
}));

const provider = {
  id: 'prov-1',
  kind: 'openrouter',
  model: 'google/gemini-3-flash-preview',
  isDefault: true,
};
const credential = { kind: 'openrouter', apiBaseUrl: 'https://api', apiKeyEncrypted: 'enc' };

// Драйвер БД: два SELECT (провайдер, ключ) и INSERT в llm_calls.
vi.mock('../src/db/client.js', () => {
  let selectCall = 0;
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (selectCall++ % 2 === 0 ? [provider] : [credential]),
          }),
        }),
      }),
      insert: () => ({
        values: async (v: Record<string, unknown>) => {
          mocks.inserted.push(v);
        },
      }),
    },
  };
});
vi.mock('../src/db/schema.js', () => ({
  llmProviders: {},
  llmProviderCredentials: {},
  llmCalls: {},
}));
vi.mock('../src/domain/auth/crypto.js', () => ({
  decryptField: () => 'api-key',
  buildAad: () => 'aad',
}));
vi.mock('../src/domain/edo/upd-vision.parser.js', () => ({
  callGemini: mocks.callGemini,
  callOpenRouter: mocks.callOpenRouter,
  stripJsonFences: (s: string) => s,
  pdfToPngsViaPoppler: async () => [Buffer.from('png')],
}));

const { classifyImageKind } = await import('../src/domain/edo/vision-classifier.js');

const buffer = Buffer.from('jpeg');

beforeEach(() => {
  mocks.inserted.length = 0;
  mocks.callOpenRouter.mockReset();
  mocks.callGemini.mockReset();
});

describe('classifyImageKind — запись в журнал', () => {
  it('без метки строка запроса ровно прежняя', async () => {
    mocks.callOpenRouter.mockResolvedValue({ raw: '{"kind":"upd","confidence":0.9}' });

    const r = await classifyImageKind(buffer, 'image/jpeg', { sourceDocumentId: null });

    expect(r).toEqual({ kind: 'upd', confidence: 0.9 });
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]!.requestMessages).toEqual([
      { role: 'user', content: '[router image classify]' },
    ]);
  });

  it('с меткой вызов опознаётся по фото', async () => {
    mocks.callOpenRouter.mockResolvedValue({ raw: '{"kind":"upd","confidence":0.9}' });

    await classifyImageKind(buffer, 'image/jpeg', { sourceDocumentId: null, label: 'photo:abc' });

    expect(mocks.inserted[0]!.requestMessages).toEqual([
      { role: 'user', content: '[router image classify: photo:abc]' },
    ]);
  });

  it('без таймаута вызов остаётся на общем VISION_ATTEMPT_TIMEOUT_MS', async () => {
    mocks.callOpenRouter.mockResolvedValue({ raw: '{"kind":"upd","confidence":0.9}' });

    await classifyImageKind(buffer, 'image/jpeg', { sourceDocumentId: null });

    // undefined, а не число: дефолт живёт в самом callOpenRouter, и подменять
    // его здесь значило бы менять поведение пути документов.
    expect(mocks.callOpenRouter.mock.calls[0]![0].timeoutMs).toBeUndefined();
  });

  it('свой таймаут доезжает до вызова', async () => {
    mocks.callOpenRouter.mockResolvedValue({ raw: '{"kind":"upd","confidence":0.9}' });

    await classifyImageKind(buffer, 'image/jpeg', {
      sourceDocumentId: null,
      label: 'photo:abc',
      timeoutMs: 45_000,
    });

    expect(mocks.callOpenRouter.mock.calls[0]![0].timeoutMs).toBe(45_000);
  });

  it('HTTP 429 у вызова с меткой попадает в журнал', async () => {
    mocks.callOpenRouter.mockRejectedValue(new Error('OpenRouter HTTP 429: rate limit'));

    const r = await classifyImageKind(buffer, 'image/jpeg', {
      sourceDocumentId: null,
      label: 'photo:abc',
    });

    expect(r).toBeNull();
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]).toMatchObject({
      docKind: 'router_classify',
      errorCode: 'provider_error',
      providerId: 'prov-1',
    });
    expect(String(mocks.inserted[0]!.errorMessage)).toContain('429');
    // Колонка NOT NULL — число обязано быть.
    expect(typeof mocks.inserted[0]!.latencyMs).toBe('number');
  });

  it('та же ошибка без метки журнал не трогает', async () => {
    mocks.callOpenRouter.mockRejectedValue(new Error('OpenRouter HTTP 429: rate limit'));

    const r = await classifyImageKind(buffer, 'image/jpeg', { sourceDocumentId: null });

    expect(r).toBeNull();
    expect(mocks.inserted).toHaveLength(0);
  });

  it('пустой ответ и битый JSON у фото-пути тоже видны', async () => {
    mocks.callOpenRouter.mockResolvedValue({ raw: '' });
    await classifyImageKind(buffer, 'image/jpeg', { sourceDocumentId: null, label: 'photo:1' });
    expect(mocks.inserted[0]).toMatchObject({ errorCode: 'provider_error' });

    mocks.inserted.length = 0;
    mocks.callOpenRouter.mockResolvedValue({ raw: 'не json' });
    await classifyImageKind(buffer, 'image/jpeg', { sourceDocumentId: null, label: 'photo:2' });
    expect(mocks.inserted[0]).toMatchObject({ errorCode: 'json_failed' });
  });
});
