/**
 * Сверка двух версий промпта НАКЛАДНЫХ на корпусе документов.
 *
 * Зачем отдельный скрипт, а не флаг у upd-prompt-ab.ts. Тот сравнивает
 * `UpdPdfParsed` — одну шапку с позициями. Накладные же приходят пакетом:
 * `parseWaybillBatch` возвращает МАССИВ документов, у каждого своя форма
 * (ТН-2116 или ОС-2) и свой набор сторон — у ТН это грузоотправитель и
 * грузополучатель, у ОС-2 внутренние сдатчик и получатель. Ключ сопоставления
 * между прогонами тоже другой: имя файла + номер документа, потому что из
 * одного пакета может выйти несколько накладных. Втискивать это в UPD-скрипт
 * значило бы переписать его сравнение и рискнуть работающей сверкой УПД.
 *
 * Как отделяется шум модели. Сначала A/A — два прогона БАЗОВОЙ версии подряд.
 * Поля, разошедшиеся уже там, объявляются нестабильными и новой версии не
 * предъявляются. Всё, что в A/A совпало, обязано совпасть и у новой версии.
 *
 * Главный вопрос, на который отвечает скрипт: не потеряла ли новая версия
 * документы, которые старая находила. Поэтому исход «в A есть документ, в B
 * его нет» — блокирующий, а обратный случай («B нашёл то, чего A не видел»)
 * печатается как приобретение: ради него версия и заводится.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/waybill-prompt-ab.ts \
 *     --base "default v3" --new "default v4" --dir docs/debug-waybill
 *
 * Стоит денег: три прогона по корпусу — примерно 3 LLM-вызова на файл.
 * Для черновых проверок есть --limit.
 *
 * НЕ меняет активный промпт и ничего не пишет в source_documents: читает
 * prompts, гоняет парсер с явным promptOverride и печатает отчёт. Строки в
 * llm_calls при этом появляются с source_document_id = NULL — это журнал
 * вызовов, отчёты по нему фильтруйте по `source_document_id IS NOT NULL`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { WaybillDocument } from '@matcheck/contracts';
import { db } from '../src/db/client.js';
import { prompts } from '../src/db/schema.js';
import { parseWaybillBatch, type WaybillInputImage } from '../src/domain/edo/waybill-batch.parser.js';
import { expandPdfAttachmentsForOpenRouter } from '../src/domain/edo/waybill-pdf.js';
import { getDefaultProviderKind } from '../src/domain/llm/registry.js';

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

async function loadPrompt(name: string): Promise<{ id: string; content: string }> {
  const [row] = await db
    .select({ id: prompts.id, content: prompts.content })
    .from(prompts)
    .where(and(eq(prompts.docKind, 'transport_waybill'), eq(prompts.name, name)))
    .limit(1);
  if (!row) {
    throw new Error(`Промпт «${name}» (doc_kind=transport_waybill) не найден в таблице prompts`);
  }
  return row;
}

/** Снимок одного документа: то, что обязано совпасть между прогонами. */
type Snapshot = Record<string, string>;

function str(v: unknown): string {
  if (v == null) return '∅';
  return String(v).trim().replace(/\s+/g, ' ');
}

function num(v: number | null | undefined, scale: number): string {
  return v == null ? '∅' : v.toFixed(scale);
}

/**
 * Позиции сверяются целиком, а не только количеством: перепутанные цена и
 * сумма или съехавшее наименование при равной длине массива иначе прошли бы
 * незаметно.
 */
function snapshotOf(doc: WaybillDocument): Snapshot {
  const s: Snapshot = {
    form: str(doc.form),
    docNumber: str(doc.docNumber),
    docDate: str(doc.docDate),
    'shipper.inn': str(doc.shipper?.inn),
    'shipper.name': str(doc.shipper?.name),
    'consignee.inn': str(doc.consignee?.inn),
    'consignee.name': str(doc.consignee?.name),
    'sender.name': str(doc.sender?.name),
    'recipient.name': str(doc.recipient?.name),
    totalSum: num(doc.totalSum ?? null, 2),
    'items.length': String(doc.items.length),
  };
  doc.items.forEach((it, i) => {
    s[`items[${i}].nameRaw`] = str(it.nameRaw);
    s[`items[${i}].qty`] = num(it.qty ?? null, 4);
    s[`items[${i}].unit`] = str(it.unit);
    s[`items[${i}].invNumber`] = str(it.invNumber);
    s[`items[${i}].price`] = num(it.price ?? null, 4);
    s[`items[${i}].sum`] = num(it.sum ?? null, 2);
  });
  return s;
}

/** Ключ документа внутри пакета: номер, иначе форма+порядок. */
function keyOf(doc: WaybillDocument, index: number): string {
  const n = (doc.docNumber ?? '').trim();
  return n === '' ? `${doc.form}#${index}` : `${doc.form}#${n}`;
}

type Run = Map<string, Snapshot>;

async function runOne(
  files: WaybillInputImage[],
  prompt: { id: string; content: string },
): Promise<Run> {
  const res = await parseWaybillBatch(files, {
    sourceDocumentId: null,
    bundleId: null,
    // temperature 0 — сверка должна ловить изменения промпта, а не разброс
    // сэмплирования; остаточный шум всё равно отсекается прогоном A/A.
    promptOverride: { prompt, temperature: 0 },
  });
  const out: Run = new Map();
  res.parsed.documents.forEach((doc, i) => out.set(keyOf(doc, i), snapshotOf(doc)));
  return out;
}

function diffKeys(a: Snapshot, b: Snapshot): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => (a[k] ?? '∅') !== (b[k] ?? '∅')).sort();
}

async function main(): Promise<void> {
  const baseName = argValue('--base', 'default v3')!;
  const newName = argValue('--new', 'default v4')!;
  const dir = resolve(argValue('--dir') ?? join(process.cwd(), '../../docs/debug-waybill'));
  const limitRaw = argValue('--limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : Number.POSITIVE_INFINITY;

  const base = await loadPrompt(baseName);
  const fresh = await loadPrompt(newName);
  if (base.content === fresh.content) {
    console.warn(`⚠ Тексты «${baseName}» и «${newName}» совпадают — сверять нечего.`);
  }

  const providerKind = await getDefaultProviderKind();
  const names = (await readdir(dir))
    .filter((f) => MIME_BY_EXT[extname(f).toLowerCase()])
    .sort()
    .slice(0, limit);
  if (names.length === 0) throw new Error(`В каталоге ${dir} нет подходящих файлов`);

  console.info(`Корпус: ${names.length} файл(ов) из ${dir}`);
  console.info(`База: «${baseName}»  Новая: «${newName}»  Провайдер: ${providerKind}\n`);

  const blockers: string[] = [];
  const gains: string[] = [];
  let unstableTotal = 0;

  for (const name of names) {
    const buffer = await readFile(join(dir, name));
    const mimeType = MIME_BY_EXT[extname(name).toLowerCase()]!;
    let files: WaybillInputImage[] = [{ buffer, mimeType, filename: name }];
    // Тот же предварительный рендер, что и в проде: OpenRouter не принимает PDF.
    if (providerKind === 'openrouter') files = await expandPdfAttachmentsForOpenRouter(files);

    let a1: Run, a2: Run, b: Run;
    try {
      a1 = await runOne(files, base);
      a2 = await runOne(files, base);
      b = await runOne(files, fresh);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ ${name}: прогон упал — ${msg}`);
      blockers.push(`${name}: ${msg}`);
      continue;
    }

    // Документ, стабильно находимый базой, обязан находиться и новой версией.
    const stableKeys = [...a1.keys()].filter((k) => a2.has(k));
    const lost = stableKeys.filter((k) => !b.has(k));
    const found = [...b.keys()].filter((k) => !a1.has(k) && !a2.has(k));

    console.info(
      `— ${name}: база ${a1.size}/${a2.size} док., новая ${b.size} док.` +
        (lost.length ? `  ПОТЕРЯНО: ${lost.join(', ')}` : '') +
        (found.length ? `  НОВОЕ: ${found.join(', ')}` : ''),
    );
    lost.forEach((k) => blockers.push(`${name}: новая версия потеряла документ ${k}`));
    found.forEach((k) => gains.push(`${name}: новая версия нашла ${k}`));

    for (const key of stableKeys) {
      if (!b.has(key)) continue;
      const s1 = a1.get(key)!;
      const s2 = a2.get(key)!;
      const sb = b.get(key)!;
      const unstable = new Set(diffKeys(s1, s2));
      unstableTotal += unstable.size;
      const changed = diffKeys(s1, sb).filter((k) => !unstable.has(k));
      if (changed.length > 0) {
        for (const k of changed) {
          const line = `${name} [${key}] ${k}: «${s1[k] ?? '∅'}» → «${sb[k] ?? '∅'}»`;
          console.info(`    ${line}`);
          blockers.push(line);
        }
      }
      if (unstable.size > 0) {
        console.info(`    (нестабильно в A/A, не предъявляем: ${[...unstable].join(', ')})`);
      }
    }
  }

  console.info('\n──────── итог ────────');
  if (gains.length > 0) {
    console.info(`Приобретения (${gains.length}):`);
    gains.forEach((g) => console.info(`  + ${g}`));
  }
  console.info(`Нестабильных полей в A/A: ${unstableTotal}`);
  if (blockers.length === 0) {
    console.info('✓ Регрессий нет: всё, что база находила стабильно, новая версия сохранила.');
  } else {
    console.error(`✗ Блокеров: ${blockers.length}`);
    blockers.forEach((b) => console.error(`  - ${b}`));
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
