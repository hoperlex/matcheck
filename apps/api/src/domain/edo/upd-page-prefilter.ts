// Детерминированный слой подготовки многостраничного PDF-скана перед
// Vision-извлечением УПД (ветка OpenRouter). Решает две проблемы, которые
// промптом не лечатся:
//
//  1. «Лишние» страницы в пакете. Реальные сканы из 1С/почты часто содержат
//     не только УПД, но и транспортную накладную, сертификаты/паспорта
//     качества, спецификации. Если отдать весь пакет Vision-модели, она
//     либо путается, либо тянет позиции из сертификата в items. Решение:
//     один дешёвый LLM-вызов классифицирует КАЖДУЮ страницу, на извлечение
//     уходят только страницы УПД (upd_main + upd_continuation).
//
//  2. Физически повёрнутые страницы. macOS Quartz / телефонная камера
//     нередко кладут УПД боком БЕЗ флага /Rotate в PDF — poppler рендерит
//     такую страницу повёрнутой, и Vision-модель плохо читает вертикальный
//     текст таблицы. Решение: для выбранных УПД-страниц определяем угол
//     детерминированно через Tesseract OSD и поворачиваем растр сами.
//
// ВАЖНО про двойной поворот: страницы, у которых в PDF ЕСТЬ /Rotate≠0
// (например 1697.pdf rot=270, scanlite3.pdf rot=90), poppler уже выпрямляет
// при рендере. К ним OSD НЕ применяем — иначе «доповернём» уже корректную
// страницу. Гейт строго по per-page /Rotate из pdfinfo (rot≠0 → skip OSD).
//
// Модуль намеренно самодостаточен (свой pdftoppm/pdfinfo-spawn, без импорта
// из upd-vision.parser) — чтобы не создавать циклическую зависимость
// (upd-vision.parser импортирует этот модуль).

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { computePdfRenderDpi } from './pdf-render-dpi.js';

// DPI для миниатюр под классификацию страниц. Низкий — классификатору
// (upd / сертификат / накладная) не нужно высокое разрешение, а токены и
// payload-size экономятся существенно.
const CLASSIFY_DPI = 72;

// Сколько страниц максимум рендерим/классифицируем. Защита от аномального
// PDF на сотню страниц: УПД-пакеты реально 1-8 страниц. Если УПД-страница
// окажется дальше — она просто не попадёт в классификацию (приемлемо).
const PREFILTER_MAX_CLASSIFY_PAGES = 15;

// Порог уверенности Tesseract OSD. Orientation confidence < порога —
// сигнала мало (мало текста, штампы/печати), углу не доверяем, оставляем 0.
const OSD_MIN_CONFIDENCE = 1.0;

const OSD_TIMEOUT_MS = 20_000;
const CLASSIFY_TIMEOUT_MS = 60_000;
const PDFTOPPM_TIMEOUT_MS = 75_000;
const PDFINFO_TIMEOUT_MS = 5_000;

// Знак поворота на стыке Tesseract↔Jimp. Tesseract OSD "Rotate: N" — это
// угол ПО ЧАСОВОЙ, на который надо повернуть страницу для выпрямления.
// Jimp v1 `rotate(deg)` для положительного угла вращает ПРОТИВ часовой,
// поэтому, чтобы повернуть по часовой на N, передаём (360 - N).
// ⚠️ Направление проверяется offline-тестом на фикстурах Су-10/УПД_214
// (test/upd-page-prefilter*.test.ts) с реальным tesseract: если страница
// выпрямляется в обратную сторону — поменять знак здесь.
const JIMP_POSITIVE_IS_CCW = true;

export type PageType =
  | 'upd_main'
  | 'upd_continuation'
  | 'transport_waybill'
  | 'certificate'
  | 'other';

export type PageClassification = { page: number; type: PageType; use: boolean };

export type PrefilterResult = {
  // Финальные страницы для extract: только УПД, в нормальном DPI, выпрямленные.
  pages: Buffer[];
  classification: PageClassification[];
  selectedPages: number[]; // 1-based номера выбранных страниц (параллельно pages/rotations)
  rotations: number[]; // фактически применённый угол на каждую выбранную страницу
  perPageRotateFlag: number[]; // /Rotate из PDF по всем отрендеренным страницам
  fellBack: boolean; // классификатор не нашёл УПД → откат к старому поведению
  totalPages: number; // сколько страниц отрендерили/рассмотрели
  classifyRan: boolean; // делали ли LLM-вызов классификации (single-page его пропускает)
  classifyRaw: string | null;
  classifyError: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
};

export type PrefilterOpts = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxPages: number; // верхний предел числа страниц, уходящих на extract
};

export const PAGE_CLASSIFY_PROMPT = `Ты классифицируешь страницы отсканированного пакета документов (поставка материалов).
Тебе переданы изображения страниц по порядку, перед каждым указан её номер ("Страница N:").

Определи тип КАЖДОЙ страницы и верни СТРОГО JSON-объект:
{"pages":[{"page":1,"type":"upd_main"},{"page":2,"type":"certificate"}]}

Допустимые значения type:
- "upd_main" — основная страница УПД / счёта-фактуры: заголовок «Счёт-фактура №», табличная часть с графами 1, 1а, 2..11 по форме ПП №1137, реквизиты продавца/покупателя.
- "upd_continuation" — продолжение табличной части ТОГО ЖЕ УПД на следующей странице (шапки счёта-фактуры нет, но видна продолжающаяся нумерованная таблица позиций того же документа).
- "transport_waybill" — транспортная/товарно-транспортная накладная (ТН, ТТН, форма Минтранса, разделы «Грузоотправитель», «Перевозчик», «Приём груза»).
- "certificate" — сертификат или паспорт качества/количества, декларация соответствия.
- "other" — спецификация, акт, доверенность, рукописные/прочие листы.

Правила:
- Нумеруй страницы с 1 строго в порядке переданных изображений, не пропускай ни одной.
- Страница повёрнута боком? Всё равно классифицируй по содержимому.
- Если сомневаешься между upd и не-upd — выбирай не-upd только когда явно видишь признаки накладной/сертификата; иначе считай страницу частью УПД.
- Верни ровно один JSON-объект, без markdown-ограждений и пояснений.`;

/**
 * Главный оркестратор prefilter'а. Принимает оригинальный PDF-буфер,
 * возвращает готовые к extract'у страницы (только УПД, выпрямленные) плюс
 * метаданные классификации для логирования в llm_calls.
 *
 * Никогда не бросает из-за классификации/OSD/поворота — на любой их ошибке
 * деградирует к безопасному поведению (взять первые maxPages страниц без
 * поворота), чтобы документ не потерялся. Бросить может только рендер
 * исходного PDF (pdftoppm) — это та же фатальная ситуация, что и раньше.
 */
export async function prefilterUpdPages(
  pdfBuffer: Buffer,
  opts: PrefilterOpts,
): Promise<PrefilterResult> {
  const startMs = Date.now();

  // 1. Per-page /Rotate из PDF — гейт против двойного поворота. На ошибке
  //    считаем все нули (OSD разрешён, но только для выбранных страниц).
  const perPageRotateFlag = await getPerPageRotation(pdfBuffer).catch(() => [] as number[]);

  // 2. Рендерим миниатюры всех страниц (low-DPI) для классификации.
  const thumbs = await renderPdf(pdfBuffer, {
    dpi: CLASSIFY_DPI,
    lastPage: PREFILTER_MAX_CLASSIFY_PAGES,
  });
  const totalPages = thumbs.length;

  let classification: PageClassification[] = [];
  let classifyRaw: string | null = null;
  let classifyError: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let classifyRan = false;

  // 3. Классификация. Одностраничный PDF не классифицируем — это всегда
  //    одна УПД-страница; экономим LLM-вызов.
  if (totalPages <= 1) {
    classification = [{ page: 1, type: 'upd_main', use: true }];
  } else {
    classifyRan = true;
    try {
      const c = await classifyPages({
        apiBaseUrl: opts.apiBaseUrl,
        apiKey: opts.apiKey,
        model: opts.model,
        thumbs,
      });
      classification = c.classification;
      classifyRaw = c.raw;
      promptTokens = c.promptTokens;
      completionTokens = c.completionTokens;
    } catch (err) {
      classifyError = err instanceof Error ? err.message : String(err);
      classification = [];
    }
  }

  // Классификатор успешен и которому можно доверять отбор/поворот?
  // На неуспехе (упал/таймаут) ведём себя строго как раньше: все страницы
  // (первые maxPages), без OSD-поворота — нулевая регрессия.
  const classifyFailed = classifyRan && classifyError !== null;

  // 4. Выбор страниц для extract. БЕЗОПАСНАЯ семантика: исключаем ТОЛЬКО то,
  //    что классификатор уверенно назвал сертификатом/паспортом качества или
  //    транспортной накладной. Страницы УПД, продолжения, неоднозначные
  //    ('other') и вообще НЕ упомянутые классификатором — ОСТАВЛЯЕМ. Так
  //    потерять страницу настоящего УПД можно лишь при грубой ошибке модели,
  //    а не при любой её неуверенности.
  const droppedSet = new Set(
    classification.filter((c) => DROP_TYPES.has(c.type)).map((c) => c.page),
  );
  let selectedPages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (p) => !droppedSet.has(p),
  );

  // fellBack: классификации довериться нельзя (упала) ИЛИ после исключения не
  // осталось ни одной страницы (классификатор «сошёл с ума» и всё выкинул) —
  // в обоих случаях откатываемся к прежнему поведению: первые maxPages,
  // без поворота.
  let fellBack = classifyFailed;
  if (selectedPages.length === 0) {
    fellBack = true;
    selectedPages = Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  selectedPages = selectedPages.slice(0, opts.maxPages);

  // 5. Рендер выбранных страниц в нормальном (адаптивном) DPI + авто-поворот
  //    через OSD, но ТОЛЬКО если: классификации можно доверять (не fellBack),
  //    poppler сам НЕ выпрямил страницу (perPageRotateFlag==0) и OSD уверен.
  //    Замечание о безопасности: рабочие файлы с /Rotate≠0 (1697/scanlite3)
  //    сюда не попадают; повёрнутые в обратную сторону при неверном знаке
  //    JIMP_POSITIVE_IS_CCW коснутся ТОЛЬКО физически-боковых файлов, которые
  //    и так сейчас распознаются плохо, — регрессии для рабочих файлов нет.
  const pages: Buffer[] = [];
  const rotations: number[] = [];
  for (const p of selectedPages) {
    const rendered = await renderPdf(pdfBuffer, { firstPage: p, lastPage: p });
    const base = rendered[0];
    if (!base) continue;
    let outPng: Buffer = base;
    let applied = 0;
    const popplerRot = perPageRotateFlag[p - 1] ?? 0;
    if (!fellBack && popplerRot === 0) {
      const osd = await detectRotationOsd(base).catch(() => ({ rotate: 0, confidence: 0 }));
      const norm = ((osd.rotate % 360) + 360) % 360;
      if (osd.confidence >= OSD_MIN_CONFIDENCE && norm !== 0) {
        outPng = await rotatePng(base, norm).catch(() => base);
        applied = norm;
      }
    }
    pages.push(outPng);
    rotations.push(applied);
  }

  return {
    pages,
    classification,
    selectedPages,
    rotations,
    perPageRotateFlag,
    fellBack,
    totalPages,
    classifyRan,
    classifyRaw,
    classifyError,
    promptTokens,
    completionTokens,
    latencyMs: Date.now() - startMs,
  };
}

type ClassifyArgs = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  thumbs: Buffer[];
};

type ClassifyResult = {
  classification: PageClassification[];
  raw: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
};

/**
 * Один OpenRouter Vision-вызов: классифицирует все переданные страницы.
 * Каждой миниатюре предшествует текстовая метка «Страница N:» — это даёт
 * модели надёжную привязку номера к изображению.
 */
export async function classifyPages(args: ClassifyArgs): Promise<ClassifyResult> {
  const content: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = [];
  args.thumbs.forEach((t, i) => {
    content.push({ type: 'text', text: `Страница ${i + 1}:` });
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${t.toString('base64')}` },
    });
  });
  content.push({ type: 'text', text: PAGE_CLASSIFY_PROMPT });

  const body = {
    model: args.model,
    messages: [{ role: 'user', content }],
    temperature: 0,
    max_tokens: 1024,
    response_format: { type: 'json_object' as const },
  };

  const url = `${args.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
      'HTTP-Referer': 'https://matcheck.local',
      'X-Title': 'matcheck',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`page-classify HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = json.choices?.[0]?.message?.content ?? null;
  return {
    classification: parseClassification(raw, args.thumbs.length),
    raw,
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
  };
}

// Страницы, которые БЕЗОПАСНО исключить из extract: уверенно-«чужие»
// документы внутри пакета. Всё остальное (УПД, продолжения, 'other',
// неупомянутое) сохраняем — см. безопасную семантику отбора в prefilterUpdPages.
const DROP_TYPES = new Set<PageType>(['transport_waybill', 'certificate']);
const ALL_TYPES = new Set<PageType>([
  'upd_main',
  'upd_continuation',
  'transport_waybill',
  'certificate',
  'other',
]);

/**
 * Разбирает JSON-ответ классификатора в нормализованный список. Терпим к
 * обёртке: принимает и {"pages":[...]}, и голый массив [...]. Неизвестный
 * type → 'other'. На непарсимом JSON возвращает [] (caller уйдёт в fallback).
 */
export function parseClassification(raw: string | null, totalPages: number): PageClassification[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw));
  } catch {
    return [];
  }
  const arr: unknown = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { pages?: unknown }).pages)
      ? (parsed as { pages: unknown[] }).pages
      : null;
  if (!Array.isArray(arr)) return [];

  const out: PageClassification[] = [];
  const seen = new Set<number>();
  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { page?: unknown; type?: unknown };
    const page = Number(e.page);
    if (!Number.isInteger(page) || page < 1 || page > totalPages || seen.has(page)) continue;
    const t = typeof e.type === 'string' ? (e.type as PageType) : 'other';
    const type: PageType = ALL_TYPES.has(t) ? t : 'other';
    seen.add(page);
    // use = страница ОСТАЁТСЯ в extract (исключаем только уверенно-чужие).
    out.push({ page, type, use: !DROP_TYPES.has(type) });
  }
  return out;
}

/**
 * Определяет угол поворота страницы через Tesseract OSD (`--psm 0`).
 * Возвращает rotate (угол по часовой для выпрямления, из строки "Rotate:")
 * и confidence ("Orientation confidence:"). На любой ошибке/таймауте —
 * {rotate:0, confidence:0} (не поворачиваем).
 */
export async function detectRotationOsd(
  png: Buffer,
): Promise<{ rotate: number; confidence: number }> {
  return new Promise((resolve) => {
    // `-` `-` — читать со stdin, печатать OSD в stdout. --psm 0 = только OSD.
    const proc = spawn('tesseract', ['-', '-', '--psm', '0'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    let settled = false;
    const done = (r: { rotate: number; confidence: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      done({ rotate: 0, confidence: 0 });
    }, OSD_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    proc.on('error', () => done({ rotate: 0, confidence: 0 }));
    proc.on('exit', () => {
      const rot = /Rotate:\s*(\d+)/i.exec(out);
      const conf = /Orientation confidence:\s*([\d.]+)/i.exec(out);
      done({
        rotate: rot ? Number(rot[1]) % 360 : 0,
        confidence: conf ? Number(conf[1]) : 0,
      });
    });
    proc.stdin.on('error', () => done({ rotate: 0, confidence: 0 }));
    proc.stdin.write(png);
    proc.stdin.end();
  });
}

/**
 * Поворачивает PNG на clockwiseDeg градусов ПО ЧАСОВОЙ (кратно 90).
 * 0 → возвращает исходный буфер без перекодирования.
 */
export async function rotatePng(png: Buffer, clockwiseDeg: number): Promise<Buffer> {
  const d = ((clockwiseDeg % 360) + 360) % 360;
  if (d === 0) return png;
  const img = await Jimp.read(png);
  const jimpDeg = JIMP_POSITIVE_IS_CCW ? (360 - d) % 360 : d;
  img.rotate(jimpDeg);
  return (await img.getBuffer('image/png')) as Buffer;
}

// ─── Внутренние утилиты рендера/метаданных PDF ──────────────────────────────

type RenderOpts = { dpi?: number; firstPage?: number; lastPage?: number };

/**
 * PDF→PNG через системный pdftoppm. Гибче, чем pdfToPngsViaPoppler в
 * upd-vision.parser: умеет произвольный диапазон страниц и явный DPI
 * (для миниатюр классификации). Без явного dpi — адаптивный
 * computePdfRenderDpi (как основной рендер). Бросает Error при сбое.
 */
async function renderPdf(pdfBuffer: Buffer, ropts: RenderOpts): Promise<Buffer[]> {
  const dir = await mkdtemp(join(tmpdir(), 'upd-prefilter-'));
  try {
    const inPath = join(dir, 'in.pdf');
    const outPrefix = join(dir, 'out');
    await writeFile(inPath, pdfBuffer);

    const dpi = ropts.dpi ?? (await computePdfRenderDpi(pdfBuffer));
    const args = ['-r', String(dpi), '-png'];
    if (ropts.firstPage) args.push('-f', String(ropts.firstPage));
    if (ropts.lastPage) args.push('-l', String(ropts.lastPage));
    args.push(inPath, outPrefix);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('pdftoppm', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('pdftoppm timeout (prefilter)'));
      }, PDFTOPPM_TIMEOUT_MS);
      proc.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`pdftoppm не запустился (prefilter): ${err.message}`));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`pdftoppm exit=${code} (prefilter): ${stderr.slice(0, 200)}`));
        else resolve();
      });
    });

    const files = (await readdir(dir))
      .filter((f) => /^out-\d+\.png$/.test(f))
      .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));
    const pages: Buffer[] = [];
    for (const f of files) pages.push(await readFile(join(dir, f)));
    return pages;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Per-page /Rotate из pdfinfo (`-l N`). Возвращает массив углов по индексу
 * страницы (0-based). Страница без распознанного rot → 0.
 */
export async function getPerPageRotation(pdfBuffer: Buffer): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), 'pdfinfo-rot-'));
  const path = join(dir, 'in.pdf');
  try {
    await writeFile(path, pdfBuffer);
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn('pdfinfo', ['-l', String(PREFILTER_MAX_CLASSIFY_PAGES), path], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('pdfinfo timeout'));
      }, PDFINFO_TIMEOUT_MS);
      let s = '';
      proc.stdout.on('data', (c: Buffer) => {
        s += c.toString('utf8');
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`pdfinfo exit=${code}`));
        else resolve(s);
      });
    });
    // Строки вида: "Page    1 rot:   90"
    const rotations: number[] = [];
    const re = /Page\s+(\d+)\s+rot:\s+(-?\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      const idx = Number(m[1]) - 1;
      rotations[idx] = ((Number(m[2]) % 360) + 360) % 360;
    }
    return rotations;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function stripJsonFences(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
}
