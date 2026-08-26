/**
 * Сверка двух версий промпта распознавания на корпусе документов.
 *
 * Зачем. Новая версия промпта добавляет одно поле — грузополучателя. Но
 * промпт — это текст для модели: даже безобидная строка может сдвинуть разбор
 * номеров, дат, сумм и позиций. Активировать «на глазок» — значит проверять
 * его на боевых документах пользователей. Скрипт прогоняет обе версии по
 * одному корпусу и показывает, что именно изменилось.
 *
 * Как отделяется шум модели. Температура у провайдера ненулевая, поэтому два
 * одинаковых запроса могут дать разный ответ. Сначала делается A/A — два
 * прогона базовой версии подряд; поля, разошедшиеся уже там, объявляются
 * нестабильными. Всё, что в A/A совпало, обязано совпасть и у новой версии.
 * ИСКЛЮЧЕНИЕ: нестабильность критических полей (номер, дата, позиции, стороны)
 * не прощается — если база не воспроизводит сама себя по номеру документа,
 * сравнивать её с новой версией бессмысленно (см. isCriticalKey).
 *
 * Что ещё проверяется, кроме «поле непустое»:
 *   * снимок сравнивается с точностью ХРАНЕНИЯ (qty/price — 4 знака, massKg —
 *     3, суммы — 2, confidence — 3), иначе расхождение в четвёртом знаке
 *     невидимо, а в БД оно поедет;
 *   * confidence и его переходы через 0.5 / 0.6 — это развилки маршрута
 *     документа (второй проход, дедуп, автоподрядчик), а не отчётное число;
 *   * грузополучатель засчитывается новой версии, ТОЛЬКО если пришёл от
 *     модели: текстовый путь дозаполняет стороны регулярками, и они работают
 *     одинаково на обеих версиях (partiesFilledFromText);
 *   * пакеты из нескольких УПД сверяются ПОСУБДОКУМЕНТНО — грузополучатель у
 *     одного из пятнадцати не должен выглядеть успехом;
 *   * значения сверяются с эталоном expectedDocuments из манифеста, а не с
 *     фактом непустоты.
 *
 * Запуск локально:
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts --limit 5 --details
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts --doc-kind m15 \
 *     --dir /path/to/waybills --manifest /path/to/manifest.json
 *
 * ЧАСТЯМИ (так гоняют полный корпус, чтобы не долбить провайдера очередью
 * запросов). Окно задаётся парой --offset/--limit, пауза --delay ставится перед
 * КАЖДЫМ вызовом модели, отчёт каждой части пишется своим файлом:
 *   … --base "default v13" --new "default v15" \
 *     --offset 0 --limit 5 --delay 2000 --out /tmp/ab-00.json
 *   … --offset 5 --limit 5 --delay 2000 --out /tmp/ab-05.json
 * Скрипт сам печатает `--offset` следующей части. Свести части в один вердикт:
 *   pnpm --filter @matcheck/api exec tsx scripts/prompt-ab-merge.ts /tmp/ab-*.json
 * Отдельные части вердиктом НЕ являются: гейт считается по всему корпусу.
 *
 * Запуск на сервере (промпты и ключ модели живут только там). Корпус в образ
 * НЕ входит — Dockerfile копирует apps/api и packages/contracts, поэтому
 * `docker exec matcheck-api …` падает с ENOENT на /app/docs/debug-upd. Папку
 * надо смонтировать и указать через --dir:
 *   cd /srv/matcheck/app
 *   docker compose -f infra/docker-compose.prod.yml run --rm \
 *     -v /srv/matcheck/app/docs/debug-upd:/corpus:ro \
 *     matcheck-api node_modules/.bin/tsx scripts/upd-prompt-ab.ts \
 *     --base "default v13" --new "default v14" --limit 5 --dir /corpus
 * `run --rm` берёт тот же образ и env_file, но не публикует порт — работающий
 * API не затрагивается. При EACCES на /corpus добавить --user root.
 *
 * Флаг --details печатает значения изменившихся полей («было → стало»): без
 * них список имён не отвечает, улучшение это или регресс.
 *
 * Стоит денег: три прогона по корпусу (A/A + новая версия) — это ~3 LLM-вызова
 * на файл, а на пакет из N УПД — 3N. Для черновых проверок используйте --limit.
 *
 * Отчёт --out пишет то, без чего прогон невоспроизводим: идентификаторы и хеши
 * ОБЕИХ версий промпта, хеш манифеста, git SHA, границы окна и — главное —
 * фактическую модель каждого вызова. Последнее не формальность: при ошибке
 * текстовый путь молча уходит к следующему провайдеру, и тогда отчёт сравнивает
 * не два промпта, а две модели. Скрипт предупреждает об этом отдельной строкой.
 *
 * НЕ пишет в source_documents и не меняет активный промпт: читает промпты из
 * таблицы prompts, гоняет парсеры с явным promptOverride и печатает отчёт.
 * Строки в llm_calls при этом появляются (с source_document_id = NULL) — это
 * журнал вызовов, на разбор документов он не влияет, но SQL-отчёты по журналу
 * после активации фильтруйте по `source_document_id IS NOT NULL`.
 *
 * Чего скрипт НЕ делает: не активирует промпт (это вручную в Администрирование
 * → Промпты после зелёного отчёта) и не проверяет Excel-документы через LLM —
 * их структурный парсер промпт не использует вовсе.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { and, eq, gte, isNull } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { db } from '../src/db/client.js';
import { llmCalls, llmProviders, prompts } from '../src/db/schema.js';
import { parseUpdPdf, extractUpdFromText } from '../src/domain/edo/upd-pdf.parser.js';
import { parseUpdVision } from '../src/domain/edo/upd-vision.parser.js';
import {
  countUniqueUpdInvoices,
  segmentUpdText,
} from '../src/domain/edo/upd-text-bundle.parser.js';
import type { PromptOverride } from '../src/domain/prompts/registry.js';
import {
  compareUnit,
  newMoneyMismatches,
  evaluateGate,
  matchExpectation,
  mixedModelPrompts,
  parseIntArg,
  windowOf,
  type ExpectedDocument,
  type UnitComparison,
} from './prompt-ab-lib.js';

type DocKind = 'upd' | 'm15';

type ManifestEntry = {
  filename: string;
  kind: string;
  parsePath: 'vision' | 'text_pdf' | 'multi_upd' | 'excel';
  hasConsignee: boolean | null;
  source: string;
  /**
   * Эталон: что напечатано в документе. Заполняется руками у записей
   * source: "manual" — генератор манифеста их не перезаписывает. Массив,
   * потому что в одном файле может лежать несколько логических УПД.
   */
  expectedDocuments?: ExpectedDocument[];
};

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const DEFAULT_PROMPTS: Record<DocKind, { base: string; fresh: string }> = {
  upd: { base: 'default v8', fresh: 'default v9' },
  m15: { base: 'default v1', fresh: 'default v2' },
};

function argValue(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** Целочисленный аргумент со строгой проверкой (правило — в prompt-ab-lib). */
function argNumber(flag: string, fallback: number): number {
  return parseIntArg(argValue(flag), flag, fallback);
}

/**
 * Пауза ПЕРЕД КАЖДЫМ вызовом модели.
 *
 * Именно перед вызовом, а не между файлами: на файл приходится от одного до N
 * запросов — пакет из пятнадцати УПД даёт пятнадцать вызовов подряд, и пауза
 * на уровне файла плотность почти не снижает. Отсчёт ведётся от момента
 * предыдущего вызова, поэтому время самого запроса засчитывается в паузу и
 * медленные ответы её не удваивают.
 */
let callDelayMs = 0;
let lastCallStartedAt = 0;

async function throttle(): Promise<void> {
  if (callDelayMs <= 0) return;
  const wait = lastCallStartedAt + callDelayMs - Date.now();
  if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  lastCallStartedAt = Date.now();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Отпечаток рабочего дерева.
 *
 * Отчёт должен отвечать на вопрос «что именно прогоняли». Без SHA двухнедельной
 * давности отчёт неотличим от сегодняшнего, а промпт с тех пор мог поменяться
 * вместе с кодом парсеров. `dirty` — незакоммиченные правки в рабочей копии.
 */
function gitRevision(): { sha: string | null; dirty: boolean | null } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { sha, dirty: status.length > 0 };
  } catch {
    // В прод-образе .git отсутствует — это не ошибка прогона, но и молчать
    // нельзя: null в отчёте честнее выдуманного значения.
    return { sha: null, dirty: null };
  }
}

async function loadPrompt(docKind: DocKind, name: string): Promise<{ id: string; content: string }> {
  const [row] = await db
    .select({ id: prompts.id, content: prompts.content })
    .from(prompts)
    .where(and(eq(prompts.docKind, docKind), eq(prompts.name, name)))
    .limit(1);
  if (!row) throw new Error(`Промпт «${name}» (doc_kind=${docKind}) не найден в таблице prompts`);
  return row;
}

/** Один логический документ одного прогона. */
type Unit = {
  /** Ключ сопоставления между прогонами: имя файла или «файл#номер». */
  key: string;
  parsed: UpdPdfParsed;
  /** false — грузополучателя дозаполнили регулярки, а не модель. */
  consigneeFromModel: boolean;
};

/** Постраничный текст PDF — вход сегментатора пакетов. */
async function pdfPages(buffer: Buffer): Promise<{ num: number; text: string }[]> {
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return (result.pages ?? []).map((p) => ({
      num: typeof p.num === 'number' ? p.num : 0,
      text: p.text ?? '',
    }));
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function cleanPdfText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Один прогон одного файла тем же путём, что и прод, но с разбивкой результата
 * на логические документы.
 *
 * Пауза (--delay) ставится перед каждым запросом, который делает САМ скрипт.
 * Вызовы, спрятанные внутри парсера — классификатор страниц prefilter и
 * транзиентный ретрай vision, — ею не покрыты: лезть ради скрипта в боевой путь
 * распознавания опаснее, чем недосчитать пару запросов в паузе.
 *
 * Пакеты (multi_upd) НЕ гоняются через tryParseTextUpdBundle: он возвращает
 * свёрнутый агрегат и теряет partiesFilledFromText, то есть на нём невозможно
 * отличить грузополучателя от модели от дозаполненного регулярками. Вместо
 * этого повторяем его собственные шаги — segmentUpdText + extractUpdFromText на
 * каждый сегмент, ровно как он делает внутри.
 */
async function runOne(
  entry: ManifestEntry,
  buffer: Buffer,
  override: PromptOverride,
  docKind: DocKind,
): Promise<Unit[]> {
  const ctx = { sourceDocumentId: null, promptOverride: override };

  if (entry.parsePath === 'vision') {
    const mime = MIME_BY_EXT[extname(entry.filename).toLowerCase()] ?? 'application/pdf';
    await throttle();
    const res = await parseUpdVision({ buffer, mimeType: mime }, { ...ctx, promptDocKind: docKind });
    // На vision-пути regex-дозаполнения нет вовсе: всё, что есть в ответе, —
    // от модели.
    return [{ key: entry.filename, parsed: res.parsed, consigneeFromModel: true }];
  }

  if (entry.parsePath === 'multi_upd') {
    const pages = await pdfPages(buffer);
    if (countUniqueUpdInvoices(pages) >= 2) {
      const segments = segmentUpdText(pages);
      const units: Unit[] = [];
      for (const seg of segments) {
        await throttle();
        const r = await extractUpdFromText(cleanPdfText(seg.text), ctx);
        units.push({
          key: `${entry.filename}#${seg.docNumber}`,
          parsed: r.parsed,
          consigneeFromModel: !r.partiesFilledFromText.includes('consignee'),
        });
      }
      return units;
    }
    // Не сложился как пакет — прод в этом случае идёт обычным одиночным путём.
  }

  await throttle();
  const res = await parseUpdPdf(buffer, ctx);
  return [
    {
      key: entry.filename,
      parsed: res.parsed,
      consigneeFromModel: !(res.partiesFilledFromText ?? []).includes('consignee'),
    },
  ];
}

/**
 * Фактические вызовы модели, сделанные этим прогоном.
 *
 * Зачем это в отчёте. Текстовый путь молча переходит на следующего провайдера
 * при ошибке (см. extractUpdFromText), а vision берёт провайдера по признаку
 * «основной». Значит две версии промпта могли уехать в РАЗНЫЕ модели, и тогда
 * отчёт сравнивает не промпты. Без записи модели этого не увидеть никогда.
 *
 * Отбор по `source_document_id IS NULL`: так помечены вызовы скриптов — боевой
 * разбор всегда указывает документ.
 */
async function collectCalls(since: Date): Promise<CallRecord[]> {
  const rows = await db
    .select({
      id: llmCalls.id,
      createdAt: llmCalls.createdAt,
      promptId: llmCalls.promptId,
      providerId: llmCalls.providerId,
      docKind: llmCalls.docKind,
      model: llmCalls.model,
      errorCode: llmCalls.errorCode,
      latencyMs: llmCalls.latencyMs,
      providerName: llmProviders.name,
    })
    .from(llmCalls)
    .leftJoin(llmProviders, eq(llmProviders.id, llmCalls.providerId))
    .where(and(isNull(llmCalls.sourceDocumentId), gte(llmCalls.createdAt, since)))
    .orderBy(llmCalls.createdAt);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    promptId: r.promptId,
    providerId: r.providerId,
    providerName: r.providerName,
    docKind: r.docKind,
    model: r.model,
    errorCode: r.errorCode,
    latencyMs: r.latencyMs,
  }));
}

type CallRecord = {
  id: string;
  createdAt: string;
  promptId: string | null;
  providerId: string | null;
  providerName: string | null;
  docKind: string | null;
  model: string | null;
  errorCode: string | null;
  latencyMs: number | null;
};

/** Сопоставляет прогоны по ключу документа; расхождение состава — ошибка. */
function alignUnits(a1: Unit[], a2: Unit[], b: Unit[]): { key: string; a1: Unit; a2: Unit; b: Unit }[] {
  const byKey = (units: Unit[]) => new Map(units.map((u) => [u.key, u]));
  const m1 = byKey(a1);
  const m2 = byKey(a2);
  const mb = byKey(b);
  const out: { key: string; a1: Unit; a2: Unit; b: Unit }[] = [];
  for (const [key, u1] of m1) {
    const u2 = m2.get(key);
    const ub = mb.get(key);
    if (!u2 || !ub) continue;
    out.push({ key, a1: u1, a2: u2, b: ub });
  }
  return out;
}

async function main(): Promise<void> {
  const docKind = (argValue('--doc-kind', 'upd') ?? 'upd') as DocKind;
  if (docKind !== 'upd' && docKind !== 'm15') {
    throw new Error(`--doc-kind: ожидается upd или m15, получено «${docKind}»`);
  }
  // Значения изменившихся полей: без них список имён не отвечает на вопрос
  // «стало лучше или хуже» — а именно это и решается перед активацией.
  const details = process.argv.includes('--details');
  const dir = resolve(argValue('--dir') ?? join(process.cwd(), '../../docs/debug-upd'));
  const manifestPath = resolve(
    argValue('--manifest') ?? join(process.cwd(), 'scripts/corpus-manifest.json'),
  );
  const baseName = argValue('--base', DEFAULT_PROMPTS[docKind].base)!;
  const newName = argValue('--new', DEFAULT_PROMPTS[docKind].fresh)!;
  // Окно прогона. Корпус гоняется частями, поэтому нужен именно сдвиг:
  // одного --limit хватает только на «первые N», и части пересекались бы.
  const offset = argNumber('--offset', 0);
  const limit = argNumber('--limit', Number.MAX_SAFE_INTEGER);
  callDelayMs = argNumber('--delay', 0);
  const outPath = argValue('--out');
  const planOnly = process.argv.includes('--plan');
  const startedAt = new Date();

  const manifestRaw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as { entries: ManifestEntry[] };
  const all = manifest.entries ?? [];

  // Отбор: только нужный тип документа и только пути, где промпт участвует.
  const skipped: string[] = [];
  const selected: ManifestEntry[] = [];
  for (const e of all) {
    if (e.kind !== docKind) {
      skipped.push(`${e.filename} — kind=${e.kind}, промпт ${docKind} не применяется`);
      continue;
    }
    if (e.parsePath === 'excel') {
      // Структурный парсер Excel не использует промпт; vision подключается
      // только как fallback на неполном разборе. Гонять их здесь — платить за
      // вызовы, которые ничего не проверяют.
      skipped.push(`${e.filename} — excel, разбирается структурно, без промпта`);
      continue;
    }
    selected.push(e);
  }
  const work = windowOf(selected, offset, limit);

  console.log(`[ab] тип документа: ${docKind}`);
  console.log(`[ab] корпус: ${dir}`);
  console.log(`[ab] файлов в манифесте: ${all.length}; в сверке: ${work.length}`);
  // Пропущенное печатаем всегда: «прогнали корпус» не должно означать
  // «прогнали половину корпуса и промолчали».
  for (const s of skipped) console.log(`[ab] пропущен: ${s}`);
  if (work.length < selected.length) {
    const to = offset + work.length;
    console.log(
      `[ab] окно: из ${selected.length} подходящих взяты ${offset + 1}..${to} (${work.length} шт.)`,
    );
    if (to < selected.length) {
      console.log(`[ab] следующая часть: --offset ${to}`);
    }
  }
  if (work.length === 0) {
    // Пустое окно молча даёт «регрессий нет» на нуле документов — то есть
    // выглядит как разрешение активировать. Гейт это ловит, но сказать надо
    // здесь и прямо: скорее всего, --offset ушёл за конец списка.
    console.log(`[ab] ВНИМАНИЕ: окно пустое (--offset ${offset} при ${selected.length} подходящих)`);
  }
  if (callDelayMs > 0) {
    console.log(`[ab] пауза между вызовами модели: ${callDelayMs} мс`);
  }
  // «Пустая графа 4» — тоже утверждение, и оно проверяется; без эталона
  // остаются только записи, где не сказано вообще ничего.
  const withoutExpectation = work.filter(
    (e) => !e.expectedDocuments?.length && e.hasConsignee !== false,
  );
  if (withoutExpectation.length > 0) {
    console.log(
      `[ab] БЕЗ ЭТАЛОНА (${withoutExpectation.length}): грузополучатель у них не проверяется,` +
        ' они работают только на анти-регресс. Заполните expectedDocuments в манифесте.',
    );
  }
  const emptyGraph = work.filter((e) => e.hasConsignee === false);
  if (emptyGraph.length > 0) {
    console.log(
      `[ab] графа 4 пуста по манифесту (${emptyGraph.length}): проверяем, что модель ничего не выдумала.`,
    );
  }

  // ── сухой прогон: сколько это будет стоить ──
  //
  // Без него окно «пять файлов» — обманчивая мера. Пакет из пятнадцати УПД в
  // одном PDF даёт пятнадцать вызовов на прогон, то есть сорок пять на файл, и
  // попадает в окно незаметно. Здесь считается точно: сегменты пакетов
  // определяются по тексту, без единого обращения к модели.
  if (planOnly) {
    let total = 0;
    console.log('\n[ab] план прогона (вызовов модели не будет):');
    for (const [i, entry] of work.entries()) {
      let docs = 1;
      if (entry.parsePath === 'multi_upd') {
        const pages = await pdfPages(await readFile(join(dir, entry.filename)));
        docs = countUniqueUpdInvoices(pages) >= 2 ? segmentUpdText(pages).length : 1;
      }
      const calls = docs * 3;
      total += calls;
      const mark = docs > 1 ? `  ← ПАКЕТ из ${docs} УПД` : '';
      console.log(`  ${offset + i}: ${entry.filename} — ${calls} вызовов${mark}`);
    }
    console.log(`[ab] ИТОГО в этом окне: ${total} вызовов модели (три прогона на документ)`);
    if (total > 30) {
      console.log('[ab] ВНИМАНИЕ: окно тяжёлое. Разбейте его меньшим --limit,');
      console.log('     иначе запросы пойдут длинной очередью подряд.');
    }
    return;
  }

  const base = await loadPrompt(docKind, baseName);
  const fresh = await loadPrompt(docKind, newName);
  console.log(`[ab] база: «${baseName}», новый: «${newName}», температура: 0`);

  const comparisons: UnitComparison[] = [];
  const failures: { file: string; error: string }[] = [];

  for (const entry of work) {
    const buffer = await readFile(join(dir, entry.filename));
    process.stdout.write(`[ab] ${entry.filename} (${entry.parsePath}) … `);

    let a1: Unit[];
    let a2: Unit[];
    let b: Unit[];
    try {
      a1 = await runOne(entry, buffer, { prompt: base, temperature: 0 }, docKind);
      a2 = await runOne(entry, buffer, { prompt: base, temperature: 0 }, docKind);
      b = await runOne(entry, buffer, { prompt: fresh, temperature: 0 }, docKind);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('ОШИБКА');
      failures.push({ file: entry.filename, error: msg });
      continue;
    }

    const aligned = alignUnits(a1, a2, b);
    if (aligned.length !== a1.length || aligned.length !== b.length) {
      // Состав логических документов разъехался между прогонами — это само по
      // себе регресс: пакет распался иначе.
      console.log('РАЗНЫЙ СОСТАВ ДОКУМЕНТОВ');
      failures.push({
        file: entry.filename,
        error: `состав документов различается между прогонами: A/A ${a1.length}/${a2.length}, новый ${b.length}`,
      });
      continue;
    }

    const fileComparisons = aligned.map((pair, index) =>
      compareUnit({
        label: pair.key,
        a1: pair.a1.parsed,
        a2: pair.a2.parsed,
        b: pair.b.parsed,
        consigneeFromModel: pair.b.consigneeFromModel,
        expected: matchExpectation(pair.b.parsed, index, entry.expectedDocuments),
        // Документы с пустой графой 4 проверяются от обратного: модель не
        // должна выдумать сторону там, где её нет.
        hasConsignee: entry.hasConsignee,
      }),
    );
    comparisons.push(...fileComparisons);

    const changed = fileComparisons.reduce((n, c) => n + c.changed.length, 0);
    const okConsignee = fileComparisons.filter((c) => c.expectation.status === 'ok').length;
    console.log(
      (changed === 0 ? 'ок' : `РАСХОЖДЕНИЯ (${changed})`) +
        (aligned.length > 1 ? `, документов: ${aligned.length}` : '') +
        (okConsignee > 0 ? `, грузополучатель по эталону: ${okConsignee}` : ''),
    );
  }

  console.log('\n──────── итог ────────');
  console.log(`Логических документов проверено: ${comparisons.length}`);

  if (failures.length > 0) {
    console.log(`\nНЕ РАЗОБРАЛИСЬ (${failures.length}) — проверьте вручную:`);
    for (const f of failures) console.log(`  ${f.file}: ${f.error}`);
  }

  const unstable = comparisons.filter((c) => c.unstable.length > 0);
  if (unstable.length > 0) {
    console.log(`\nНЕСТАБИЛЬНЫЕ ПОЛЯ (разошлись между двумя прогонами базы):`);
    for (const c of unstable) {
      const critical = c.unstableCritical.length > 0 ? ' ← КРИТИЧЕСКИЕ' : '';
      console.log(`  ${c.label}: ${c.unstable.join(', ')}${critical}`);
    }
  }

  const critical = comparisons.filter((c) => c.changedCritical.length > 0);
  if (critical.length > 0) {
    console.log(`\nРЕГРЕСС КРИТИЧЕСКИХ ПОЛЕЙ (${critical.length} документов) — это блокирует выкат:`);
    for (const c of critical) {
      const keys = new Set(c.changedCritical);
      if (details) {
        console.log(`  ${c.label}:`);
        for (const d of c.changedDetails.filter((d) => keys.has(d.key))) {
          console.log(`      ${d.key}: ${d.from} → ${d.to}`);
        }
      } else {
        console.log(`  ${c.label}: ${c.changedCritical.join(', ')}`);
      }
    }
    if (!details) console.log('  (значения полей — с флагом --details)');
  }

  // Оценочные поля печатаются отдельно и выкат не держат: это масса, объём,
  // категория и уверенность — они меняются от любой правки промпта.
  const soft = comparisons
    .map((c) => ({ c, keys: new Set(c.changed.filter((k) => !c.changedCritical.includes(k))) }))
    .filter(({ keys }) => keys.size > 0);
  if (soft.length > 0) {
    console.log(`\nизменились оценочные поля (${soft.length} документов) — не блокирует:`);
    for (const { c, keys } of soft) {
      if (details) {
        console.log(`  ${c.label}:`);
        for (const d of c.changedDetails.filter((d) => keys.has(d.key))) {
          console.log(`      ${d.key}: ${d.from} → ${d.to}`);
        }
      } else {
        console.log(`  ${c.label}: ${[...keys].join(', ')}`);
      }
    }
  }

  const shifted = comparisons.filter((c) => c.confidenceShift);
  if (shifted.length > 0) {
    console.log(`\nCONFIDENCE ПЕРЕСЁК ПОРОГ (меняется маршрут документа):`);
    for (const c of shifted) console.log(`  ${c.label}: ${c.confidenceShift}`);
  }

  const moneyProblems = comparisons.filter((c) => c.moneyMismatches.length > 0);
  if (moneyProblems.length > 0) {
    console.log(`\nСУММЫ — РАСХОЖДЕНИЯ С ЭТАЛОНОМ (${moneyProblems.length}):`);
    for (const c of moneyProblems) {
      const fresh = new Set(newMoneyMismatches(c).map((m) => `${m.where}|${m.detail}`));
      for (const m of c.moneyMismatches) {
        // «было и в базе» — дефект существует на активном промпте прямо сейчас.
        // Такое не блокирует выкат новой версии, но и молчать о нём нельзя.
        const mark = fresh.has(`${m.where}|${m.detail}`) ? 'НОВОЕ' : 'было и в базе';
        console.log(`  ${c.label} — ${m.where}: ${m.detail} [${mark}]`);
      }
    }
  }

  const expectationProblems = comparisons.filter(
    (c) => c.expectation.status === 'mismatch' || c.expectation.status === 'filled_from_text',
  );
  if (expectationProblems.length > 0) {
    console.log(`\nГРУЗОПОЛУЧАТЕЛЬ — ПРОБЛЕМЫ (${expectationProblems.length}):`);
    for (const c of expectationProblems) {
      const detail = 'detail' in c.expectation ? c.expectation.detail : '';
      const mark = c.baseExpectation.status === c.expectation.status ? 'было и в базе' : 'НОВОЕ';
      console.log(`  ${c.label}: ${detail} [${mark}]`);
    }
  }

  const okConsignee = comparisons.filter((c) => c.expectation.status === 'ok').length;
  console.log(`\nГрузополучатель совпал с эталоном (от модели): ${okConsignee}`);

  const blockers = evaluateGate({
    checkedUnits: comparisons.length,
    failures,
    comparisons,
  });

  // Фактические модели прогона. Если их больше одной на версию промпта —
  // сравнение недостоверно: часть вызовов ушла к другому провайдеру, и разница
  // в отчёте может объясняться моделью, а не текстом промпта.
  const calls = await collectCalls(startedAt);
  const mixed = [...mixedModelPrompts(calls).entries()];
  if (mixed.length > 0) {
    console.log('\nОДИН ПРОМПТ ОБСЛУЖИВАЛИ РАЗНЫЕ МОДЕЛИ — сравнение недостоверно:');
    for (const [promptId, models] of mixed) {
      const which = promptId === base.id ? baseName : promptId === fresh.id ? newName : promptId;
      console.log(`  ${which}: ${models.join(', ')}`);
    }
    console.log('  Часть вызовов ушла к другому провайдеру (fallback при ошибке).');
    console.log('  Разница в отчёте может объясняться моделью, а не текстом промпта.');
  }
  const failedCalls = calls.filter((c) => c.errorCode != null);
  if (failedCalls.length > 0) {
    console.log(`\nвызовов с ошибкой за прогон: ${failedCalls.length} (учтены в отчёте --out)`);
  }

  if (outPath) {
    const report = {
      formatVersion: 1 as const,
      docKind,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      // Окно: по нему агрегатор проверяет, что части не пересеклись и ничего
      // не пропустили.
      window: { offset, limit, selected: selected.length, taken: work.length },
      files: work.map((e) => e.filename),
      corpus: { dir, manifestPath, manifestSha256: sha256(manifestRaw), entries: all.length },
      git: gitRevision(),
      prompts: {
        base: { name: baseName, id: base.id, sha256: sha256(base.content), length: base.content.length },
        fresh: { name: newName, id: fresh.id, sha256: sha256(fresh.content), length: fresh.content.length },
      },
      calls,
      failures,
      comparisons,
      blockers,
    };
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`\nотчёт сохранён: ${resolve(outPath)}`);
  }

  // Смешение моделей блокирует наравне с регрессом. Вердикт «активировать
  // можно» означает «мы измерили эффект промпта»; если половина вызовов ушла к
  // другой модели, эффект не измерен, и мягкое предупреждение здесь означало бы
  // разрешение выкатывать непроверенное.
  if (mixed.length > 0) {
    blockers.push(`один промпт обслуживали разные модели: ${mixed.length}`);
  }

  if (blockers.length > 0) {
    console.log(`\nАКТИВИРОВАТЬ «${newName}» НЕЛЬЗЯ — ${blockers.join('; ')}.`);
    console.log('Сначала разберитесь с перечисленным выше.');
    process.exitCode = 1;
  } else {
    console.log('\nРегрессий нет: все поля, стабильные у базы, совпали с новой версией.');
    console.log('Критические поля стабильны, confidence не пересёк пороги 0.5 / 0.6.');
    console.log(
      `Осталось глазами сверить несколько документов — и можно активировать «${newName}»` +
        ' в Администрирование → Промпты.',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$client.end({ timeout: 5 });
  });
