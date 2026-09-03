/**
 * Разбор ответа классификатора, когда он начинает возвращать номера.
 *
 * Главное здесь — совместимость: ответ ПРЕЖНЕГО промпта обязан разбираться
 * ровно как раньше и не обрастать полем docNumber даже со значением null.
 * Иначе проверка «при выключенном рубильнике план не изменился» перестала бы
 * быть побайтовой, а вместе с ней — и гарантия отсутствия регресса.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPages,
  parseClassification,
  PAGE_CLASSIFY_PROMPT,
  PAGE_CLASSIFY_WITH_NUMBER_PROMPT,
} from '../src/domain/edo/upd-page-prefilter.js';

describe('parseClassification: номера страниц', () => {
  it('ответ прежнего формата не получает лишних полей', () => {
    const out = parseClassification('{"pages":[{"page":1,"type":"upd_main"}]}', 1);
    expect(out).toEqual([{ page: 1, type: 'upd_main', use: true }]);
    expect('docNumber' in out[0]!).toBe(false);
  });

  it('читает номер, когда он есть', () => {
    const out = parseClassification(
      '{"pages":[{"page":1,"type":"upd_main","docNumber":" УТ-4308 "}]}',
      1,
    );
    expect(out[0]!.docNumber).toBe('УТ-4308');
  });

  it('null, число и «простыня» номером не считаются', () => {
    const raw = JSON.stringify({
      pages: [
        { page: 1, type: 'upd_main', docNumber: null },
        { page: 2, type: 'upd_main', docNumber: 4308 },
        { page: 3, type: 'upd_main', docNumber: 'x'.repeat(65) },
        { page: 4, type: 'upd_main', docNumber: '   ' },
      ],
    });
    for (const c of parseClassification(raw, 4)) {
      expect(c.docNumber).toBeUndefined();
    }
  });
});

describe('classifyPages: обрыв ответа по лимиту токенов', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respond = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it('finish_reason=length — явная ошибка, а не пустая классификация', async () => {
    // Обрезанный JSON разбирается в [], а пустая классификация на сборочном
    // пути means откат всего пакета. Причину надо видеть, а не гадать.
    vi.stubGlobal(
      'fetch',
      respond({
        choices: [{ message: { content: '{"pages":[{"page":1,' }, finish_reason: 'length' }],
      }),
    );
    await expect(
      classifyPages({
        apiBaseUrl: 'https://example.test',
        apiKey: 'k',
        model: 'm',
        thumbs: [Buffer.alloc(1)],
      }),
    ).rejects.toThrow(/finish_reason=length/);
  });

  it('обычный ответ возвращает finishReason вместе с разбором', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        choices: [
          {
            message: { content: '{"pages":[{"page":1,"type":"upd_main"}]}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const res = await classifyPages({
      apiBaseUrl: 'https://example.test',
      apiKey: 'k',
      model: 'm',
      thumbs: [Buffer.alloc(1)],
    });
    expect(res.finishReason).toBe('stop');
    expect(res.classification).toHaveLength(1);
  });

  it('промпт по умолчанию прежний, расширенный передаётся явно', async () => {
    const fetchMock = respond({
      choices: [{ message: { content: '{"pages":[]}' }, finish_reason: 'stop' }],
    });
    vi.stubGlobal('fetch', fetchMock);
    const args = {
      apiBaseUrl: 'https://example.test',
      apiKey: 'k',
      model: 'm',
      thumbs: [Buffer.alloc(1)],
    };

    await classifyPages(args);
    const bodyDefault = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const textOf = (body: { messages: { content: { type: string; text?: string }[] }[] }) =>
      body.messages[0]!.content.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    expect(textOf(bodyDefault)).toContain(PAGE_CLASSIFY_PROMPT);
    expect(textOf(bodyDefault)).not.toContain('docNumber');
    expect(bodyDefault.max_tokens).toBe(1024);

    await classifyPages({ ...args, prompt: PAGE_CLASSIFY_WITH_NUMBER_PROMPT, maxTokens: 3072 });
    const bodyExtended = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(textOf(bodyExtended)).toContain('docNumber');
    expect(bodyExtended.max_tokens).toBe(3072);
  });
});
