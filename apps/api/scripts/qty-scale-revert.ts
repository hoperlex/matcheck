/**
 * Откат правок количества, сделанных правилом ×1000 (qty-scale).
 *
 * Пишется вместе с правилом, а не после инцидента, по той же причине, что и
 * qty-repair-revert.ts: выключение QTY_SCALE_REPAIR останавливает новые правки,
 * но уже записанные не отменяет. Отличия от соседа:
 *
 *  - якорь правки — сама строка, а не время разбора. Строка отменяемая, если
 *    СЕЙЧАС `qty` равно исправленному значению, а `qty_read` — прочитанному
 *    моделью. `processed_at` для этого не годится: его перезаписывают сборка
 *    комплекта и арбитр повтора, и половина правок пропускалась бы как
 *    «переразобранные». Переразбор же заменяет позиции целиком, и `qty_read` у
 *    новых строк пуст — проверка по строке ловит его надёжно;
 *  - после отката документа пересчитываются сверка и исход разбора — тем же
 *    правилом, что и ручная правка позиций (routes/source-documents.ts). Иначе
 *    в карточке осталась бы зелёная сверка по исправленным числам рядом с
 *    возвращёнными 74000.
 *
 * Документ, оставивший след в операциях, не трогается (operationTrace в той же
 * транзакции): количество, уехавшее в приёмку или отгрузку, меняет человек.
 * Наблюдения (`observed`) не трогаются вовсе.
 *
 * По умолчанию НИЧЕГО не пишет — печатает, что было бы отменено.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/qty-scale-revert.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/qty-scale-revert.ts --apply
 *   … --document <uuid>   — только один документ (фото не трогаются)
 *   … --kind unpriced_million — только правило B (или lost_decimal_1000)
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { UpdValidation } from '@matcheck/contracts';
import { db } from '../src/db/client.js';
import { photoRecognizedItems, sourceDocumentItems, sourceDocuments } from '../src/db/schema.js';
import { operationTrace } from '../src/domain/sourceDocuments/operation-trace.js';
import { markSourceDocumentContentChanged } from '../src/domain/sourceDocuments/document-group.js';
import { mergePersistentUpdWarnings, validateUpdTotals } from '../src/domain/edo/upd-validation.js';
import { deriveUpdParseOutcome } from '../src/domain/edo/upd-outcome.js';
import type { QtyScaleEntry, QtyScaleKind, QtyScaleTrace } from '../src/domain/edo/qty-scale.js';

type Skip = { where: string; reason: string };

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
function flagValue(name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}
const onlyDocument = flagValue('--document');
const onlyKind = flagValue('--kind') as QtyScaleKind | undefined;
if (onlyKind && onlyKind !== 'lost_decimal_1000' && onlyKind !== 'unpriced_million') {
  console.error(`неизвестное правило: ${onlyKind}`);
  process.exit(2);
}

function revertable(e: QtyScaleEntry): boolean {
  return e.state === 'applied' && (onlyKind == null || e.kind === onlyKind);
}

/** numeric из БД приходит строкой «74.0000». */
function sameQty(value: unknown, expected: number): boolean {
  if (value == null) return false;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n - expected) < 1e-6;
}

const num = (v: string | null): number | null => (v == null ? null : Number(v));

async function revertDocuments(): Promise<{ reverted: number; skips: Skip[] }> {
  const skips: Skip[] = [];
  let reverted = 0;

  const rows = await db
    .select({ id: sourceDocuments.id, docNumber: sourceDocuments.docNumber })
    .from(sourceDocuments)
    .where(
      onlyDocument
        ? and(eq(sourceDocuments.id, onlyDocument), isNotNull(sourceDocuments.qtyScale))
        : isNotNull(sourceDocuments.qtyScale),
    );

  for (const { id } of rows) {
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as typeof db;
      // Шапку берём под блокировкой: между выборкой выше и этой транзакцией
      // документ мог переразобраться.
      const [sd] = await txDb
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.id, id))
        .for('update');
      const trace = sd?.qtyScale as QtyScaleTrace | null | undefined;
      if (!sd || !trace) return;
      const applied = trace.entries.filter(revertable);
      if (applied.length === 0) return;
      const where = `документ ${sd.docNumber ?? sd.id}`;

      const items = await txDb
        .select()
        .from(sourceDocumentItems)
        .where(eq(sourceDocumentItems.sourceDocumentId, id))
        .orderBy(sourceDocumentItems.lineNo)
        .for('update');

      const inOperation = await operationTrace(
        txDb,
        id,
        items.map((i) => i.id),
      );
      if (inOperation) {
        skips.push({ where, reason: inOperation });
        return;
      }

      const nextEntries: QtyScaleEntry[] = [...trace.entries];
      const revertedItemIds = new Map<string, number>();
      for (const entry of applied) {
        const target =
          items.find((i) => entry.itemId != null && i.id === entry.itemId) ??
          items.find((i) => i.lineNo === entry.row);
        const at = `${where}, строка ${entry.row}`;
        if (!target) {
          skips.push({ where: at, reason: 'строка не найдена' });
          continue;
        }
        if (!sameQty(target.qtyRead, entry.qtyFrom)) {
          skips.push({ where: at, reason: 'позиции заменены после правки (qty_read не совпал)' });
          continue;
        }
        if (!sameQty(target.qty, entry.qtyTo)) {
          skips.push({
            where: at,
            reason: `количество изменено после правки (${target.qty} ≠ ${entry.qtyTo})`,
          });
          continue;
        }
        revertedItemIds.set(target.id, entry.qtyFrom);
        nextEntries[nextEntries.indexOf(entry)] = {
          ...entry,
          state: 'reverted',
          revertedAt: new Date().toISOString(),
        };
        reverted += 1;
        console.log(
          `${apply ? 'откат' : 'отменил бы'}: ${at} (${entry.kind}): ${entry.qtyTo} → ${entry.qtyFrom}`,
        );
      }
      if (revertedItemIds.size === 0 || !apply) return;

      for (const [itemId, qtyFrom] of revertedItemIds) {
        await txDb
          .update(sourceDocumentItems)
          .set({ qty: qtyFrom.toString(), qtyRead: null })
          .where(eq(sourceDocumentItems.id, itemId));
      }

      // Сверка и исход — по возвращённым числам, только если сверка у
      // документа была (у накладных пакетного пути её нет).
      const header: Partial<typeof sourceDocuments.$inferInsert> = {
        qtyScale: { ...trace, entries: nextEntries },
        updatedAt: new Date(),
      };
      if (sd.validation != null) {
        const rows2 = items.map((i) => ({
          rowNo: i.rowNo ?? null,
          nameRaw: i.nameRaw,
          unit: i.unit,
          qty: revertedItemIds.get(i.id) ?? Number(i.qty),
          price: num(i.price),
          sum: num(i.sum),
          vatRate: num(i.vatRate),
          vatSum: num(i.vatSum),
        }));
        const validation = validateUpdTotals(
          { totalSum: num(sd.totalSum), vatSum: num(sd.vatSum), items: rows2 },
          { detectRecognitionWarnings: sd.llmProviderId != null },
        );
        header.validation = mergePersistentUpdWarnings(
          sd.validation as UpdValidation,
          validation,
        );
        // То же условие, что у ручной правки: дубликат и архив не трогаем.
        const touchable =
          sd.kind === 'upd' &&
          (sd.status === 'needs_resolution' || sd.status === 'parsed') &&
          sd.parseErrorCode !== 'duplicate_upd';
        if (touchable) {
          const outcome = deriveUpdParseOutcome(
            {
              items: rows2,
              docNumber: sd.docNumber,
              totalSum: num(sd.totalSum),
              confidence: num(sd.llmConfidence) ?? 0,
              itemsCount: null,
            },
            validation,
          );
          header.status = outcome.status;
          header.parseErrorCode = outcome.parseErrorCode;
          header.parseErrorDetails = outcome.parseErrorDetails as never;
        }
      }
      await txDb.update(sourceDocuments).set(header).where(eq(sourceDocuments.id, id));
      // Количество изменилось — планшет обязан забрать документ заново.
      await markSourceDocumentContentChanged(txDb, id);
    });
  }

  return { reverted, skips };
}

async function revertPhotos(): Promise<{ reverted: number; skips: Skip[] }> {
  const skips: Skip[] = [];
  let reverted = 0;
  if (onlyDocument) return { reverted, skips };

  const rows = await db
    .select({
      id: photoRecognizedItems.id,
      docNumber: photoRecognizedItems.docNumber,
      updatedAt: photoRecognizedItems.updatedAt,
      items: photoRecognizedItems.items,
      totalSum: photoRecognizedItems.totalSum,
      vatSum: photoRecognizedItems.vatSum,
      validation: photoRecognizedItems.validation,
      qtyScale: photoRecognizedItems.qtyScale,
    })
    .from(photoRecognizedItems)
    .where(isNotNull(photoRecognizedItems.qtyScale));

  for (const row of rows) {
    const trace = row.qtyScale as QtyScaleTrace | null;
    if (!trace) continue;
    const applied = trace.entries.filter(revertable);
    if (applied.length === 0) continue;
    const where = `фото-документ ${row.docNumber ?? row.id}`;

    // Повторное распознавание перезаписывает и items, и след вместе, поэтому
    // версия снимка — его время записи.
    if (trace.docVersion != null && row.updatedAt.toISOString() !== trace.docVersion) {
      skips.push({ where, reason: 'фото распознано заново после правки' });
      continue;
    }

    const nextItems = [...((row.items ?? []) as Array<Record<string, unknown>>)];
    const nextEntries: QtyScaleEntry[] = [...trace.entries];
    let changed = false;
    for (const entry of applied) {
      const at = `${where}, строка ${entry.row}`;
      const target = nextItems[entry.row - 1];
      if (!target) {
        skips.push({ where: at, reason: 'строка не найдена' });
        continue;
      }
      if (!sameQty(target.qty, entry.qtyTo)) {
        skips.push({ where: at, reason: `количество изменено (${String(target.qty)} ≠ ${entry.qtyTo})` });
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
        `${apply ? 'откат' : 'отменил бы'}: ${at} (${entry.kind}): ${entry.qtyTo} → ${entry.qtyFrom}`,
      );
    }
    if (!changed || !apply) continue;

    // Сверка фото есть только у УПД-ветки; у старого промпта её нет вовсе.
    const validation =
      row.validation != null
        ? validateUpdTotals(
            {
              totalSum: num(row.totalSum),
              vatSum: num(row.vatSum),
              items: nextItems.map((i) => ({
                rowNo: (i.rowNo as number | null | undefined) ?? null,
                qty: i.qty == null ? null : Number(i.qty),
                price: i.price == null ? null : Number(i.price),
                sum: i.sum == null ? null : Number(i.sum),
                vatRate: i.vatRate == null ? null : Number(i.vatRate),
                vatSum: i.vatSum == null ? null : Number(i.vatSum),
              })),
            },
            { detectRecognitionWarnings: true },
          )
        : null;

    // Условие по updated_at — защита от гонки с повторным распознаванием.
    await db
      .update(photoRecognizedItems)
      .set({
        items: nextItems as never,
        qtyScale: { ...trace, entries: nextEntries },
        ...(validation ? { validation } : {}),
      })
      .where(
        and(
          eq(photoRecognizedItems.id, row.id),
          sql`${photoRecognizedItems.updatedAt} = ${row.updatedAt}`,
        ),
      );
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
