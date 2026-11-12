/**
 * Адресный ремонт приёмки: вернуть строкам привязку к позициям документа.
 *
 * Все проверки и сама правка — src/domain/operations/relink-delivery-items.ts
 * (там же — почему каждая проверка нужна). Одна транзакция: любое несовпадение
 * откатывает всё, включая поднятую версию.
 *
 * Без --apply — СУХОЙ ПРОГОН: транзакция выполняет все проверки и правку, печатает
 * результат и откатывается. Так видно ровно то, что сделает --apply.
 *
 * Пары берутся из scripts/report-unlinked-delivery-items.ts (строка приёмки →
 * позиция документа). Ожидаемую версию — из карточки или из того же отчёта.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/relink-delivery-items.ts \
 *     --delivery <uuid> --document <uuid> --expect-version <N> \
 *     --pair <item-uuid>=<doc-item-uuid> [--pair ...] [--apply]
 */
import { sql } from '../src/db/client.js';
import {
  relinkDeliveryItems,
  RelinkRefusedError,
  type RelinkPair,
  type RelinkResult,
} from '../src/domain/operations/relink-delivery-items.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

function pairs(): RelinkPair[] {
  const out: RelinkPair[] = [];
  process.argv.forEach((a, i) => {
    if (a !== '--pair') return;
    const raw = process.argv[i + 1] ?? '';
    const [itemId, sourceDocumentItemId] = raw.split('=');
    if (!itemId || !sourceDocumentItemId) {
      throw new Error(`--pair ожидает <строка>=<позиция>, получено «${raw}»`);
    }
    out.push({ itemId, sourceDocumentItemId });
  });
  return out;
}

const APPLY = process.argv.includes('--apply');

/** Сигнал отката сухого прогона: несёт результат наружу из транзакции. */
class DryRun extends Error {
  constructor(readonly result: RelinkResult) {
    super('dry run');
  }
}

async function main(): Promise<void> {
  const deliveryId = arg('--delivery');
  const documentId = arg('--document');
  const expectRaw = arg('--expect-version');
  if (!deliveryId || !documentId || !expectRaw) {
    throw new Error('нужны --delivery, --document, --expect-version и хотя бы одна --pair');
  }
  const input = {
    deliveryId,
    documentId,
    expectedVersion: Number(expectRaw),
    pairs: pairs(),
  };

  console.log(`Режим: ${APPLY ? 'ПРИМЕНЕНИЕ' : 'сухой прогон (будет откат)'}.`);
  console.log(`Приёмка ${deliveryId}, документ ${documentId}, ожидаемая версия ${expectRaw}.`);

  let result: RelinkResult;
  try {
    result = (await sql.begin(async (tx) => {
      const r = await relinkDeliveryItems(tx, input);
      if (!APPLY) throw new DryRun(r);
      return r;
    })) as RelinkResult;
  } catch (err) {
    if (err instanceof DryRun) {
      result = err.result;
    } else if (err instanceof RelinkRefusedError) {
      console.error(`ОТКАЗ, ничего не изменено: ${err.message}`);
      process.exitCode = 2;
      return;
    } else {
      throw err;
    }
  }

  for (const r of result.rows) {
    console.log(
      `   «${r.nameRaw.slice(0, 60)}» → ${r.sourceDocumentItemId}, единица ${r.unitBefore} → ${r.unitAfter}`,
    );
  }
  console.log(`Строк: ${result.rows.length}, версия станет ${result.versionAfter}.`);
  console.log(APPLY ? 'Применено.' : 'Ничего не изменено: запуск без --apply.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  });
