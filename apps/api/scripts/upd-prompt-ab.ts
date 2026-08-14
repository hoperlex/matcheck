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
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts --limit 5
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts --doc-kind m15 \
 *     --dir /path/to/waybills --manifest /path/to/manifest.json
 *
 * Стоит денег: три прогона по корпусу (A/A + новая версия) — это ~3 LLM-вызова
 * на файл. Для черновых проверок используйте --limit.
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
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { and, eq } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { db } from '../src/db/client.js';
import { prompts } from '../src/db/schema.js';
import { parseUpdPdf, extractUpdFromText } from '../src/domain/edo/upd-pdf.parser.js';
import { parseUpdVision } from '../src/domain/edo/upd-vision.parser.js';
import {
  countUniqueUpdInvoices,
  segmentUpdText,
} from '../src/domain/edo/upd-text-bundle.parser.js';
import type { PromptOverride } from '../src/domain/prompts/registry.js';
import {
  compareUnit,
  evaluateGate,
  matchExpectation,
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

  const res = await parseUpdPdf(buffer, ctx);
  return [
    {
      key: entry.filename,
      parsed: res.parsed,
      consigneeFromModel: !(res.partiesFilledFromText ?? []).includes('consignee'),
    },
  ];
}

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
  const dir = resolve(argValue('--dir') ?? join(process.cwd(), '../../docs/debug-upd'));
  const manifestPath = resolve(
    argValue('--manifest') ?? join(process.cwd(), 'scripts/corpus-manifest.json'),
  );
  const baseName = argValue('--base', DEFAULT_PROMPTS[docKind].base)!;
  const newName = argValue('--new', DEFAULT_PROMPTS[docKind].fresh)!;
  const limitRaw = argValue('--limit');
  const limit = limitRaw ? Number(limitRaw) : Infinity;

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: ManifestEntry[] };
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
  const work = selected.slice(0, Number.isFinite(limit) ? limit : undefined);

  console.log(`[ab] тип документа: ${docKind}`);
  console.log(`[ab] корпус: ${dir}`);
  console.log(`[ab] файлов в манифесте: ${all.length}; в сверке: ${work.length}`);
  // Пропущенное печатаем всегда: «прогнали корпус» не должно означать
  // «прогнали половину корпуса и промолчали».
  for (const s of skipped) console.log(`[ab] пропущен: ${s}`);
  if (work.length < selected.length) {
    console.log(`[ab] --limit: из ${selected.length} подходящих взято ${work.length}`);
  }
  const withoutExpectation = work.filter((e) => !e.expectedDocuments?.length);
  if (withoutExpectation.length > 0) {
    console.log(
      `[ab] БЕЗ ЭТАЛОНА (${withoutExpectation.length}): грузополучатель у них не проверяется,` +
        ' они работают только на анти-регресс. Заполните expectedDocuments в манифесте.',
    );
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

  const regressed = comparisons.filter((c) => c.changed.length > 0);
  if (regressed.length > 0) {
    console.log(`\nРЕГРЕСС: изменились стабильные поля (${regressed.length} документов):`);
    for (const c of regressed) console.log(`  ${c.label}: ${c.changed.join(', ')}`);
  }

  const shifted = comparisons.filter((c) => c.confidenceShift);
  if (shifted.length > 0) {
    console.log(`\nCONFIDENCE ПЕРЕСЁК ПОРОГ (меняется маршрут документа):`);
    for (const c of shifted) console.log(`  ${c.label}: ${c.confidenceShift}`);
  }

  const expectationProblems = comparisons.filter(
    (c) => c.expectation.status === 'mismatch' || c.expectation.status === 'filled_from_text',
  );
  if (expectationProblems.length > 0) {
    console.log(`\nГРУЗОПОЛУЧАТЕЛЬ — ПРОБЛЕМЫ (${expectationProblems.length}):`);
    for (const c of expectationProblems) {
      const detail = 'detail' in c.expectation ? c.expectation.detail : '';
      console.log(`  ${c.label}: ${detail}`);
    }
  }

  const okConsignee = comparisons.filter((c) => c.expectation.status === 'ok').length;
  console.log(`\nГрузополучатель совпал с эталоном (от модели): ${okConsignee}`);

  const blockers = evaluateGate({
    checkedUnits: comparisons.length,
    failures,
    comparisons,
  });

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
