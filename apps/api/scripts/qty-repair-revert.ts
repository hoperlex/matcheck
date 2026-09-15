/**
 * Откат правок количества, сделанных правилом qty-repair.
 *
 * Зачем скрипт пишется ВМЕСТЕ с правилом, а не после инцидента. Правило
 * эвристическое: арифметика не отличает ошибку в количестве от ошибки в цене,
 * и часть правок может оказаться порчей. Выключение флага останавливает новые
 * правки, но уже записанные не отменяет — отменять их нужно чем-то, и это
 * «что-то» должно существовать до первого включения `on`, а не появляться под
 * давлением.
 *
 * Что считается отменяемой правкой. Только запись следа в состоянии `applied`,
 * и только если СЕЙЧАС всё ещё верно:
 *   * версия результата разбора совпадает с записанной (generation и
 *     processed_at документа / updated_at снимка фото). Иначе документ уже
 *     переразобран, и след относится к другим числам;
 *   * текущее количество строки равно тому, которое правило записало. Если его
 *     поправили руками, правка менеджера сильнее нашей, и трогать её нельзя;
 *   * документ не оставил следа в операциях (operationTrace, в той же
 *     транзакции) — количество, уехавшее в приёмку или отгрузку, не меняем.
 *
 * Любое несовпадение — пропуск с названной причиной, а не «почти подходит».
 * Наблюдения (`observed`) не трогаются вовсе: правило их не применяло.
 *
 * По умолчанию НИЧЕГО не пишет — печатает, что было бы отменено. Реальный
 * откат: --apply. Так же устроены соседние ремонтные скрипты.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/qty-repair-revert.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/qty-repair-revert.ts --apply
 *   … --document <uuid>   — только один документ
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { photoRecognizedItems, sourceDocumentItems, sourceDocuments } from '../src/db/schema.js';
import { operationTrace } from '../src/domain/sourceDocuments/operation-trace.js';
import type { QtyRepairEntry, QtyRepairTrace } from '../src/domain/edo/qty-repair.js';

type Skip = { where: string; reason: string };

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
/** `indexOf` возвращает −1, когда ключа нет: без явной проверки за «документ»
 *  принимался бы первый попавшийся аргумент (и `--apply` уезжал в фильтр по id). */
const documentFlagAt = argv.indexOf('--document');
const onlyDocument = documentFlagAt >= 0 ? argv[documentFlagAt + 1] : undefined;

function isApplied(e: QtyRepairEntry): boolean {
  return e.state === 'applied';
}

/** Сравнение numeric из БД с числом следа: numeric приходит строкой «57.0000». */
function sameQty(dbValue: string | null, expected: number): boolean {
  if (dbValue == null) return false;
  const n = Number(dbValue);
  return Number.isFinite(n) && Math.abs(n - expected) < 1e-6;
}

async function revertDocuments(): Promise<{ reverted: number; skips: Skip[] }> {
  const skips: Skip[] = [];
  let reverted = 0;

  const rows = await db
    .select({
      id: sourceDocuments.id,
      docNumber: sourceDocuments.docNumber,
      generation: sourceDocuments.dispatchGeneration,
      processedAt: sourceDocuments.processedAt,
      qtyRepair: sourceDocuments.qtyRepair,
    })
    .from(sourceDocuments)
    .where(
      onlyDocument
        ? and(eq(sourceDocuments.id, onlyDocument), isNotNull(sourceDocuments.qtyRepair))
        : isNotNull(sourceDocuments.qtyRepair),
    );

  for (const row of rows) {
    const trace = row.qtyRepair as QtyRepairTrace | null;
    if (!trace) continue;
    const applied = trace.entries.filter(isApplied);
    if (applied.length === 0) continue;
    const where = `документ ${row.docNumber ?? row.id}`;

    // Версия разбора: и поколение, и время записи. Поколение ловит ручной
    // повтор, время — автоматический переразбор внутри того же поколения.
    if (trace.generation !== row.generation) {
      skips.push({ where, reason: `поколение разбора ${row.generation} ≠ ${trace.generation}` });
      continue;
    }
    const processedAt = row.processedAt?.toISOString() ?? null;
    if (trace.docVersion != null && processedAt !== trace.docVersion) {
      skips.push({ where, reason: 'документ переразобран после правки' });
      continue;
    }

    await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      const items = await txDb
        .select({
          id: sourceDocumentItems.id,
          lineNo: sourceDocumentItems.lineNo,
          qty: sourceDocumentItems.qty,
        })
        .from(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, row.id))
        .for('update');

      const trace2 = await operationTrace(
        txDb,
        row.id,
        items.map((i) => i.id),
      );
      if (trace2) {
        skips.push({ where, reason: trace2 });
        return;
      }

      const nextEntries: QtyRepairEntry[] = [...trace.entries];
      let changed = false;
      for (const entry of applied) {
        const target =
          items.find((i) => entry.itemId != null && i.id === entry.itemId) ??
          items.find((i) => i.lineNo === entry.row);
        if (!target) {
          skips.push({ where: `${where}, строка ${entry.row}`, reason: 'строка не найдена' });
          continue;
        }
        if (!sameQty(target.qty, entry.qtyTo)) {
          skips.push({
            where: `${where}, строка ${entry.row}`,
            reason: `количество изменено после правки (${target.qty} ≠ ${entry.qtyTo})`,
          });
          continue;
        }
        if (apply) {
          await txDb
            .update(sourceDocumentItems)
            .set({ qty: entry.qtyFrom.toString() })
            .where(eq(sourceDocumentItems.id, target.id));
        }
        const idx = nextEntries.indexOf(entry);
        nextEntries[idx] = {
          ...entry,
          state: 'reverted',
          revertedAt: new Date().toISOString(),
        };
        changed = true;
        reverted += 1;
        console.log(
          `${apply ? 'откат' : 'отменил бы'}: ${where}, строка ${entry.row}: ` +
            `${entry.qtyTo} → ${entry.qtyFrom}`,
        );
      }

      // Количество и состояние следа — одной транзакцией: иначе останется
      // либо возвращённое количество с пометкой «применено», либо наоборот.
      if (changed && apply) {
        await txDb
          .update(sourceDocuments)
          .set({ qtyRepair: { ...trace, entries: nextEntries } })
          .where(eq(sourceDocuments.id, row.id));
      }
    });
  }

  return { reverted, skips };
}

async function revertPhotos(): Promise<{ reverted: number; skips: Skip[] }> {
  const skips: Skip[] = [];
  let reverted = 0;

  const rows = await db
    .select({
      id: photoRecognizedItems.id,
      docNumber: photoRecognizedItems.docNumber,
      updatedAt: photoRecognizedItems.updatedAt,
      items: photoRecognizedItems.items,
      qtyRepair: photoRecognizedItems.qtyRepair,
    })
    .from(photoRecognizedItems)
    .where(isNotNull(photoRecognizedItems.qtyRepair));

  for (const row of rows) {
    const trace = row.qtyRepair as QtyRepairTrace | null;
    if (!trace) continue;
    const applied = trace.entries.filter(isApplied);
    if (applied.length === 0) continue;
    const where = `фото-документ ${row.docNumber ?? row.id}`;

    // У снимка фото версия одна — время записи. Повторное распознавание
    // перезаписывает и items, и след, поэтому расхождение означает, что след
    // относится к другим числам.
    if (trace.docVersion != null && row.updatedAt.toISOString() !== trace.docVersion) {
      skips.push({ where, reason: 'фото распознано заново после правки' });
      continue;
    }

    const items = (row.items ?? []) as Array<Record<string, unknown>>;
    const nextItems = [...items];
    const nextEntries: QtyRepairEntry[] = [...trace.entries];
    let changed = false;

    for (const entry of applied) {
      const target = nextItems[entry.row - 1];
      if (!target) {
        skips.push({ where: `${where}, строка ${entry.row}`, reason: 'строка не найдена' });
        continue;
      }
      const current = Number(target.qty);
      if (!Number.isFinite(current) || Math.abs(current - entry.qtyTo) > 1e-6) {
        skips.push({
          where: `${where}, строка ${entry.row}`,
          reason: `количество изменено после правки (${String(target.qty)} ≠ ${entry.qtyTo})`,
        });
        continue;
      }
      nextItems[entry.row - 1] = { ...target, qty: entry.qtyFrom };
      nextEntries[nextEntries.indexOf(entry)] = {
        ...entry,
        state: 'reverted',
        revertedAt: new Date().toISOString(),
      };
      changed = true;
      reverted += 1;
      console.log(
        `${apply ? 'откат' : 'отменил бы'}: ${where}, строка ${entry.row}: ` +
          `${entry.qtyTo} → ${entry.qtyFrom}`,
      );
    }

    if (changed && apply) {
      // Условие по updated_at — защита от гонки с повторным распознаванием:
      // если оно успело записать снимок, наш откат не применится.
      await db
        .update(photoRecognizedItems)
        .set({
          items: nextItems,
          qtyRepair: { ...trace, entries: nextEntries },
        })
        .where(
          and(
            eq(photoRecognizedItems.id, row.id),
            sql`${photoRecognizedItems.updatedAt} = ${row.updatedAt}`,
          ),
        );
    }
  }

  return { reverted, skips };
}

async function main(): Promise<void> {
  console.log(apply ? '=== ОТКАТ (запись) ===' : '=== пробный прогон, ничего не пишем ===');
  const docs = await revertDocuments();
  const photos = await revertPhotos();

  const skips = [...docs.skips, ...photos.skips];
  console.log(`\nстрок ${apply ? 'откачено' : 'к откату'}: ${docs.reverted + photos.reverted}`);
  if (skips.length > 0) {
    console.log(`пропущено: ${skips.length}`);
    for (const s of skips) console.log(`  ${s.where}: ${s.reason}`);
  }
  process.exit(0);
}

void main();
