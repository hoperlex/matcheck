/**
 * Двухфазный забор писем.
 *
 * Главное проверяемое свойство: тело письма НЕ скачивается, пока не пройдены
 * проверки. Существующий однофазный клиент декодирует письмо целиком, поэтому
 * конверт на сотни мегабайт уронит процесс раньше любой проверки лимитов.
 *
 * IMAP-сервер подменён: логика решений вынесена в чистые функции ровно затем,
 * чтобы её можно было проверить без сети.
 */
import type { MessageStructureObject } from 'imapflow';
import { describe, expect, it, vi } from 'vitest';
import {
  decideFetch,
  fetchHeadlines,
  fetchSource,
  summarizeStructure,
  DEFAULT_FETCH_LIMITS,
  type ImapLike,
  type MessageHeadline,
} from '../src/domain/mail/imap.fetch.js';

const headline = (over: Partial<MessageHeadline> = {}): MessageHeadline => ({
  uid: 1,
  size: 1024,
  messageId: '<a@example.org>',
  subject: 'УПД',
  from: 'snab@example.org',
  receivedAt: new Date('2026-07-30T10:00:00Z'),
  structure: null,
  ...over,
});

/** Письмо: текст + PDF-вложение. */
const withPdf: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    { type: 'text/plain', size: 400 },
    { type: 'application/pdf', size: 120_000, disposition: 'attachment' },
  ],
};

/** Письмо-переписка: только текст и html. */
const textOnly: MessageStructureObject = {
  type: 'multipart/alternative',
  childNodes: [
    { type: 'text/plain', size: 500 },
    { type: 'text/html', size: 900 },
  ],
};

/** Html с картинками вёрстки (логотип в подписи) и настоящим вложением. */
const relatedWithLogo: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    {
      type: 'multipart/related',
      childNodes: [
        { type: 'text/html', size: 2000 },
        { type: 'image/png', size: 8000, id: '<logo@x>' },
      ],
    },
    { type: 'application/pdf', size: 90_000, disposition: 'attachment' },
  ],
};

describe('разбор структуры письма до скачивания', () => {
  it('находит вложение-документ', () => {
    const s = summarizeStructure(withPdf);
    expect(s.hasCandidateAttachment).toBe(true);
    expect(s.attachmentBytes).toBe(120_000);
  });

  it('переписку без вложений распознаёт как пустую', () => {
    expect(summarizeStructure(textOnly).hasCandidateAttachment).toBe(false);
  });

  it('считает картинки внутри multipart/related отдельно', () => {
    const s = summarizeStructure(relatedWithLogo);
    expect(s.hasCandidateAttachment).toBe(true);
    expect(s.relatedParts).toBe(1);
  });

  it('текст, отправленный как файл, вложением считается', () => {
    const s = summarizeStructure({
      type: 'multipart/mixed',
      childNodes: [{ type: 'application/octet-stream', size: 10, disposition: 'attachment' }],
    });
    expect(s.hasCandidateAttachment).toBe(true);
  });

  it('отсутствие структуры не ломает разбор', () => {
    expect(summarizeStructure(null).hasCandidateAttachment).toBe(false);
  });
});

describe('решение о скачивании тела', () => {
  it('обычное письмо с вложением скачиваем', () => {
    expect(decideFetch(headline({ structure: withPdf }))).toEqual({ fetch: true });
  });

  it('письмо больше лимита не скачиваем — это и есть смысл двухфазности', () => {
    const huge = headline({ size: 400 * 1024 * 1024, structure: withPdf });
    expect(decideFetch(huge)).toEqual({ fetch: false, reason: 'skipped_by_size' });
  });

  it('ровно на границе лимита ещё скачиваем', () => {
    const edge = headline({ size: DEFAULT_FETCH_LIMITS.maxLetterBytes, structure: withPdf });
    expect(decideFetch(edge)).toEqual({ fetch: true });
  });

  it('письмо без подходящих вложений не скачиваем', () => {
    expect(decideFetch(headline({ structure: textOnly }))).toEqual({
      fetch: false,
      reason: 'no_attachments',
    });
  });

  it('если сервер не отдал структуру — скачиваем, чтобы не потерять документы', () => {
    expect(decideFetch(headline({ structure: null }))).toEqual({ fetch: true });
  });

  it('если сервер не отдал размер — решает структура', () => {
    expect(decideFetch(headline({ size: null, structure: withPdf }))).toEqual({ fetch: true });
  });
});

describe('первая фаза не тянет тело', () => {
  function client(messages: unknown[]): ImapLike & { queries: Record<string, boolean>[] } {
    const queries: Record<string, boolean>[] = [];
    return {
      queries,
      fetch(_range, query) {
        queries.push(query);
        return (async function* () {
          for (const m of messages) yield m as never;
        })();
      },
      fetchOne: vi.fn(async () => ({ source: Buffer.from('raw') })),
    } as ImapLike & { queries: Record<string, boolean>[] };
  }

  it('запрашивает метаданные и НЕ запрашивает source', async () => {
    const c = client([{ uid: 5, size: 100, envelope: {}, bodyStructure: withPdf }]);
    await fetchHeadlines(c, 1, 50);
    expect(c.queries[0]).toMatchObject({ envelope: true, size: true, bodyStructure: true });
    expect(c.queries[0]!.source).toBeUndefined();
  });

  it('возвращает письма по возрастанию UID', async () => {
    const c = client([
      { uid: 9, size: 10, envelope: {} },
      { uid: 3, size: 10, envelope: {} },
      { uid: 7, size: 10, envelope: {} },
    ]);
    const list = await fetchHeadlines(c, 1, 50);
    expect(list.map((m) => m.uid)).toEqual([3, 7, 9]);
  });

  it('игнорирует письма ниже watermark и соблюдает лимит количества', async () => {
    const c = client([
      { uid: 1, size: 10, envelope: {} },
      { uid: 12, size: 10, envelope: {} },
      { uid: 13, size: 10, envelope: {} },
    ]);
    const list = await fetchHeadlines(c, 10, 1);
    expect(list.map((m) => m.uid)).toEqual([12]);
  });

  it('вытаскивает отправителя и дату из конверта', async () => {
    const c = client([
      {
        uid: 4,
        size: 20,
        envelope: {
          messageId: '<x@y>',
          subject: 'УПД АЛ13',
          from: [{ address: 'snab@podryad.ru' }],
          date: new Date('2026-07-30T08:00:00Z'),
        },
      },
    ]);
    const [m] = await fetchHeadlines(c, 1, 50);
    expect(m).toMatchObject({ from: 'snab@podryad.ru', subject: 'УПД АЛ13', messageId: '<x@y>' });
  });
});

describe('вторая фаза', () => {
  it('возвращает сырое письмо', async () => {
    const c: ImapLike = {
      fetch: () => (async function* () {})(),
      fetchOne: async () => ({ source: Buffer.from('RAW EML') }),
    };
    expect((await fetchSource(c, 5))?.toString()).toBe('RAW EML');
  });

  it('письмо исчезло между фазами → null, а не исключение', async () => {
    const c: ImapLike = {
      fetch: () => (async function* () {})(),
      fetchOne: async () => false,
    };
    expect(await fetchSource(c, 5)).toBeNull();
  });
});
