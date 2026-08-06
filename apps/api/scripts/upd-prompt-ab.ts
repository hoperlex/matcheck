/**
 * Сверка двух версий УПД-промпта на корпусе docs/debug-upd.
 *
 * Зачем. Новая версия промпта (v9) добавляет одно поле — грузополучателя. Но
 * промпт — это текст для модели: даже безобидная строка может сдвинуть разбор
 * номеров, дат, сумм и позиций. Активировать v9 «на глазок» — значит проверять
 * его на боевых документах пользователей. Скрипт прогоняет обе версии по
 * одному корпусу и показывает, что именно изменилось.
 *
 * Как отделяется шум модели. Температура у провайдера ненулевая, поэтому два
 * одинаковых запроса могут дать разный ответ. Сначала делается A/A — два
 * прогона v8 подряд; поля, разошедшиеся уже там, объявляются нестабильными и
 * из критерия исключаются (выводятся отдельным списком). Всё, что в A/A
 * совпало, обязано совпасть и в v9.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts --limit 5
 *   pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts --new "default v9" --base "default v8"
 *
 * Стоит денег: три прогона по корпусу (A/A + v9) — это ~3 LLM-вызова на файл.
 * Для черновых проверок используйте --limit.
 *
 * НЕ пишет в source_documents и не меняет активный промпт: читает промпты из
 * таблицы prompts, гоняет парсеры с явным promptOverride и печатает отчёт.
 * Строки в llm_calls при этом появляются — это журнал вызовов, он на разбор
 * документов не влияет.
 *
 * Чего скрипт НЕ делает: не активирует v9 (это вручную в Администрирование →
 * Промпты после зелёного отчёта) и не проверяет Excel-документы через LLM —
 * их структурный парсер промпт не использует вовсе (см. ниже про excel).
 */
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { db } from '../src/db/client.js';
import { prompts } from '../src/db/schema.js';
import { parseUpdPdf } from '../src/domain/edo/upd-pdf.parser.js';
import { parseUpdVision } from '../src/domain/edo/upd-vision.parser.js';
import { tryParseTextUpdBundle } from '../src/domain/edo/upd-text-bundle.parser.js';
import type { PromptOverride } from '../src/domain/prompts/registry.js';

type ManifestEntry = {
  filename: string;
  kind: string;
  parsePath: 'vision' | 'text_pdf' | 'multi_upd' | 'excel';
  hasConsignee: boolean | null;
  source: string;
};

const MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function argValue(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** Нормализованный снимок разбора: то, что сравнивается между прогонами. */
type Snapshot = Record<string, string>;

function num(v: number | null | undefined): string {
  if (v == null) return '∅';
  // Округление до копеек: 1234.5600000001 и 1234.56 — это одно и то же число.
  return (Math.round(v * 100) / 100).toFixed(2);
}

function str(v: string | null | undefined): string {
  if (v == null) return '∅';
  return v.replace(/\s+/g, ' ').trim().toLowerCase();
}

function snapshotOf(p: UpdPdfParsed): Snapshot {
  const s: Snapshot = {
    docNumber: str(p.docNumber),
    docDate: str(p.docDate),
    totalSum: num(p.totalSum),
    vatSum: num(p.vatSum),
    itemsCount: p.itemsCount == null ? '∅' : String(p.itemsCount),
    'supplier.inn': str(p.supplier?.inn),
    'supplier.kpp': str(p.supplier?.kpp),
    'supplier.name': str(p.supplier?.name),
    'recipient.inn': str(p.recipient?.inn),
    'recipient.kpp': str(p.recipient?.kpp),
    'recipient.name': str(p.recipient?.name),
    'consignee.inn': str(p.consignee?.inn),
    'consignee.kpp': str(p.consignee?.kpp),
    'consignee.name': str(p.consignee?.name),
    'items.length': String(p.items.length),
  };
  // Позиции целиком, а не только их количество: перепутанные цена и сумма или
  // съехавшее наименование при равной длине массива иначе прошли бы незаметно.
  p.items.forEach((it, i) => {
    s[`items[${i}].nameRaw`] = str(it.nameRaw);
    s[`items[${i}].qty`] = num(it.qty);
    s[`items[${i}].unit`] = str(it.unit);
    s[`items[${i}].price`] = num(it.price);
    s[`items[${i}].sum`] = num(it.sum);
    s[`items[${i}].vatRate`] = num(it.vatRate);
    s[`items[${i}].vatSum`] = num(it.vatSum);
  });
  return s;
}

function diffKeys(a: Snapshot, b: Snapshot): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if ((a[k] ?? '∅') !== (b[k] ?? '∅')) out.push(k);
  }
  return out.sort();
}

async function loadPrompt(name: string): Promise<{ id: string; content: string }> {
  const [row] = await db
    .select({ id: prompts.id, content: prompts.content })
    .from(prompts)
    .where(and(eq(prompts.docKind, 'upd'), eq(prompts.name, name)))
    .limit(1);
  if (!row) throw new Error(`Промпт «${name}» (doc_kind=upd) не найден в таблице prompts`);
  return row;
}

/** Один прогон одного файла тем же путём, что и прод. */
async function runOne(
  entry: ManifestEntry,
  buffer: Buffer,
  override: PromptOverride,
): Promise<UpdPdfParsed> {
  const ctx = { sourceDocumentId: null, promptOverride: override };
  if (entry.parsePath === 'vision') {
    const mime = MIME_BY_EXT[extname(entry.filename).toLowerCase()] ?? 'application/pdf';
    const res = await parseUpdVision({ buffer, mimeType: mime }, ctx);
    return res.parsed;
  }
  if (entry.parsePath === 'multi_upd') {
    const bundle = await tryParseTextUpdBundle(buffer, ctx);
    // Не сложился как пакет — прод в этом случае идёт обычным одиночным путём.
    if (bundle) return bundle.parsed;
    return (await parseUpdPdf(buffer, ctx)).parsed;
  }
  return (await parseUpdPdf(buffer, ctx)).parsed;
}

async function main(): Promise<void> {
  const dir = resolve(argValue('--dir') ?? join(process.cwd(), '../../docs/debug-upd'));
  const manifestPath = resolve(
    argValue('--manifest') ?? join(process.cwd(), 'scripts/corpus-manifest.json'),
  );
  const baseName = argValue('--base', 'default v8')!;
  const newName = argValue('--new', 'default v9')!;
  const limitRaw = argValue('--limit');
  const limit = limitRaw ? Number(limitRaw) : Infinity;

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { entries: ManifestEntry[] };
  const all = manifest.entries ?? [];

  // Отбор: только УПД и только пути, где промпт вообще участвует.
  const skipped: string[] = [];
  const selected: ManifestEntry[] = [];
  for (const e of all) {
    if (e.kind !== 'upd') {
      skipped.push(`${e.filename} — kind=${e.kind}, промпт УПД не применяется`);
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

  console.log(`[ab] корпус: ${dir}`);
  console.log(`[ab] файлов в манифесте: ${all.length}; в сверке: ${work.length}`);
  // Пропущенное печатаем всегда: «прогнали корпус» не должно означать
  // «прогнали половину корпуса и промолчали».
  for (const s of skipped) console.log(`[ab] пропущен: ${s}`);
  if (work.length < selected.length) {
    console.log(`[ab] --limit: из ${selected.length} подходящих взято ${work.length}`);
  }

  const base = await loadPrompt(baseName);
  const fresh = await loadPrompt(newName);
  console.log(`[ab] база: «${baseName}», новый: «${newName}», температура: 0`);

  const unstableAll = new Set<string>();
  const regressions: { file: string; keys: string[] }[] = [];
  const consigneeMissing: string[] = [];
  const consigneeFound: string[] = [];
  const failures: { file: string; stage: string; error: string }[] = [];

  for (const entry of work) {
    const buffer = await readFile(join(dir, entry.filename));
    process.stdout.write(`[ab] ${entry.filename} (${entry.parsePath}) … `);

    let a1: UpdPdfParsed;
    let a2: UpdPdfParsed;
    let b: UpdPdfParsed;
    try {
      a1 = await runOne(entry, buffer, { prompt: base, temperature: 0 });
      a2 = await runOne(entry, buffer, { prompt: base, temperature: 0 });
      b = await runOne(entry, buffer, { prompt: fresh, temperature: 0 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log('ОШИБКА');
      failures.push({ file: entry.filename, stage: 'parse', error: msg });
      continue;
    }

    const sa1 = snapshotOf(a1);
    const sa2 = snapshotOf(a2);
    const sb = snapshotOf(b);

    const unstable = new Set(diffKeys(sa1, sa2));
    for (const k of unstable) unstableAll.add(`${entry.filename}:${k}`);

    // Сравниваем v9 с первым прогоном базы, игнорируя поля, которые база сама
    // себе не воспроизвела. consignee исключаем из критерия: его в v8 нет
    // по определению, это и есть добавляемое поле.
    const changed = diffKeys(sa1, sb).filter(
      (k) => !unstable.has(k) && !k.startsWith('consignee.'),
    );
    if (changed.length > 0) regressions.push({ file: entry.filename, keys: changed });

    const gotConsignee = str(b.consignee?.name) !== '∅';
    if (gotConsignee) consigneeFound.push(entry.filename);
    else if (entry.hasConsignee === true) consigneeMissing.push(entry.filename);

    console.log(
      `${changed.length === 0 ? 'ок' : `РАСХОЖДЕНИЯ (${changed.length})`}` +
        `${unstable.size ? `, нестабильных полей: ${unstable.size}` : ''}` +
        `${gotConsignee ? ', грузополучатель найден' : ''}`,
    );
  }

  console.log('\n──────── итог ────────');
  console.log(`Файлов проверено: ${work.length - failures.length}`);
  console.log(`Грузополучатель распознан: ${consigneeFound.length}`);

  if (failures.length > 0) {
    console.log(`\nНЕ РАЗОБРАЛИСЬ (${failures.length}) — проверьте вручную:`);
    for (const f of failures) console.log(`  ${f.file}: ${f.error}`);
  }

  if (unstableAll.size > 0) {
    console.log(
      `\nНЕСТАБИЛЬНЫЕ ПОЛЯ (${unstableAll.size}) — разошлись между двумя прогонами базы,`,
    );
    console.log('в критерий не входят, но стоит посмотреть глазами:');
    for (const k of [...unstableAll].sort()) console.log(`  ${k}`);
  }

  if (consigneeMissing.length > 0) {
    console.log(
      `\nГРУЗОПОЛУЧАТЕЛЬ НЕ НАЙДЕН там, где манифест его обещает (${consigneeMissing.length}):`,
    );
    for (const f of consigneeMissing) console.log(`  ${f}`);
  }

  const checked = work.length - failures.length;
  if (checked === 0) {
    // Пустой прогон не должен выглядеть как успешный: «регрессий нет» на нуле
    // файлов — самый простой способ активировать непроверенный промпт.
    console.log(
      '\nСВЕРКА НЕ ВЫПОЛНЕНА: ни один файл не разобран (проверьте --limit, манифест и корпус).',
    );
    process.exitCode = 1;
  } else if (regressions.length > 0) {
    console.log(`\nРЕГРЕСС: изменились стабильные поля (${regressions.length} файлов):`);
    for (const r of regressions) {
      console.log(`  ${r.file}: ${r.keys.join(', ')}`);
    }
    console.log('\nАКТИВИРОВАТЬ v9 НЕЛЬЗЯ — сначала разберитесь с расхождениями.');
    process.exitCode = 1;
  } else {
    console.log('\nРегрессий нет: все поля, стабильные у базы, совпали с новой версией.');
    console.log('Можно активировать промпт в Администрирование → Промпты.');
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
