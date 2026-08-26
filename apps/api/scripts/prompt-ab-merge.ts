/**
 * Свод отчётов A/B, полученных по частям, в один вердикт.
 *
 * Зачем. Полный корпус гоняется окнами (--offset/--limit), потому что 180
 * вызовов подряд бьют по провайдеру. Но вердикт «активировать можно» считается
 * по ВСЕМУ корпусу: часть, в которой не оказалось регрессий, ничего не
 * доказывает про остальные. Восемь зелёных файлов — это не восемь разрешений, а
 * восемь фрагментов одного отчёта.
 *
 * Что проверяется перед сведением. Части обязаны быть об одном и том же:
 *   * один тип документа;
 *   * ОБЕ версии промпта совпадают по id И по хешу содержимого. Промпты
 *     неизменяемы по замыслу, но `PATCH /admin/prompts/:id` это позволяет —
 *     если текст правили между частями, сравнивать их нельзя;
 *   * один манифест (хеш): иначе эталон менялся по ходу прогона;
 *   * один git SHA рабочего дерева: правка парсера между частями меняет
 *     результат так же, как правка промпта.
 * Несовпадение любого — отказ, а не предупреждение. Свод несовместимых частей
 * выглядел бы как полноценный отчёт и потому опаснее отсутствующего.
 *
 * Покрытие окон считается по (offset, taken) против общего числа подходящих
 * файлов: пропуск и пересечение называются явно. Пропущенный кусок корпуса —
 * это непроверенные документы, а пересечение раздувает статистику повтором.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/prompt-ab-merge.ts /tmp/ab-*.json
 *
 * Ничего не пишет и никуда не ходит: читает файлы и печатает отчёт.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  coverageOf,
  evaluateGate,
  identityDiff,
  missingReportFields,
  mixedModelPrompts,
  newMoneyMismatches,
  type UnitComparison,
} from './prompt-ab-lib.js';

type PromptMeta = { name: string; id: string; sha256: string; length: number };

type CallRecord = {
  id: string;
  promptId: string | null;
  providerName: string | null;
  model: string | null;
  errorCode: string | null;
};

type Report = {
  formatVersion: number;
  docKind: string;
  startedAt: string;
  finishedAt: string;
  window: { offset: number; limit: number; selected: number; taken: number };
  files: string[];
  corpus: { dir: string; manifestPath: string; manifestSha256: string; entries: number };
  git: { sha: string | null; dirty: boolean | null };
  prompts: { base: PromptMeta; fresh: PromptMeta };
  calls: CallRecord[];
  /** Документы, которые база и новая версия читали разными моделями. */
  providerMismatch?: string[];
  failures: { file: string; error: string }[];
  comparisons: UnitComparison[];
  blockers: string[];
};

function fail(message: string): never {
  console.error(`[merge] ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    fail('укажите файлы отчётов: prompt-ab-merge.ts /tmp/ab-*.json');
  }

  const reports: Report[] = [];
  for (const path of paths) {
    const raw = await readFile(resolve(path), 'utf8');
    const parsed = JSON.parse(raw) as Report;
    if (parsed.formatVersion !== 1) {
      fail(`${path}: неизвестная версия формата ${parsed.formatVersion}`);
    }
    const missing = missingReportFields(parsed);
    if (missing.length > 0) {
      fail(`${path}: в отчёте нет обязательных полей — ${missing.join(', ')}`);
    }
    reports.push(parsed);
  }
  reports.sort((a, b) => a.window.offset - b.window.offset);

  const reference = reports[0]!;
  for (const r of reports) {
    const diff = identityDiff(reference, r);
    if (diff.length > 0) {
      console.error('[merge] части прогнаны в разных условиях — сводить их нельзя:');
      for (const line of diff) console.error(`  ${line}`);
      fail('прогоните набор заново в одинаковых условиях.');
    }
  }

  const first = reports[0]!;
  if (first.git.dirty) {
    console.log('[merge] ВНИМАНИЕ: прогон сделан на рабочем дереве с незакоммиченными правками');
  }

  // Покрытие: пропуски опаснее пересечений — это непроверенные документы.
  const selected = first.window.selected;
  const { covered, overlaps, missing } = coverageOf(
    reports.map((r) => ({ offset: r.window.offset, taken: r.window.taken })),
    selected,
  );

  console.log(`[merge] частей: ${reports.length}, тип документа: ${first.docKind}`);
  console.log(`[merge] база: «${first.prompts.base.name}», новый: «${first.prompts.fresh.name}»`);
  console.log(`[merge] покрыто ${covered} из ${selected} подходящих файлов`);
  if (overlaps > 0) {
    console.log(`[merge] ВНИМАНИЕ: окна пересекаются — ${overlaps} файлов прогнаны повторно`);
  }
  if (missing.length > 0) {
    console.log(
      `[merge] НЕ ПРОГНАНЫ позиции: ${missing.join(', ')} — ` +
        `допрогоните их (--offset ${missing[0]}) перед решением об активации`,
    );
  }

  const comparisons = reports.flatMap((r) => r.comparisons);
  const failures = reports.flatMap((r) => r.failures);
  const calls = reports.flatMap((r) => r.calls);

  // Та же проверка, что и в самом прогоне, но уже по всем частям сразу: между
  // окнами провайдер мог смениться незаметно.
  // Справочно: несколько моделей за прогон — норма, провайдер выбирается путём
  // разбора (текст идёт по цепочке активных, картинки — к основному).
  for (const [promptId, models] of mixedModelPrompts(calls)) {
    const which =
      promptId === first.prompts.base.id
        ? first.prompts.base.name
        : promptId === first.prompts.fresh.id
          ? first.prompts.fresh.name
          : promptId;
    console.log(`[merge] «${which}» обслуживали модели: ${models.join(', ')}`);
  }
  // А вот это уже недостоверность: один документ прочитан разными моделями.
  const providerMismatch = reports.flatMap((r) => r.providerMismatch ?? []);
  if (providerMismatch.length > 0) {
    console.log(`[merge] РАЗНЫЕ МОДЕЛИ НА ОДНОМ ДОКУМЕНТЕ (${providerMismatch.length}):`);
    for (const key of providerMismatch) console.log(`  ${key}`);
  }
  const errored = calls.filter((c) => c.errorCode != null).length;
  console.log(`[merge] вызовов модели: ${calls.length}, из них с ошибкой: ${errored}`);

  console.log(`\n──────── свод ────────`);
  console.log(`Логических документов проверено: ${comparisons.length}`);
  if (failures.length > 0) {
    console.log(`\nНЕ РАЗОБРАЛИСЬ (${failures.length}):`);
    for (const f of failures) console.log(`  ${f.file}: ${f.error}`);
  }

  const critical = comparisons.filter((c) => c.changedCritical.length > 0);
  if (critical.length > 0) {
    console.log(`\nРЕГРЕСС КРИТИЧЕСКИХ ПОЛЕЙ (${critical.length} документов):`);
    for (const c of critical) console.log(`  ${c.label}: ${c.changedCritical.join(', ')}`);
  }

  const money = comparisons.filter((c) => newMoneyMismatches(c).length > 0);
  if (money.length > 0) {
    console.log(`\nНОВЫЕ РАСХОЖДЕНИЯ СУММ С ЭТАЛОНОМ (${money.length} документов):`);
    for (const c of money) {
      for (const m of newMoneyMismatches(c)) console.log(`  ${c.label} — ${m.where}: ${m.detail}`);
    }
  }

  const blockers = evaluateGate({ checkedUnits: comparisons.length, failures, comparisons });
  // Неполное покрытие — блокер свода, а не самого гейта: гейт про качество
  // разбора, а это про то, что часть корпуса вообще не проверяли.
  if (missing.length > 0) {
    blockers.push(`корпус прогнан не полностью: не проверено ${missing.length} файлов`);
  }
  // Между окнами провайдер мог смениться незаметно — тогда части сравнивают
  // разные модели, и общий вердикт об эффекте промпта недоказуем.
  if (providerMismatch.length > 0) {
    blockers.push(`разные модели на одном документе: ${providerMismatch.length}`);
  }

  if (blockers.length > 0) {
    console.log(`\nАКТИВИРОВАТЬ «${first.prompts.fresh.name}» НЕЛЬЗЯ — ${blockers.join('; ')}.`);
    process.exitCode = 1;
  } else {
    console.log(
      `\nПо всему корпусу регрессий нет. Решение об активации «${first.prompts.fresh.name}» — за владельцем.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
