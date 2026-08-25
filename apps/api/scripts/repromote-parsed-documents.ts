/**
 * Документы, которые по новому правилу готовы к приёмке, но лежат у менеджера.
 *
 * До миграции 0107 в `parsed` пускали только полностью распознанный УПД: номер,
 * дата, сумма, позиции и сошедшиеся до копейки суммы. Инспектор видит только
 * `parsed`, поэтому документы, по которым приёмку провести можно — есть номер и
 * список материалов, — оставались на портале. На боевой базе 17.08.2026 таких
 * накопилось 48.
 *
 * Скрипт прогоняет их через ТО ЖЕ правило, что и свежий разбор
 * (`deriveUpdParseOutcome`), а не повторяет его условия: разъехавшись, они дали
 * бы разный исход на одинаковых данных.
 *
 * Что делает с каждым документом, признанным готовым, ОДНОЙ транзакцией:
 *   * статус → `parsed`, код ошибки — по правилу (расхождение сумм остаётся
 *     пометкой `validation_mismatch`);
 *   * итог, посчитанный по строкам, если в шапке его нет;
 *   * пересчитанный `validation` — иначе в списке осталось бы предупреждение,
 *     посчитанное по пустой сумме;
 *   * `group_revision` машины и переход видимости: без них планшет не узнает,
 *     что документ появился.
 *
 * ЧЕГО НЕ ДЕЛАЕТ. Не пересобирает распавшиеся поставки: откат сборки уже удалил
 * манифест и перевёл пакет в `legacy`, и документы такой поставки уедут
 * инспектору отдельными карточками. Собрать их в машину можно только повторной
 * сборкой — это отдельная задача. Не трогает дубликаты (`duplicate_upd`) и
 * заглушки: там решение за человеком.
 *
 * ПО УМОЛЧАНИЮ НИЧЕГО НЕ ПИШЕТ — печатает, что сделал бы. Запись только с
 * --apply.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/repromote-parsed-documents.ts
 *   pnpm --filter @matcheck/api tsx scripts/repromote-parsed-documents.ts --apply
 *   pnpm --filter @matcheck/api tsx scripts/repromote-parsed-documents.ts --limit 10 --apply
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { sourceDocumentItems, sourceDocuments } from '../src/db/schema.js';
import { deriveUpdParseOutcome } from '../src/domain/edo/upd-outcome.js';
import { validateUpdTotals } from '../src/domain/edo/upd-validation.js';
import { bumpGroupRevision } from '../src/domain/sourceDocuments/document-group.js';
import { recordVisibilityTransitions } from '../src/domain/sourceDocuments/visibility-events.js';

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const apply = process.argv.includes('--apply');
const limit = Number(argValue('--limit') ?? '500');

async function main(): Promise<void> {
  const candidates = await db
    .select({
      id: sourceDocuments.id,
      docNumber: sourceDocuments.docNumber,
      docDate: sourceDocuments.docDate,
      totalSum: sourceDocuments.totalSum,
      vatSum: sourceDocuments.vatSum,
      parseErrorCode: sourceDocuments.parseErrorCode,
      parseErrorDetails: sourceDocuments.parseErrorDetails,
      confidence: sourceDocuments.llmConfidence,
    })
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.kind, 'upd'),
        eq(sourceDocuments.isTechnical, false),
        eq(sourceDocuments.status, 'needs_resolution'),
        inArray(sourceDocuments.parseErrorCode, ['partial_parse', 'validation_mismatch']),
      ),
    )
    .limit(limit);

  console.info(
    `[repromote] кандидатов на проверку: ${candidates.length}${apply ? '' : ' (dry-run)'}`,
  );

  let promoted = 0;
  let skipped = 0;

  for (const doc of candidates) {
    const items = await db
      .select()
      .from(sourceDocumentItems)
      .where(eq(sourceDocumentItems.sourceDocumentId, doc.id))
      .orderBy(sourceDocumentItems.lineNo);

    const parsedItems = items.map((i) => ({
      qty: Number(i.qty),
      price: i.price != null ? Number(i.price) : null,
      sum: i.sum != null ? Number(i.sum) : null,
      vatRate: i.vatRate != null ? Number(i.vatRate) : null,
      vatSum: i.vatSum != null ? Number(i.vatSum) : null,
    }));

    // «Всего наименований» в БД не хранится — сверять полноту списка нечем,
    // и по принятому правилу такой список считается полным. Осознанно: у
    // фотографий и сканов счётчик не читается почти никогда.
    const headerTotal = doc.totalSum != null ? Number(doc.totalSum) : null;
    const validationBefore = validateUpdTotals({
      totalSum: headerTotal,
      vatSum: doc.vatSum != null ? Number(doc.vatSum) : null,
      itemsCount: null,
      items: parsedItems,
    });
    const outcome = deriveUpdParseOutcome(
      {
        items: parsedItems,
        docNumber: doc.docNumber,
        totalSum: headerTotal,
        confidence: doc.confidence != null ? Number(doc.confidence) : 0,
        itemsCount: null,
      },
      validationBefore,
    );

    if (outcome.status !== 'parsed') {
      skipped++;
      const missing = (outcome.parseErrorDetails as { missing?: string[] } | null)?.missing ?? [];
      console.info(`[repromote] ${doc.id} — пропуск: ${missing.join(', ') || 'не готов'}`);
      continue;
    }

    // Итог посчитан по строкам — сверку пересчитываем, иначе в карточке
    // останется предупреждение, посчитанное по пустой сумме.
    const finalTotal = outcome.totalSum;
    const validation =
      outcome.totalSumSynthesized && finalTotal != null
        ? validateUpdTotals({
            totalSum: finalTotal,
            vatSum: doc.vatSum != null ? Number(doc.vatSum) : null,
            itemsCount: null,
            items: parsedItems,
          })
        : validationBefore;

    console.info(
      `[repromote] ${doc.id} № ${doc.docNumber ?? '—'}: ${doc.parseErrorCode} → parsed` +
        `${outcome.totalSumSynthesized ? `, итог посчитан по строкам = ${finalTotal}` : ''}` +
        `${outcome.parseErrorCode === 'validation_mismatch' ? ', с пометкой о суммах' : ''}`,
    );

    if (!apply) {
      promoted++;
      continue;
    }

    await db.transaction(async (tx) => {
      await tx
        .update(sourceDocuments)
        .set({
          status: 'parsed',
          parseErrorCode: outcome.parseErrorCode,
          parseErrorDetails: outcome.parseErrorDetails as never,
          ...(outcome.totalSumSynthesized && finalTotal != null
            ? { totalSum: finalTotal.toString() }
            : {}),
          validation,
          updatedAt: new Date(),
        })
        .where(eq(sourceDocuments.id, doc.id));

      // Планшет узнаёт о появлении документа только через версию группы и
      // журнал видимости: дельта /sync отбирает по updated_at группы, а не
      // одного документа.
      await bumpGroupRevision(tx as never, doc.id);
      await recordVisibilityTransitions(tx as never, {
        documentIds: [doc.id],
        reason: 'документ признан готовым по правилу «номер + материалы»',
      });
    });

    promoted++;
  }

  console.info(
    `[repromote] итог: ${apply ? 'переведено' : 'перевели бы'} ${promoted}, пропущено ${skipped}`,
  );
  if (!apply) console.info('[repromote] это был dry-run; для записи добавьте --apply');
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
