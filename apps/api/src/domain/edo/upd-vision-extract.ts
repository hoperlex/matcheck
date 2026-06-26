// Multi-UPD bundle (Шаг 2): извлечение ОДНОГО УПД из набора PNG-страниц.
//
// Это тонкий helper для bundle/debug-пути. Переиспользует тот же OpenRouter
// Vision-вызов и разбор JSON, что и production parseUpdVision, но:
//   - принимает уже подготовленные PNG-страницы ОДНОГО сегмента (одна группа
//     = один УПД), а не весь файл;
//   - НЕ пишет в llm_calls и НЕ ходит в БД за провайдером/промптом — всё это
//     передаётся параметрами;
//   - без retry-цикла (для proof достаточно одной попытки).
//
// Production parseUpdVision этот модуль НЕ использует и остаётся нетронутым:
// одиночный flow распознавания не меняется.

import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { callOpenRouter, stripJsonFences } from './upd-vision.parser.js';

export type ExtractUpdOpts = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  // Финальный текст промпта (обычно active 'upd' prompt + хвост про один
  // JSON-объект). Передаётся готовым, чтобы helper не ходил в БД.
  promptText: string;
};

/**
 * Извлекает один УПД из PNG-страниц через OpenRouter Vision (image-путь).
 * Бросает при пустом ответе / невалидном JSON / провале Zod-валидации.
 */
export async function extractUpdFromPages(
  pages: Buffer[],
  opts: ExtractUpdOpts,
): Promise<UpdPdfParsed> {
  if (pages.length === 0) throw new Error('extractUpdFromPages: нет страниц для извлечения');

  const result = await callOpenRouter({
    apiBaseUrl: opts.apiBaseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    temperature: opts.temperature ?? 0.2,
    maxTokens: opts.maxTokens ?? 8192,
    promptText: opts.promptText,
    files: pages.map((png) => ({ buffer: png, mimeType: 'image/png' })),
  });

  if (!result.raw) throw new Error('extractUpdFromPages: пустой ответ LLM');

  let jsonParsed: unknown;
  try {
    jsonParsed = JSON.parse(stripJsonFences(result.raw));
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    e.message = `extractUpdFromPages: JSON.parse failed: ${e.message}`;
    throw e;
  }
  // Та же страховка от array-обёртки, что в parseUpdVision.
  if (Array.isArray(jsonParsed) && jsonParsed.length === 1) jsonParsed = jsonParsed[0];

  return UpdPdfParsedSchema.parse(jsonParsed);
}
