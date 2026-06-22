// Vision-LLM распознавание УПД. Используется для двух сценариев:
//  1. PDF-сканы без текстового слоя (fallback после PdfNoTextError);
//  2. Фото УПД в JPG/PNG/WEBP — пользователь сфотографировал бумажный экземпляр.
//
// В отличие от parseUpdPdf (текст → LLM) здесь прямой vision-вызов:
// файл отдаётся модели как изображение/PDF через inline_data parts (Gemini)
// или image_url data:base64 (OpenRouter). Возвращает тот же UpdPdfParsed,
// что и текстовый парсер, — благодаря единой Zod-схеме контракта Vision
// и Text парсеры взаимозаменяемы на уровне worker'а.
//
// Поддерживаемые провайдеры — те же, что и waybill-batch:
//  - google_ai_studio — понимает application/pdf через inline_data;
//  - openrouter — только image/* (PDF не поддерживается провайдером).
// Если default-провайдер = openrouter и пришёл PDF — выбрасываем явную
// ошибку, чтобы worker мог пометить документ parse_failed с понятным
// сообщением.
//
// Схема ответа продублирована из upd-pdf.parser.ts (локальная константа
// RESPONSE_JSON_SCHEMA там не экспортирована). Намеренно не вытаскиваем
// в общий модуль — дублирование <120 строк JSON Schema проще держать
// рядом с каждым парсером, чем городить shared/-зависимость.

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../../db/client.js';
import { llmCalls, llmProviders, llmProviderCredentials } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { UpdPdfParsedSchema, type UpdPdfParsed } from '@matcheck/contracts';
import { loadActivePromptWithMeta } from '../prompts/registry.js';
import { computePdfRenderDpi } from './pdf-render-dpi.js';
import { prefilterUpdPages, type PrefilterResult } from './upd-page-prefilter.js';
import { buildAad, decryptField } from '../auth/crypto.js';
import type { ParsePdfResult } from './upd-pdf.parser.js';

// Лимит страниц при PDF→PNG конвертации (для OpenRouter+PDF).
// 5 страниц достаточно для большинства реальных УПД (типично 1-2 стр.).
// Если в проде встретятся УПД с >5 страниц позиций — повышаем константу.
// Защита от: (1) raw payload size limit OpenRouter; (2) затрат на
// токены (каждая страница = ~1000+ image tokens).
// Экспорт для регрессионных тестов; в коде parseUpdVision используется
// напрямую — поведение не меняется.
export const MAX_PAGES_FOR_OPENROUTER = 5;

// DPI рендера PDF в PNG через pdftoppm — теперь адаптивный.
// Для типовой A4 (8.27×11.69 inch) computePdfRenderDpi даёт 150 — то же
// что раньше, нулевая регрессия. Для аномально больших страниц (например
// scanlite3.pdf — 2530×3364 pt) формула снижает DPI так, чтобы итоговый
// PNG не превышал 2400 px по длинной стороне. См. pdf-render-dpi.ts.

// Таймаут на сам рендер PDF в PNG.
// 75 сек — Poppler обычно справляется с 1-2 страничным УПД за 1-3
// секунды; такой большой запас — на случай повреждённого/гигантского
// PDF из 1С с сотней встроенных шрифтов. Если упёрлись — fail-fast
// через PdfRenderTimeoutError (без BullMQ retry), пользователь видит
// «Не удалось подготовить PDF к распознаванию» и грузит как JPG.
const PDF_RENDER_TIMEOUT_MS = 75_000;

// Таймаут одной попытки Vision-вызова. 180 сек — баланс между
// «нормальный запрос успевает» и «не висим 10 минут на preview-модели».
// Если уперлись — VisionTimeoutError → fail-fast в worker без BullMQ retry.
const VISION_ATTEMPT_TIMEOUT_MS = 180_000;

// Общий бюджет времени на parseUpdVision — все попытки суммарно.
// Защищает от сценария «упёрлись в 180 + ретрай уехал ещё на 180 = 6 минут».
// Если перед очередной попыткой остаётся меньше 30 сек (минимум для
// нормального ответа + БД-логирования), мы НЕ начинаем её и кидаем
// VisionBudgetExceededError. Worker ловит её симметрично VisionTimeoutError
// — fail-fast, документ → parse_failed, без BullMQ retry.
const VISION_TOTAL_TIMEOUT_MS = 240_000;

// Количество ВНУТРЕННИХ retry на transient ошибки (обрыв соединения upstream,
// truncated JSON, HTTP 5xx/429, пустой ответ модели). Реальное наблюдение
// показало ~10-20% флакушности google/gemini-3-flash-preview через OpenRouter:
// модель отдаёт ~100-300 байт и закрывает соединение. Один быстрый retry
// внутри одной задачи (без BullMQ backoff'а) снижает финальный fail-rate
// до ~2-4% при той же видимой задержке для пользователя.
//
// ВАЖНО: retry делается ТОЛЬКО на transient (см. isTransientVisionError ниже).
// VisionTimeoutError, ZodError на валидном JSON, низкий confidence, ошибки
// маппинга/БД — НЕ ретраим (повтор не поможет, только потратит бюджет).
const VISION_TRANSIENT_RETRIES = 1;

// Минимальный бюджет, нужный на ещё одну попытку перед бросанием
// VisionBudgetExceededError. Меньше 30 сек — нет смысла начинать: даже если
// модель ответит быстро, нужен запас на parse/Zod/insert llm_calls.
const VISION_MIN_RETRY_BUDGET_MS = 30_000;

// Ошибка таймаута рендера PDF→PNG. Отдельный класс, чтобы worker
// мог пометить документ parse_failed СРАЗУ (без BullMQ retries):
// повторный запуск pdftoppm на тот же файл даст тот же результат.
export class PdfRenderTimeoutError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(
      `Не удалось подготовить PDF-скан к распознаванию за ${Math.round(elapsedMs / 1000)}с. ` +
        'PDF может быть повреждён или слишком большой. ' +
        'Попробуйте загрузить страницы как JPG/PNG (фото со смартфона).',
    );
    this.name = 'PdfRenderTimeoutError';
  }
}

// Ошибка рендера PDF→PNG (pdftoppm exit ≠ 0, не запустился, и т.п.).
// Worker ловит её так же — fail-fast без BullMQ retries: повтор не
// поможет. В parseErrorDetails.message пользователь увидит причину.
export class PdfRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfRenderError';
  }
}

// PDF→PNG через системный pdftoppm (poppler-utils). Заменил npm-пакет
// pdf-to-png-converter, который тянет нативные биндинги (pdfjs-dist +
// canvas/cairo) — на проде это нестабильно: либо нет системных либ,
// либо процесс висит на «битых» PDF из 1С. Poppler гарантированно
// установлен на любом Linux с `apt-get install poppler-utils` и
// промышленно отрабатывает любые PDF, включая сканы 1С.
//
// Возвращает массив PNG (Buffer) до maxPages страниц. Лишние страницы
// просто не рендерим (через -l). При любой ошибке кидает
// PdfRenderError; при таймауте PDF_RENDER_TIMEOUT_MS — PdfRenderTimeoutError.
/**
 * PDF→PNG через системный pdftoppm. Экспортировано для регрессионных
 * тестов (см. test/upd-vision-multipage.test.ts) — основная логика
 * не меняется, это публичный alias на ту же функцию.
 */
export { pdfToPngsViaPoppler };

async function pdfToPngsViaPoppler(
  pdfBuffer: Buffer,
  maxPages: number,
): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'upd-pdf-'));
  try {
    const inPath = join(dir, 'in.pdf');
    const outPrefix = join(dir, 'out');
    await writeFile(inPath, pdfBuffer);

    // Адаптивный DPI: для типовой A4 даёт 150 (как hardcoded раньше),
    // для аномально больших страниц снижает так, чтобы итоговый PNG
    // не превышал 2400 px по длинной стороне.
    const dpi = await computePdfRenderDpi(pdfBuffer);
    const args = [
      '-r',
      String(dpi),
      '-png',
      '-f',
      '1',
      '-l',
      String(maxPages),
      inPath,
      outPrefix,
    ];

    const startMs = Date.now();
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new PdfRenderTimeoutError(Date.now() - startMs));
      }, PDF_RENDER_TIMEOUT_MS);

      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        // ENOENT — самый частый случай: poppler-utils не установлен.
        const hint =
          err.message.includes('ENOENT')
            ? ' (не найден pdftoppm; на сервере: sudo apt-get install -y poppler-utils)'
            : '';
        reject(new PdfRenderError(`pdftoppm не запустился: ${err.message}${hint}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new PdfRenderError(
              `pdftoppm exit=${code}: ${stderr.trim().slice(0, 300) || '(no stderr)'}`,
            ),
          );
        } else {
          resolve();
        }
      });
    });

    // Имена файлов: out-1.png, out-2.png ... — сортируем по числовому
    // суффиксу (лексикографическая сортировка дала бы out-10 перед out-2).
    const files = (await readdir(dir))
      .filter((f) => /^out-\d+\.png$/.test(f))
      .sort((a, b) => {
        const ai = Number(a.match(/^out-(\d+)\.png$/)![1]);
        const bi = Number(b.match(/^out-(\d+)\.png$/)![1]);
        return ai - bi;
      });
    if (files.length === 0) {
      throw new PdfRenderError('pdftoppm завершился успешно, но не создал PNG');
    }
    const pages: Buffer[] = [];
    for (const f of files) pages.push(await readFile(join(dir, f)));
    return pages;
  } finally {
    // Всегда удаляем tmp-директорию, даже при ошибке. force:true чтобы
    // не падать если pdftoppm уже что-то не создал.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Специальный класс для Vision-timeout'а: worker ловит его отдельно
// и помечает parse_failed СРАЗУ, без BullMQ retries. Без этого
// при VISION_ATTEMPT_TIMEOUT_MS=180с и attempts=3 пользователь ждал бы
// 3+1+3+2+3 = 12 минут (3 timeouts + backoff 60с×1 + 60с×2 между
// попытками). После timeout повторно запрашивать ту же модель на тот
// же payload бессмысленно — она либо опять не успеет, либо у неё
// проблема с этим контентом. Лучше показать пользователю понятную
// ошибку и предложить альтернативу (другая модель / другой формат).
export class VisionTimeoutError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(
      `Vision LLM не ответил за ${Math.round(elapsedMs / 1000)}с. ` +
        'Попробуйте загрузить файл как JPG/PNG (быстрее) ' +
        'или переключить default-модель в Администрировании → LLM провайдеры.',
    );
    this.name = 'VisionTimeoutError';
  }
}

// Преобразует «таймаут» fetch (AbortError от AbortSignal.timeout) в
// VisionTimeoutError. Прочие ошибки прокидывает как есть — они получат
// обычный retry от BullMQ (например, временный 5xx OpenRouter).
function rethrowVisionTimeout(err: unknown, startMs: number): never {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    throw new VisionTimeoutError(Date.now() - startMs);
  }
  throw err instanceof Error ? err : new Error(String(err));
}

// Общий бюджет на parseUpdVision исчерпан между попытками. Симметричен
// VisionTimeoutError — worker ловит, помечает parse_failed без BullMQ retry.
// Возникает редко: только когда первая попытка съела почти весь бюджет и
// retry не помещается. В обычных сценариях retry на transient вписывается
// в 2× short call ≈ 10-20 сек и до бюджета не доходит.
export class VisionBudgetExceededError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(
      `Vision-распознавание УПД исчерпало бюджет ${Math.round(
        VISION_TOTAL_TIMEOUT_MS / 1000,
      )}с (фактически ${Math.round(elapsedMs / 1000)}с). ` +
        'Попробуйте загрузить файл как JPG/PNG (быстрее) ' +
        'или переключить default-модель в Администрировании → LLM провайдеры.',
    );
    this.name = 'VisionBudgetExceededError';
  }
}

// Классификация ошибок для решения о ретрае. Возвращает true, если ошибка
// похожа на transient (обрыв соединения, частичный ответ, временная
// недоступность провайдера) — такие нормально лечатся повтором.
// Возвращает false для finally-ошибок (таймаут на 180 сек, валидация Zod
// на корректном JSON, низкий confidence, ошибки маппинга/БД) — повтор не
// поможет, только потратит бюджет и токены пользователя.
function isTransientVisionError(err: Error): boolean {
  // Per-attempt timeout — fail-fast (VisionTimeoutError ловится в worker'е).
  if (err instanceof VisionTimeoutError) return false;
  // Битый/обрезанный JSON (truncated response) — основной симптом обрыва
  // upstream-соединения OpenRouter ↔ Google. Наблюдался в проде ~10-20%.
  if (err.message.includes('JSON.parse failed')) return true;
  // Пустой ответ модели (response.choices[0].message.content === '').
  if (err.message.includes('пустой ответ')) return true;
  // Транзитные HTTP-ошибки: 5xx (server error) и 429 (rate limit).
  if (/HTTP (5\d{2}|429)/i.test(err.message)) return true;
  // Network-level сбои node:fetch: разрыв соединения, DNS, socket hang up.
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network/i.test(err.message)) {
    return true;
  }
  // Прочее (ZodError, ошибки маппинга, БД и т.п.) — считаем final.
  return false;
}

// JSON Schema ответа Gemini — должна совпадать с UpdPdfParsedSchema в
// контрактах. Дублирование такое же, как в upd-pdf.parser.ts → если
// контракт расширяется, оба места обновлять синхронно.
const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  required: ['items', 'confidence'],
  properties: {
    docNumber: { type: ['string', 'null'] },
    docDate: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalSum: { type: ['number', 'null'] },
    vatSum: { type: ['number', 'null'] },
    itemsCount: { type: ['integer', 'null'] },
    supplier: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        kpp: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    recipient: {
      type: ['object', 'null'],
      properties: {
        inn: { type: ['string', 'null'] },
        kpp: { type: ['string', 'null'] },
        name: { type: ['string', 'null'] },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['nameRaw', 'qty', 'unit'],
        properties: {
          nameRaw: { type: 'string' },
          qty: { type: 'number' },
          unit: { type: 'string' },
          price: { type: ['number', 'null'] },
          sum: { type: ['number', 'null'] },
          vatRate: { type: ['number', 'null'] },
          vatSum: { type: ['number', 'null'] },
          volumeM3: { type: ['number', 'null'] },
          massKg: { type: ['number', 'null'] },
          volumeConfidence: {
            type: ['string', 'null'],
            enum: ['low', 'medium', 'high', null],
          },
          groupName: { type: ['string', 'null'] },
        },
      },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

const SUPPORTED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

export type UpdVisionInput = {
  buffer: Buffer;
  mimeType: string;
  filename?: string | null;
};

/**
 * Парсит УПД через vision-LLM. Возвращает то же `ParsePdfResult`, что и
 * `parseUpdPdf`, — на уровне worker.ts оба парсера взаимозаменяемы.
 *
 * При ошибках провайдера / непарсимом JSON / валидации — бросает исключение
 * (worker сам пометит документ parse_failed через стандартный retry-механизм
 * очереди, как у текстового parseUpdPdf).
 *
 * textLength в результате = размер base64 файла (для совместимости с типом;
 * пользователю это поле не показывается, оно только в логи).
 */
export async function parseUpdVision(
  input: UpdVisionInput,
  ctx: { sourceDocumentId: string | null } = { sourceDocumentId: null },
): Promise<ParsePdfResult> {
  const mime = input.mimeType.toLowerCase();
  if (!SUPPORTED_MIMES.has(mime)) {
    throw new Error(`parseUpdVision: неподдерживаемый MIME ${input.mimeType}`);
  }

  const [row] = await db
    .select()
    .from(llmProviders)
    .where(eq(llmProviders.isDefault, true))
    .limit(1);
  if (!row) {
    throw new Error('УПД vision: не настроен default LLM-провайдер');
  }
  if (row.kind !== 'google_ai_studio' && row.kind !== 'openrouter') {
    throw new Error(
      `УПД vision: распознавание из изображения не поддерживается провайдером ${row.kind}. ` +
        'Используйте Google AI Studio или OpenRouter.',
    );
  }
  // OpenRouter Vision принимает только image/*, PDF не поддерживается
  // провайдером. Если пришёл PDF и провайдер OpenRouter — готовим страницы
  // через prefilter (см. ниже, после загрузки apiKey: классификатору нужен
  // ключ). convertedPngPages заполняется там.
  let convertedPngPages: Buffer[] | null = null;
  let prefilter: PrefilterResult | null = null;

  const [cred] = await db
    .select()
    .from(llmProviderCredentials)
    .where(eq(llmProviderCredentials.kind, row.kind))
    .limit(1);
  if (!cred) {
    throw new Error(`УПД vision: не задан API-ключ провайдера ${row.kind}`);
  }
  const apiKey = decryptField(
    cred.apiKeyEncrypted,
    buildAad('llm_provider_credentials', cred.kind),
  );

  // PDF + OpenRouter: детерминированный prefilter — классификация страниц
  // (исключаем уверенно-чужие: сертификаты/накладные), авто-поворот
  // физически-боковых УПД-страниц (OSD, гейт по /Rotate). На любой ошибке
  // классификации/OSD prefilter сам деградирует к прежнему поведению
  // (первые MAX_PAGES_FOR_OPENROUTER страниц без поворота) — нулевая
  // регрессия для рабочих файлов. Рендер исходного PDF внутри prefilter
  // может бросить — это та же фатальная ситуация, что и раньше (worker
  // пометит parse_failed).
  if (row.kind === 'openrouter' && mime === 'application/pdf') {
    prefilter = await prefilterUpdPages(input.buffer, {
      apiBaseUrl: cred.apiBaseUrl,
      apiKey,
      model: row.model,
      maxPages: MAX_PAGES_FOR_OPENROUTER,
    });
    convertedPngPages = prefilter.pages;
    // Отдельная запись в llm_calls (docKind='upd_page_classify') — в админке
    // видно, какие страницы выбраны/исключены и почему. Только когда реально
    // делали LLM-вызов классификации (одностраничный PDF его не делает).
    if (prefilter.classifyRan) {
      try {
        await db.insert(llmCalls).values({
          sourceDocumentId: ctx.sourceDocumentId,
          providerId: row.id,
          promptId: null,
          docKind: 'upd_page_classify',
          model: row.model,
          requestMessages: [
            {
              role: 'user',
              content: `[upd page classify: ${input.filename ?? 'no-name'}, rendered=${prefilter.totalPages} pages, /Rotate=[${prefilter.perPageRotateFlag.join(',')}]]`,
            },
          ],
          requestSchema: null,
          responseRaw: prefilter.classifyRaw,
          responseParsed: {
            classification: prefilter.classification,
            selectedPages: prefilter.selectedPages,
            rotationsApplied: prefilter.rotations,
            fellBack: prefilter.fellBack,
          } as object,
          promptTokens: prefilter.promptTokens,
          completionTokens: prefilter.completionTokens,
          latencyMs: prefilter.latencyMs,
          errorCode: prefilter.classifyError ? 'provider_error' : null,
          errorMessage: prefilter.classifyError,
        });
      } catch {
        /* ignore — лог не критичен для основного потока */
      }
    }
  }
  // Используем тот же prompt doc_kind='upd', что и текстовый parser.
  const promptMeta = await loadActivePromptWithMeta('upd');
  // Хвост-страховка против array-обёртки. Gemini preview-модели иногда
  // возвращают [{...}] вместо {...} (см. наблюдение по логам ~20-33% флак).
  // Дублируем требование в промпте — снижает базовую вероятность ошибки;
  // если она всё-таки случится, unwrap при разборе JSON разворачивает
  // массив в объект (см. ниже). Хвост добавляется ТОЛЬКО для vision-flow,
  // прокручиваемый в БД промпт не меняем (text-parser его тоже использует).
  const visionPromptText =
    promptMeta.content +
    '\n\n# КРИТИЧНО: формат ответа\n' +
    'Верни ровно ОДИН JSON-объект на верхнем уровне ({"docNumber":..., "items":[...]}).\n' +
    'НЕ оборачивай его в массив. Ответ должен начинаться с символа `{`, а НЕ с `[`.';

  // Одна попытка распознавания: один LLM-вызов + JSON.parse + unwrap +
  // Zod-валидация + ВСЕГДА запись отдельной строки в llm_calls (даже на
  // ошибке). При успехе возвращает ParsePdfResult, при ошибке кидает.
  // Используется внутри retry-цикла ниже — каждая попытка видна в логах
  // «Логи распознавания (LLM)» как отдельная запись с пометкой attempt
  // в requestMessages.content (нумерация с 1).
  const runOneAttempt = async (attemptNo: number): Promise<ParsePdfResult> => {
    const attemptStartedAt = Date.now();
    let raw: string | null = null;
    let parsedZod: UpdPdfParsed | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    try {
      if (row.kind === 'google_ai_studio') {
        const result = await callGemini({
          apiBaseUrl: cred.apiBaseUrl,
          apiKey,
          model: row.model,
          temperature: Number(row.temperature ?? 0.2),
          maxTokens: row.maxTokens ?? 8192,
          promptText: visionPromptText,
          file: { buffer: input.buffer, mimeType: mime },
        });
        raw = result.raw;
        promptTokens = result.promptTokens;
        completionTokens = result.completionTokens;
      } else {
        // OpenRouter: PDF идёт как массив PNG (см. convertedPngPages выше),
        // image/* — как единственный image_url.
        const filesForOpenRouter =
          convertedPngPages !== null
            ? convertedPngPages.map((png) => ({ buffer: png, mimeType: 'image/png' }))
            : [{ buffer: input.buffer, mimeType: mime }];
        const result = await callOpenRouter({
          apiBaseUrl: cred.apiBaseUrl,
          apiKey,
          model: row.model,
          temperature: Number(row.temperature ?? 0.2),
          maxTokens: row.maxTokens ?? 8192,
          promptText: visionPromptText,
          files: filesForOpenRouter,
        });
        raw = result.raw;
        promptTokens = result.promptTokens;
        completionTokens = result.completionTokens;
      }

      if (!raw) throw new Error('УПД vision: пустой ответ LLM');

      let jsonParsed: unknown;
      try {
        jsonParsed = JSON.parse(stripJsonFences(raw));
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        e.message = `УПД vision: JSON.parse failed (likely truncated): ${e.message}`;
        throw e;
      }
      // Страховка от array-обёртки: Gemini preview-модели иногда возвращают
      // [{...}] вместо {...}. [{...}] разворачиваем; пустой [] и
      // многоэлементный [{},{}] пропускаем — это уже не флак формата.
      if (Array.isArray(jsonParsed) && jsonParsed.length === 1) {
        jsonParsed = jsonParsed[0];
      }
      parsedZod = UpdPdfParsedSchema.parse(jsonParsed);
      return {
        parsed: parsedZod,
        textLength: input.buffer.length,
        llmProviderId: row.id,
      };
    } catch (err) {
      errorCode = err instanceof z.ZodError ? 'zod_failed' : 'provider_error';
      errorMessage = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const latencyMs = Date.now() - attemptStartedAt;
      // Отдельная запись llm_calls на КАЖДУЮ попытку. В админке видно
      // «attempt 1 — provider_error (truncated JSON), attempt 2 — ok»
      // — это сильно упрощает разбор инцидентов на проде.
      try {
        await db.insert(llmCalls).values({
          sourceDocumentId: ctx.sourceDocumentId,
          providerId: row.id,
          promptId: promptMeta.id,
          docKind: 'upd',
          model: row.model,
          requestMessages: [
            {
              role: 'user',
              content: `[vision upd attempt=${attemptNo}: ${input.filename ?? 'no-name'} (${mime}, ${input.buffer.length} bytes${
                convertedPngPages !== null
                  ? `, pdf→png pages=${convertedPngPages.length}`
                  : ''
              })]\n${promptMeta.content.slice(0, 4000)}`,
            },
          ],
          requestSchema: RESPONSE_JSON_SCHEMA as object,
          responseRaw: raw,
          responseParsed: parsedZod as unknown as object | null,
          promptTokens,
          completionTokens,
          latencyMs,
          errorCode,
          errorMessage,
        });
      } catch {
        /* ignore — лог пропадёт, но основной поток не должен страдать */
      }
    }
  };

  // Retry-цикл с deadline check. Логика:
  //   * attempt=1: всегда выполняется (исходная попытка).
  //   * attempt=2..(1+VISION_TRANSIENT_RETRIES): только если предыдущая
  //     ошибка transient (см. isTransientVisionError) И в общем бюджете
  //     осталось ≥ VISION_MIN_RETRY_BUDGET_MS на ещё одну попытку.
  // При исчерпании бюджета бросаем VisionBudgetExceededError — worker
  // ловит её симметрично VisionTimeoutError (fail-fast, без BullMQ retry).
  // VisionTimeoutError проходит через retry-цикл насквозь: isTransient=false
  // → сразу throw → fail-fast в worker.
  const overallStartMs = Date.now();
  const deadlineMs = overallStartMs + VISION_TOTAL_TIMEOUT_MS;
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= 1 + VISION_TRANSIENT_RETRIES; attempt++) {
    if (attempt > 1) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs < VISION_MIN_RETRY_BUDGET_MS) {
        throw new VisionBudgetExceededError(Date.now() - overallStartMs);
      }
    }
    try {
      return await runOneAttempt(attempt);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      lastErr = e;
      if (
        attempt < 1 + VISION_TRANSIENT_RETRIES &&
        isTransientVisionError(e)
      ) {
        // Логирование этой попытки уже произошло в runOneAttempt.finally —
        // просто продолжаем к следующей итерации без задержки.
        continue;
      }
      throw e;
    }
  }
  // Не должно достигаться (либо return из try, либо throw из catch выше),
  // но TS требует явный throw.
  throw lastErr ?? new Error('УПД vision: не удалось распознать');
}

type GeminiCallArgs = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  promptText: string;
  file: { buffer: Buffer; mimeType: string };
};

type OpenRouterCallArgs = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  promptText: string;
  files: { buffer: Buffer; mimeType: string }[];
};

type VisionCallResult = {
  raw: string;
  promptTokens: number | null;
  completionTokens: number | null;
};

async function callGemini(args: GeminiCallArgs): Promise<VisionCallResult> {
  const parts: Array<{ inline_data: { mime_type: string; data: string } } | { text: string }> = [
    {
      inline_data: {
        mime_type: args.file.mimeType,
        data: args.file.buffer.toString('base64'),
      },
    },
    { text: args.promptText },
  ];

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: args.temperature,
      maxOutputTokens: args.maxTokens,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_JSON_SCHEMA,
    },
  };
  const url = `${args.apiBaseUrl.replace(/\/$/, '')}/v1beta/models/${args.model}:generateContent?key=${encodeURIComponent(args.apiKey)}`;

  const startMs = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VISION_ATTEMPT_TIMEOUT_MS),
    });
  } catch (err) {
    rethrowVisionTimeout(err, startMs);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini vision HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };
  return {
    raw: json.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
    promptTokens: json.usageMetadata?.promptTokenCount ?? null,
    completionTokens: json.usageMetadata?.candidatesTokenCount ?? null,
  };
}

async function callOpenRouter(args: OpenRouterCallArgs): Promise<VisionCallResult> {
  const content: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  // Все картинки одним массивом — для многостраничного PDF (после
  // конвертации) это все страницы сразу, OpenRouter Vision API
  // поддерживает несколько image_url в одном messages[i].content.
  for (const f of args.files) {
    const dataUrl = `data:${f.mimeType};base64,${f.buffer.toString('base64')}`;
    content.push({ type: 'image_url', image_url: { url: dataUrl } });
  }
  content.push({ type: 'text', text: args.promptText });

  const body = {
    model: args.model,
    messages: [{ role: 'user', content }],
    temperature: args.temperature,
    max_tokens: args.maxTokens,
    response_format: { type: 'json_object' as const },
  };

  const url = `${args.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const startMs = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${args.apiKey}`,
        'HTTP-Referer': 'https://matcheck.local',
        'X-Title': 'matcheck',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VISION_ATTEMPT_TIMEOUT_MS),
    });
  } catch (err) {
    rethrowVisionTimeout(err, startMs);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter vision HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    raw: json.choices?.[0]?.message?.content ?? '',
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
  };
}

function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const noLead = trimmed.replace(/^```(?:json)?\s*/i, '');
  return noLead.replace(/\s*```\s*$/i, '');
}
