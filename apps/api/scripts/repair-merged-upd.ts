/**
 * Документы, раздутые прежней склейкой экземпляров: диагностика и починка.
 *
 * Откуда берутся. Поставщик сканирует ОБА экземпляра УПД, сегментация делает из
 * них два документа с одним номером, склейка сводит их в один. Дедуп строк шёл
 * по тексту наименования, а OCR читает два скана одной страницы по-разному
 * («МК-103» и «МК --103») — строки считались разными, и документ получал
 * двойной состав. Итог при этом перезаписывался суммой строк, поэтому проверка
 * «Всего к оплате против Σ строк» сравнивала число само с собой и сходилась:
 * документ выглядел обработанным. На боевой БД 20.08.2026 так раздулись 11
 * документов из 28 склеек, суммарное завышение ≈ 543 881 ₽.
 *
 * Что делает скрипт. Схлопывает задвоенные строки ТЕМ ЖЕ правилом, которым
 * теперь работает склейка (dedupeAssemblyItems — общий код, не копия), возвращает
 * заявленный итог из архивного двойника, откатывает страницы сегмента к
 * исходным, пересчитывает validation и исход, бампает ревизию машины.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ — печатает, что сделал бы. Запись только с
 * --apply.
 *
 * Документ, уже привязанный к приёмке или отгрузке, НЕ трогается: его состав
 * человек мог править руками, и подменять его задним числом нельзя. Проверка
 * повторяется внутри транзакции — между отчётом и записью приёмку могли создать.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/repair-merged-upd.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/repair-merged-upd.ts --limit 5
 *   pnpm --filter @matcheck/api exec tsx scripts/repair-merged-upd.ts --apply
 */
import { eq, inArray, sql as drSql } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { bundleSegments, sourceDocumentItems, sourceDocuments } from '../src/db/schema.js';
import { operationTrace } from '../src/domain/sourceDocuments/operation-trace.js';
import { dedupeAssemblyItems } from '../src/domain/edo/upd-assembly-merge.js';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';
import { deriveUpdParseOutcome } from '../src/domain/edo/upd-outcome.js';
import { bumpGroupRevision } from '../src/domain/sourceDocuments/document-group.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const apply = process.argv.includes('--apply');
const limit = Number(argValue('--limit') ?? '100');
const only = argValue('--document');

type PageRef = { registryItemId: string | null; inputOrder: number; pageInFile: number };

const refKey = (r: PageRef): string =>
  JSON.stringify([r.registryItemId, r.inputOrder, r.pageInFile]);

async function main(): Promise<void> {
  // Кандидаты: документы, в которые прежняя склейка что-то влила. Архивный
  // двойник хранит ссылку на победителя — по ней и находим.
  const dropped = await db
    .select({
      id: sourceDocuments.id,
      keeperId: drSql<string>`(${sourceDocuments.parseErrorDetails} ->> 'mergedInto')::uuid`,
      totalSum: sourceDocuments.totalSum,
      vatSum: sourceDocuments.vatSum,
    })
    .from(sourceDocuments)
    .where(drSql`${sourceDocuments.parseErrorDetails} ? 'mergedInto'`)
    .limit(limit);

  const byKeeper = new Map<string, typeof dropped>();
  for (const row of dropped) {
    if (only && row.keeperId !== only) continue;
    const list = byKeeper.get(row.keeperId) ?? [];
    list.push(row);
    byKeeper.set(row.keeperId, list);
  }

  if (byKeeper.size === 0) {
    console.log('Склеенных документов не найдено.');
    await sql.end({ timeout: 5 });
    return;
  }

  console.log(`${apply ? 'ПОЧИНКА' : 'DRY-RUN'}: групп к проверке — ${byKeeper.size}\n`);
  let repaired = 0;
  let skipped = 0;

  for (const [keeperId, twins] of byKeeper) {
    const [keeper] = await db
      .select()
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, keeperId))
      .limit(1);
    if (!keeper) {
      console.log(`  [нет документа] ${keeperId}`);
      continue;
    }

    const items = await db
      .select()
      .from(sourceDocumentItems)
      .where(eq(sourceDocumentItems.sourceDocumentId, keeperId))
      .orderBy(sourceDocumentItems.lineNo);
    // Сколько экземпляров свели в этот документ: сам keeper плюс архивные
    // двойники. От этого зависит, сколько одинаковых строк — задвоение, а
    // сколько честный повтор позиции в бланке.
    const { keep, drop } = dedupeAssemblyItems(
      items.map((i) => ({
        id: i.id,
        nameRaw: i.nameRaw,
        qty: i.qty,
        sum: i.sum,
        unit: i.unit,
        price: i.price,
        rowNo: i.rowNo,
      })),
      1 + twins.length,
    );

    // Заявленный итог берём у архивного двойника: его шапку склейка не трогала.
    const declaredTotal = twins.map((t) => t.totalSum).find((v) => v != null) ?? null;
    const declaredVat = twins.map((t) => t.vatSum).find((v) => v != null) ?? null;
    const totalChanges = declaredTotal != null && declaredTotal !== keeper.totalSum;

    if (drop.length === 0 && !totalChanges) {
      skipped++;
      continue;
    }

    const trace = await operationTrace(
      db,
      keeperId,
      items.map((i) => i.id),
    );

    console.log(`  ${keeper.docNumber ?? '(без номера)'} · ${keeperId}`);
    console.log(
      `    позиции: ${items.length} → ${keep.length}` +
        (drop.length ? ` (убираем ${drop.map((d) => d.nameRaw).join(', ')})` : ''),
    );
    console.log(`    итог: ${keeper.totalSum ?? '—'} → ${declaredTotal ?? keeper.totalSum ?? '—'}`);
    if (trace) {
      console.log(`    ПРОПУСК: ${trace} — правит человек`);
      skipped++;
      console.log();
      continue;
    }

    if (!apply) {
      repaired++;
      console.log();
      continue;
    }

    await db.transaction(async (tx) => {
      // Между отчётом и записью приёмку могли создать — проверяем ещё раз,
      // уже под блокировкой документа.
      const [locked] = await tx
        .select({ id: sourceDocuments.id })
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, keeperId))
        .for('update');
      if (!locked) return;
      // Между отчётом и записью приёмку могли создать или отвязать — тот же
      // код проверки, но уже под блокировкой документа.
      const traceNow = await operationTrace(
        tx,
        keeperId,
        items.map((i) => i.id),
      );
      if (traceNow) {
        console.log(`    ПРОПУСК: ${traceNow} (появилось между отчётом и записью)`);
        return;
      }

      if (drop.length > 0) {
        await tx.delete(sourceDocumentItems).where(
          inArray(
            sourceDocumentItems.id,
            drop.map((d) => d.id),
          ),
        );
        // Нумерация строк сплошная: дырка в line_no сломала бы сопоставление
        // позиций с приёмкой (мобильный клиент считает по порядку).
        for (const [idx, item] of keep.entries()) {
          await tx
            .update(sourceDocumentItems)
            .set({ lineNo: idx + 1 })
            .where(eq(sourceDocumentItems.id, item.id));
        }
      }

      // Страницы сегмента: у keeper они содержат объединение с двойником,
      // исходные — разность. Восстанавливаем, иначе повторный разбор снова
      // прочитает оба экземпляра и снова задвоит состав.
      const twinIds = twins.map((t) => t.id);
      const segments = await tx
        .select({
          id: bundleSegments.id,
          sourceDocumentId: bundleSegments.sourceDocumentId,
          pageRefs: bundleSegments.pageRefs,
        })
        .from(bundleSegments)
        .where(inArray(bundleSegments.sourceDocumentId, [keeperId, ...twinIds]));
      const keeperSegment = segments.find((s) => s.sourceDocumentId === keeperId);
      const twinRefs = new Set(
        segments
          .filter((s) => s.sourceDocumentId !== keeperId)
          .flatMap((s) => (s.pageRefs as PageRef[]) ?? [])
          .map(refKey),
      );
      if (keeperSegment && twinRefs.size > 0) {
        const own = ((keeperSegment.pageRefs as PageRef[]) ?? []).filter(
          (r) => !twinRefs.has(refKey(r)),
        );
        if (own.length > 0 && own.length < ((keeperSegment.pageRefs as PageRef[]) ?? []).length) {
          await tx
            .update(bundleSegments)
            .set({ pageRefs: own, updatedAt: new Date() })
            .where(eq(bundleSegments.id, keeperSegment.id));
        }
      }

      const totalSum = declaredTotal != null ? Number(declaredTotal) : null;
      const vatSum = declaredVat != null ? Number(declaredVat) : null;
      const validationItems = keep.map((item) => {
        const row = items.find((i) => i.id === item.id)!;
        return {
          rowNo: row.rowNo ?? null,
          qty: Number(row.qty),
          price: row.price == null ? null : Number(row.price),
          sum: row.sum == null ? null : Number(row.sum),
          vatRate: row.vatRate == null ? null : Number(row.vatRate),
          vatSum: row.vatSum == null ? null : Number(row.vatSum),
        };
      });
      const validation = validateUpdTotals(
        { totalSum, vatSum, itemsCount: null, items: validationItems },
        { detectRecognitionWarnings: true },
      );
      const outcome = deriveUpdParseOutcome(
        {
          items: validationItems,
          docNumber: keeper.docNumber,
          totalSum,
          itemsCount: null,
          confidence: keeper.llmConfidence == null ? null : Number(keeper.llmConfidence),
        },
        validation,
        { parsedViaVision: true },
      );

      await tx
        .update(sourceDocuments)
        .set({
          totalSum: totalSum == null ? null : totalSum.toFixed(2),
          vatSum: vatSum == null ? null : vatSum.toFixed(2),
          validation,
          status: outcome.status,
          parseErrorCode: outcome.parseErrorCode,
          parseErrorDetails: outcome.parseErrorDetails,
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, keeperId));

      // Ревизия машины — в той же транзакции: открытая на планшете форма
      // приёмки иначе не узнает, что состав документа изменился.
      await bumpGroupRevision(tx, keeperId);
      repaired++;
      console.log(`    исправлено · статус ${outcome.status}`);
    });
    console.log();
  }

  console.log(`Итого: ${apply ? 'исправлено' : 'к исправлению'} ${repaired}, пропущено ${skipped}`);
  if (!apply) console.log('Ничего не изменено. Для записи — повторить с --apply.');
  await sql.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
