import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPages } from '../src/domain/edo/upd-page-prefilter.js';

/**
 * Перегрузка общей очереди LLM-прокси на классификации страниц.
 *
 * Почему это важно именно здесь: классификация — вход постраничной сборки, и
 * её единственная ошибка откатывала сборку всего пакета. На бою 10.09.2026 так
 * пять УПД из одного PDF слиплись в одну карточку (приёмка 14601).
 *
 * `retry-after: 0` в фикстурах — чтобы тест не ждал по-настоящему: помощник
 * уважает просьбу провайдера, а ноль означает «повторяй сразу».
 */
const QUEUE_FULL = JSON.stringify({
  error: { code: 'queue_full', message: 'proxy queue is full, retry later' },
});

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
    status: 200,
  });

const overloaded = (status: number) =>
  new Response(QUEUE_FULL, { status, headers: { 'retry-after': '0' } });

const args = {
  apiBaseUrl: 'https://example.test',
  apiKey: 'k',
  model: 'm',
  thumbs: [Buffer.alloc(1)],
};

describe('classifyPages: перегрузка прокси', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('повторяет queue_full и возвращает классификацию со второй попытки', async () => {
    const fetchMock = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(overloaded(503))
      .mockResolvedValueOnce(ok('{"pages":[{"page":1,"type":"upd_main"}]}'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await classifyPages(args);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.classification).toHaveLength(1);
  });

  it('повторяет шлюзовой 502 — случай приёмки 14601', async () => {
    const fetchMock = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(overloaded(502))
      .mockResolvedValueOnce(ok('{"pages":[{"page":1,"type":"upd_main"}]}'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await classifyPages(args);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.classification).toHaveLength(1);
  });

  it('на устойчивой перегрузке бросает прежнюю ошибку, исчерпав попытки', async () => {
    const fetchMock = vi.fn(async () => overloaded(503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyPages(args)).rejects.toThrow(/page-classify HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ошибку по существу запроса не повторяет', async () => {
    // 403 «Key limit exceeded» — это не перегрузка очереди, повтор её не лечит.
    const fetchMock = vi.fn(
      async () => new Response('{"error":{"message":"Key limit exceeded"}}', { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(classifyPages(args)).rejects.toThrow(/page-classify HTTP 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('переживает обрыв соединения — случай 04.09 «fetch failed»', async () => {
    const fetchMock = vi
      .fn<[], Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok('{"pages":[{"page":1,"type":"upd_main"}]}'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await classifyPages(args);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.classification).toHaveLength(1);
  });

  it('успешный ответ проходит без единого повтора', async () => {
    const fetchMock = vi.fn(async () => ok('{"pages":[{"page":1,"type":"upd_main"}]}'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await classifyPages(args);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.classification).toHaveLength(1);
  });
});
