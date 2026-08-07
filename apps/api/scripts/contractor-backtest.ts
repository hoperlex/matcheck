/**
 * Бэктест автоподстановки подрядчика по покупателю УПД.
 *
 * Зачем. Резолвер проставляет contractor_id, а от этого поля зависят ярлык
 * «Черновик», подбор документа к приёмке и (после этапа 2) видимость роли
 * contractor. Прежде чем включать его на боевом потоке, нужно знать не «работает
 * ли», а насколько часто он ошибается — и на каких именно документах.
 *
 * Как считает. Берёт документы, где подрядчика проставил ЧЕЛОВЕК, прогоняет по
 * ним резолвер и сравнивает результат с человеческим решением. Сравнение по ИНН,
 * а не по id записи справочника: у СУ-10 в counterparties четыре строки с одним
 * ИНН, и сравнение по id показало бы расхождение там, где его нет.
 *
 * Две метрики называются раздельно, потому что смешивать их нельзя:
 *   precision — доля верных среди ВЫПОЛНЕННЫХ назначений. Отвечает на вопрос
 *               «если резолвер что-то подставил, насколько этому верить»;
 *   accuracy  — доля верных среди всех размеченных документов, включая отказы.
 *               Отказ не ошибка: документ просто останется черновиком.
 * Отдельно печатается покрытие по всем inbound-документам — сколько из них
 * резолвер тронул бы вообще.
 *
 * Оговорка про выборку. Размеченные документы пришли из РУЧНОЙ загрузки, а
 * работать резолвер будет на публичном канале. Это оценка самого резолвера, а не
 * прогноз доли черновиков после включения.
 *
 * Запуск (только чтение, ничего не пишет):
 *   pnpm --filter @matcheck/api exec tsx scripts/contractor-backtest.ts
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db, sql as pg } from '../src/db/client.js';
import { counterparties, sourceDocuments } from '../src/db/schema.js';
import { normalizeInn, resolveContractorByBuyerInn } from '../src/domain/sourceDocuments/resolve-contractor.js';

type Verdict = 'correct' | 'wrong' | 'refused';

async function main(): Promise<void> {
  const buyer = { id: counterparties.id, inn: counterparties.inn, name: counterparties.name };

  // Размеченная выборка: получатель проставлен человеком и покупатель распознан.
  const rows = await db
    .select({
      id: sourceDocuments.id,
      docNumber: sourceDocuments.docNumber,
      buyerInn: sql<string | null>`(select c.inn from counterparties c where c.id = ${sourceDocuments.buyerId})`,
      buyerNameRaw: sourceDocuments.buyerNameRaw,
      humanContractorInn: sql<
        string | null
      >`(select c.inn from counterparties c where c.id = ${sourceDocuments.contractorId})`,
      humanContractorName: sql<
        string | null
      >`(select c.name from counterparties c where c.id = ${sourceDocuments.contractorId})`,
    })
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.isTechnical, false),
        eq(sourceDocuments.direction, 'inbound'),
        isNotNull(sourceDocuments.contractorId),
        isNotNull(sourceDocuments.buyerId),
      ),
    );

  const tally: Record<Verdict, number> = { correct: 0, wrong: 0, refused: 0 };
  const problems: string[] = [];

  for (const r of rows) {
    const match = await resolveContractorByBuyerInn(db, r.buyerInn);
    if (!match) {
      tally.refused++;
      const why = normalizeInn(r.buyerInn) ? 'нет среди подрядчиков' : 'ИНН не прошёл проверку';
      problems.push(
        `ОТКАЗ    №${r.docNumber ?? '—'}: покупатель ${r.buyerNameRaw ?? '—'} (${r.buyerInn ?? 'без ИНН'}) — ${why}; человек выбрал ${r.humanContractorName ?? '—'}`,
      );
      continue;
    }
    const [resolved] = await db
      .select({ inn: buyer.inn })
      .from(counterparties)
      .where(eq(counterparties.id, match.contractorId))
      .limit(1);
    if (resolved?.inn && resolved.inn === r.humanContractorInn) {
      tally.correct++;
    } else {
      tally.wrong++;
      problems.push(
        `ОШИБКА   №${r.docNumber ?? '—'}: резолвер → ${match.name} (${resolved?.inn ?? '—'}), человек → ${r.humanContractorName ?? '—'} (${r.humanContractorInn ?? '—'})`,
      );
    }
  }

  // Покрытие считаем по ВСЕМ inbound-документам, а не только по размеченным:
  // именно эта доля показывает, скольким документам подстановка вообще нашлась.
  const allInbound = await db
    .select({ id: sourceDocuments.id, buyerId: sourceDocuments.buyerId })
    .from(sourceDocuments)
    .where(and(eq(sourceDocuments.isTechnical, false), eq(sourceDocuments.direction, 'inbound')));
  let wouldAssign = 0;
  for (const d of allInbound) {
    if (!d.buyerId) continue;
    const [b] = await db
      .select({ inn: counterparties.inn })
      .from(counterparties)
      .where(eq(counterparties.id, d.buyerId))
      .limit(1);
    if (await resolveContractorByBuyerInn(db, b?.inn ?? null)) wouldAssign++;
  }

  const labeled = rows.length;
  const assigned = tally.correct + tally.wrong;
  const pct = (n: number, total: number) => (total === 0 ? '—' : `${((n / total) * 100).toFixed(2)}%`);

  console.log('\n=== Бэктест автоподстановки подрядчика ===\n');
  console.log(`Размеченных документов (подрядчик от человека + покупатель распознан): ${labeled}`);
  console.log(`  верно     ${tally.correct}`);
  console.log(`  ошибочно  ${tally.wrong}`);
  console.log(`  отказ     ${tally.refused}  (документ останется «Черновиком»)`);
  console.log('');
  console.log(`precision (верные / выполненные назначения): ${tally.correct}/${assigned} = ${pct(tally.correct, assigned)}`);
  console.log(`accuracy  (верные / все размеченные):        ${tally.correct}/${labeled} = ${pct(tally.correct, labeled)}`);
  console.log(`покрытие  (назначения / все inbound):        ${wouldAssign}/${allInbound.length} = ${pct(wouldAssign, allInbound.length)}`);

  if (problems.length) {
    console.log('\n--- Расхождения поимённо ---');
    for (const p of problems) console.log(p);
  }
  console.log(
    '\nВыборка — документы ручной загрузки; резолвер работает на публичном канале.\nЭто оценка резолвера, а не прогноз доли черновиков.\n',
  );

  await pg.end({ timeout: 5 });
}

main().catch(async (err) => {
  console.error(err);
  await pg.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
});
