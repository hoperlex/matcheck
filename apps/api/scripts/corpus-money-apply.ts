/**
 * Перенос денежной разметки из черновика в манифест корпуса.
 *
 * Черновик (`corpus-money-draft.json`) собран из текстового слоя по координатам
 * граф — без модели. Манифест (`corpus-manifest.json`) — то, с чем сверяется
 * A/B версий промпта. Пока деньги лежат отдельно, сверять цены и суммы не с
 * чем: `checkMoneyAgainstExpectation` читает их из `expectedDocuments`.
 *
 * Почему перенос вообще допустим без ручной сверки каждой цифры. У покрытых
 * документов сумма позиций сходится с напечатанным «Всего к оплате» до копейки
 * (`totalsMismatch` пуст). Это независимая арифметика: она не выводится из
 * разбора, а проверяет его. Ошибка колонки, потерянная или задвоенная строка
 * итог ломают — потому первый же прогон черновика и вскрыл три дефекта.
 *
 * Что НЕ переносится и почему:
 *   * документ с `notCovered` (нет итога) — проверять полноту позиций не с чем;
 *   * документ с `totalsMismatch` — черновику доверять нельзя, пока человек не
 *     разберётся;
 *   * поле со значением `null`. В манифесте `null` означает «графа проверена и
 *     пуста» — проверяемое утверждение, на котором держится вся ловля
 *     выдуманных цен. В черновике `null` означает всего лишь «не распознал».
 *     Смешать эти два смысла — значит получить эталон, который сам врёт,
 *     поэтому пустое поле не пишется вовсе: A/B его молча пропустит;
 *   * файл, у которого в манифесте нет `expectedDocuments`. Это документы с
 *     пустой графой 4 (`hasConsignee: false`), и тест целостности требует
 *     держать их эталон пустым.
 *
 * Существующая разметка (номер документа, грузополучатель) не трогается —
 * скрипт только добавляет денежные поля. Несовпадение номера у сопоставленной
 * пары считается рассинхроном и пропускается целиком: молча писать деньги
 * одного документа в эталон другого хуже, чем не писать ничего.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ — печатает, что сделал бы. Запись только с
 * --apply.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/corpus-money-apply.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/corpus-money-apply.ts --apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DraftDocument, DraftEntry } from './corpus-money-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAFT = join(HERE, 'corpus-money-draft.json');
const MANIFEST = join(HERE, 'corpus-manifest.json');

const apply = process.argv.includes('--apply');

type ExpectedItem = {
  rowNo: number;
  qty?: number;
  price?: number;
  sum?: number;
  vatSum?: number;
};

type ExpectedDocument = {
  docNumber: string;
  consignee: { name: string; inn: string | null; kpp: string | null };
  totalSum?: number;
  vatSum?: number;
  items?: ExpectedItem[];
};

type ManifestEntry = {
  filename: string;
  kind: string;
  parsePath: string;
  hasConsignee: boolean | null;
  source: string;
  note?: string;
  expectedDocuments?: ExpectedDocument[];
};

/** Номера сравниваем без пробелов и регистра: «201/2112 6363» и «201/21126363». */
function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined): string =>
    (v ?? '').replace(/\s+/g, '').toLocaleLowerCase('ru');
  return norm(a) === norm(b);
}

/**
 * Пары «документ черновика → эталон манифеста».
 *
 * Сначала по номеру — он надёжнее позиции. Позиционное сопоставление
 * применяется, только когда числа документов совпадают и ни один номер в
 * манифесте не размечен: там сравнивать нечего, а порядок субдокументов в
 * файле один и тот же (оба списка строятся по порядку страниц).
 */
function pairDocuments(
  draft: DraftDocument[],
  expected: ExpectedDocument[],
): { pairs: Array<[DraftDocument, ExpectedDocument]>; skipped: Array<[DraftDocument, string]> } {
  const pairs: Array<[DraftDocument, ExpectedDocument]> = [];
  const skipped: Array<[DraftDocument, string]> = [];
  const used = new Set<ExpectedDocument>();

  for (const doc of draft) {
    const byNumber = expected.find(
      (e) => !used.has(e) && e.docNumber && sameNumber(e.docNumber, doc.docNumber),
    );
    if (byNumber) {
      pairs.push([doc, byNumber]);
      used.add(byNumber);
    }
  }
  if (pairs.length === draft.length) return { pairs, skipped };

  // Ничего не сопоставилось по номеру — пробуем позиционно, но только на
  // полностью неразмеченных номерах и при равной длине списков.
  const rest = draft.filter((d) => !pairs.some(([p]) => p === d));
  const restExpected = expected.filter((e) => !used.has(e));
  const numbersUnmarked = restExpected.every((e) => !e.docNumber);
  if (rest.length === restExpected.length && numbersUnmarked) {
    rest.forEach((doc, i) => pairs.push([doc, restExpected[i]!]));
    return { pairs, skipped };
  }
  for (const doc of rest) {
    skipped.push([doc, 'нет пары в манифесте: номера не совпали, позиционно сопоставить нельзя']);
  }
  return { pairs, skipped };
}

/** Денежные поля позиции, которые реально проверены черновиком. */
function itemFields(item: DraftDocument['items'][number]): ExpectedItem | null {
  // Строка, где количество × цена не сходится с её же стоимостью, в эталон не
  // идёт вовсе — даже частично. Какое из двух чисел испорчено срезом колонки,
  // отсюда не видно, а половинчатая разметка тут опаснее отсутствующей:
  // эталон объявит регрессом верный ответ модели.
  if (item.mismatch) return null;
  const out: ExpectedItem = { rowNo: item.rowNo };
  let filled = 0;
  for (const field of ['qty', 'price', 'sum', 'vatSum'] as const) {
    const value = item[field];
    if (value == null) continue;
    out[field] = value;
    filled += 1;
  }
  return filled > 0 ? out : null;
}

function main(): void {
  const draft = JSON.parse(readFileSync(DRAFT, 'utf-8')) as {
    entries: DraftEntry[];
  };
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as {
    note?: string;
    entries: ManifestEntry[];
  };
  const byFilename = new Map(manifest.entries.map((e) => [e.filename, e]));

  let filesTouched = 0;
  let docsWritten = 0;
  let itemsWritten = 0;
  let partialItems = 0;
  const skippedDocs: string[] = [];
  const skippedFiles: string[] = [];

  for (const entry of draft.entries) {
    if (entry.skipped) {
      skippedFiles.push(`${entry.filename} — ${entry.skipped}`);
      continue;
    }
    const target = byFilename.get(entry.filename);
    if (!target) {
      skippedFiles.push(`${entry.filename} — записи нет в манифесте`);
      continue;
    }
    if (!target.expectedDocuments?.length) {
      skippedFiles.push(
        `${entry.filename} — в манифесте нет эталона (графа 4 пуста либо файл вне сверки)`,
      );
      continue;
    }

    const { pairs, skipped } = pairDocuments(entry.documents, target.expectedDocuments);
    for (const [doc, reason] of skipped) {
      skippedDocs.push(`${entry.filename} · ${doc.docNumber ?? '∅'} — ${reason}`);
    }

    let touched = false;
    for (const [doc, expected] of pairs) {
      if (doc.notCovered) {
        skippedDocs.push(`${entry.filename} · ${doc.docNumber ?? '∅'} — ${doc.notCovered}`);
        continue;
      }
      if (doc.totalsMismatch) {
        skippedDocs.push(`${entry.filename} · ${doc.docNumber ?? '∅'} — ${doc.totalsMismatch}`);
        continue;
      }
      if (expected.docNumber && !sameNumber(expected.docNumber, doc.docNumber)) {
        skippedDocs.push(
          `${entry.filename} · ${doc.docNumber ?? '∅'} — номер в манифесте «${expected.docNumber}» не совпал`,
        );
        continue;
      }

      if (doc.totalSum != null) expected.totalSum = doc.totalSum;
      if (doc.vatSum != null) expected.vatSum = doc.vatSum;

      const suspect = doc.items.filter((i) => i.mismatch);
      for (const item of suspect) {
        skippedDocs.push(`${entry.filename} · ${doc.docNumber ?? '∅'} · строка ${item.rowNo} — ${item.mismatch}`);
      }
      const items = doc.items.map(itemFields).filter((i): i is ExpectedItem => i != null);
      // Полная замена, а не дополнение: источник у позиций один — черновик.
      // Если после починки разбора строка стала подозрительной и в перенос не
      // попала, прежнее (уже неверное) значение обязано уйти из эталона, иначе
      // оно тихо переживёт исправление и продолжит врать.
      if (items.length > 0) expected.items = items;
      else delete expected.items;
      itemsWritten += items.length;
      partialItems += items.filter((i) => i.price === undefined || i.sum === undefined).length;
      docsWritten += 1;
      touched = true;
    }
    if (touched) filesTouched += 1;
  }

  console.log(`${apply ? 'ЗАПИСЬ' : 'DRY-RUN'}: файлов затронуто — ${filesTouched}`);
  console.log(`  документов с деньгами: ${docsWritten}`);
  console.log(`  позиций: ${itemsWritten} (из них с неполной разметкой: ${partialItems})`);
  if (skippedDocs.length > 0) {
    console.log(`\nдокументы без переноса — ${skippedDocs.length}:`);
    for (const line of skippedDocs) console.log(`  ${line}`);
  }
  if (skippedFiles.length > 0) {
    console.log(`\nфайлы без переноса — ${skippedFiles.length}:`);
    for (const line of skippedFiles) console.log(`  ${line}`);
  }

  if (!apply) {
    console.log('\nНичего не изменено. Для записи — повторить с --apply.');
    return;
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  console.log(`\nманифест обновлён: ${MANIFEST}`);
}

main();
