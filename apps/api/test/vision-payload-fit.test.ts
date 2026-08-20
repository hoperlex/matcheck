// Подгонка тела запроса к vision-провайдеру под потолок размера.
//
// Инцидент, из-за которого появилась подгонка: фотография документа с телефона
// (3.3 МБ JPEG) в сегментном пути перекодировалась в PNG полного разрешения,
// тело запроса раздувалось до десятков мегабайт, OpenRouter отвечал
// «413 Request Entity Too Large», а документ навсегда оставался «в очереди».
//
// Проверяется не «примерный размер картинок», а фактически сериализованное
// JSON-тело — 413 приходит именно на него, — и MIME каждой страницы: JPEG,
// объявленный как image/png, модель просто не прочитает.
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { Jimp } from 'jimp';

// Модуль тянет клиент БД ради провайдеров LLM; самой подгонке он не нужен.
vi.mock('../src/db/client.js', () => ({ db: {} }));

const {
  callOpenRouter,
  MAX_PAGES_FOR_OPENROUTER,
  VISION_REQUEST_MAX_BYTES,
  VisionPayloadTooLargeError,
} = await import('../src/domain/edo/upd-vision.parser.js');

/**
 * Страница, похожая на скан: плавные переходы плюс лёгкое зерно.
 *
 * Ровная заливка не годится — PNG сожмёт её до килобайтов, и потолок размера
 * никогда не сработает. Чистый шум тоже: он не сжимается ни PNG, ни JPEG, и
 * ступень перекодирования выглядела бы бесполезной. Настоящая фотография
 * документа ведёт себя как этот градиент: PNG большой, JPEG в разы меньше.
 */
async function makeHeavyPage(side: number): Promise<Buffer> {
  const img = new Jimp({ width: side, height: side, color: 0xffffffff });
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const i = (y * side + x) * 4;
      const g = Math.sin(x / 37) * 40 + Math.cos(y / 53) * 40 + 128;
      const grain = ((Math.imul(x * 2654435761 + y * 40503, 2246822519) >>> 24) % 7) - 3;
      const clamp = (v: number) => Math.max(0, Math.min(255, v));
      img.bitmap.data[i] = clamp(g + grain);
      img.bitmap.data[i + 1] = clamp(g * 0.8 + grain);
      img.bitmap.data[i + 2] = clamp(g * 0.6 + grain);
      img.bitmap.data[i + 3] = 255;
    }
  }
  return (await img.getBuffer('image/png')) as Buffer;
}

async function makeLightPage(): Promise<Buffer> {
  return (await new Jimp({ width: 400, height: 300, color: 0x3366ffff }).getBuffer(
    'image/png',
  )) as Buffer;
}

const fetchMock = vi.fn();

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '{"items":[],"confidence":0.9}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
  } as unknown as Response;
}

/** Тело последнего запроса — ровно та строка, что ушла в fetch. */
function sentBody(): string {
  const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string };
  return init.body;
}

/** data URL'ы картинок из отправленного тела. */
function sentImageUrls(): string[] {
  const body = JSON.parse(sentBody()) as {
    messages: { content: ({ type: string } & { image_url?: { url: string } })[] }[];
  };
  return body.messages[0]!.content.filter((c) => c.type === 'image_url').map(
    (c) => c.image_url!.url,
  );
}

const baseArgs = {
  apiBaseUrl: 'https://openrouter.test/api/v1',
  apiKey: 'test-key',
  model: 'google/gemini-3-flash-preview',
  temperature: 0.2,
  maxTokens: 8192,
  promptText: 'РАЗБЕРИ УПД',
};

let heavyPage: Buffer;
let lightPage: Buffer;

beforeAll(async () => {
  heavyPage = await makeHeavyPage(2000);
  lightPage = await makeLightPage();
  // Предпосылка всех проверок ниже: две такие страницы в PNG в потолок не
  // влезают, а одна лёгкая — влезает с запасом.
  expect(heavyPage.length * 2).toBeGreaterThan(VISION_REQUEST_MAX_BYTES);
}, 60_000);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
});

describe('callOpenRouter — тело под потолком размера', () => {
  it('набор под лимитом уходит как есть: PNG, без перекодирования', async () => {
    await callOpenRouter({ ...baseArgs, files: [{ buffer: lightPage, mimeType: 'image/png' }] });

    const urls = sentImageUrls();
    expect(urls).toHaveLength(1);
    expect(urls[0]!.startsWith('data:image/png;base64,')).toBe(true);
    // Байты страницы не тронуты — важнее размера: всё, что распознаётся
    // сегодня, обязано доехать до модели тем же кадром.
    expect(urls[0]).toBe(`data:image/png;base64,${lightPage.toString('base64')}`);
  });

  it('набор над лимитом ужимается в JPEG — и MIME едет вместе с байтами', async () => {
    await callOpenRouter({
      ...baseArgs,
      files: [
        { buffer: heavyPage, mimeType: 'image/png' },
        { buffer: heavyPage, mimeType: 'image/png' },
      ],
    });

    const urls = sentImageUrls();
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
      // Сигнатура важнее объявленного MIME: проверяем, что там действительно
      // JPEG, а не PNG под чужой вывеской.
      const bytes = Buffer.from(url.slice('data:image/jpeg;base64,'.length), 'base64');
      expect(bytes.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    }
    // Инвариант — по фактически отправленному телу, а не по сумме буферов.
    expect(Buffer.byteLength(sentBody(), 'utf8')).toBeLessThanOrEqual(VISION_REQUEST_MAX_BYTES);
  });

  it('максимальный сегмент из пяти страниц укладывается в потолок', async () => {
    await callOpenRouter({
      ...baseArgs,
      files: Array.from({ length: MAX_PAGES_FOR_OPENROUTER }, () => ({
        buffer: heavyPage,
        mimeType: 'image/png',
      })),
    });

    expect(sentImageUrls()).toHaveLength(MAX_PAGES_FOR_OPENROUTER);
    expect(Buffer.byteLength(sentBody(), 'utf8')).toBeLessThanOrEqual(VISION_REQUEST_MAX_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('что не влезло даже после сжатия — не отправляется вовсе', async () => {
    // Раздут не картинками, а самим промптом: перекодировать его нечем, и ни
    // одна ступень подгонки тело не спасёт. Ровно тот случай, когда запрос
    // нельзя отправлять — ответ заведомо 413.
    await expect(
      callOpenRouter({
        ...baseArgs,
        promptText: 'ю'.repeat(VISION_REQUEST_MAX_BYTES),
        files: [{ buffer: lightPage, mimeType: 'image/png' }],
      }),
    ).rejects.toBeInstanceOf(VisionPayloadTooLargeError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('413 от провайдера превращается в ошибку размера, а не в «HTTP 413»', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 413,
      text: async () => '<html><title>413 Request Entity Too Large</title></html>',
    } as unknown as Response);

    const err = await callOpenRouter({
      ...baseArgs,
      files: [{ buffer: lightPage, mimeType: 'image/png' }],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VisionPayloadTooLargeError);
    const typed = err as InstanceType<typeof VisionPayloadTooLargeError>;
    expect(typed.limitBytes).toBe(VISION_REQUEST_MAX_BYTES);
    // Размер берётся с отправленного тела — по нему и правится потолок.
    expect(typed.actualBytes).toBe(Buffer.byteLength(sentBody(), 'utf8'));
  });
});
