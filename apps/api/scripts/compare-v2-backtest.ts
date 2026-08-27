/**
 * Проверка нового правила выбора на ИСТОРИЧЕСКИХ парах — без вызовов модели.
 *
 * Зачем. Правку `chooseBetterUpdResult` нельзя проверить по агрегату: новое
 * правило по определению чаще заменяет базу, и падение доли `kept_baseline`
 * ничего не докажет. Нужен поимённый список случаев, где решения разошлись.
 *
 * Откуда берутся данные. `llm_calls.response_parsed` хранит разобранный ответ
 * модели (заполнен у 3673 вызовов из 3780 за 60 дней), а у документа со вторым
 * проходом таких вызовов два: первый проход и повтор. Значит пара «база —
 * кандидат» восстановима из журнала целиком, и ни одного нового обращения к
 * модели не требуется.
 *
 * Оговорка о точности. Восстановленная база — это ответ модели, а не то, что
 * реально легло в `source_documents`: при сохранении применяются нормализации
 * (синтез итога, приведение НДС к шапке). Поэтому бэктест отвечает на вопрос
 * «как правила решают на одних и тех же разборах», а не «что было бы в базе».
 *
 * Запуск на сервере:
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T --user root \
 *     -v /srv/matcheck/app/retry-reports:/reports \
 *     matcheck-api node_modules/.bin/tsx scripts/compare-v2-backtest.ts \
 *     --days 60 --out /reports/backtest.json
 *
 * Только читает БД. Ничего не пишет, кроме файла отчёта.
 */
import { sql as drSql } from 'drizzle-orm';
import type { UpdPdfParsed } from '@matcheck/contracts';
import { chooseV1, chooseV2 } from '../src/domain/edo/upd-result-compare.js';
import { writeReportSafely } from './prompt-ab-lib.js';
import { db } from '../src/db/client.js';

function argValue(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

type Row = {
  id: string;
  doc_number: string | null;
  outcome: string | null;
  first_parsed: unknown;
  last_parsed: unknown;
};

/** Ответ модели → форма, которую понимают правила сравнения. */
function toParsed(raw: unknown): UpdPdfParsed | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const items = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : [];
  const num = (v: unknown): number | null =>
    v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    docNumber: (o.docNumber as string | null) ?? null,
    docDate: (o.docDate as string | null) ?? null,
    totalSum: num(o.totalSum),
    vatSum: num(o.vatSum),
    itemsCount: num(o.itemsCount),
    confidence: num(o.confidence),
    supplier: null,
    recipient: null,
    consignee: null,
    items: items.map((i) => ({
      rowNo: num(i.rowNo),
      nameRaw: (i.nameRaw as string | null) ?? null,
      qty: num(i.qty),
      unit: (i.unit as string | null) ?? null,
      price: num(i.price),
      sum: num(i.sum),
      vatRate: num(i.vatRate),
      vatSum: num(i.vatSum),
      volumeM3: num(i.volumeM3),
      massKg: num(i.massKg),
      volumeConfidence: (i.volumeConfidence as string | null) ?? null,
      groupName: (i.groupName as string | null) ?? null,
    })),
  } as UpdPdfParsed;
}

async function main(): Promise<void> {
  const days = Number(argValue('--days', '60'));
  const outPath = argValue('--out');

  // Первый и последний разбор документа, у которого был второй проход.
  const rows = await db.execute<Row>(drSql`
    WITH calls AS (
      SELECT c.source_document_id AS id, c.response_parsed, c.created_at,
             row_number() OVER (PARTITION BY c.source_document_id ORDER BY c.created_at)      AS rn_first,
             row_number() OVER (PARTITION BY c.source_document_id ORDER BY c.created_at DESC) AS rn_last
        FROM llm_calls c
       WHERE c.source_document_id IS NOT NULL
         AND c.response_parsed IS NOT NULL
         AND c.created_at > now() - make_interval(days => ${days})
    )
    SELECT sd.id::text,
           sd.doc_number,
           sd.second_pass->>'outcome' AS outcome,
           f.response_parsed AS first_parsed,
           l.response_parsed AS last_parsed
      FROM source_documents sd
      JOIN calls f ON f.id = sd.id AND f.rn_first = 1
      JOIN calls l ON l.id = sd.id AND l.rn_last = 1
     WHERE sd.second_pass IS NOT NULL
       AND f.created_at < l.created_at
     ORDER BY sd.created_at DESC
  `);

  const list = [...rows] as Row[];
  console.log(`[backtest] пар восстановлено: ${list.length} (окно ${days} дн.)`);

  const results: unknown[] = [];
  let agree = 0;
  let differ = 0;

  for (const r of list) {
    const base = toParsed(r.first_parsed);
    const candidate = toParsed(r.last_parsed);
    if (!base || !candidate) continue;

    const v1 = chooseV1(base, candidate);
    const v2 = chooseV2(base, candidate);
    const same = v1.winner === v2.winner;
    if (same) agree += 1;
    else differ += 1;

    results.push({
      id: r.id,
      docNumber: r.doc_number,
      historicalOutcome: r.outcome,
      v1: { winner: v1.winner, reasons: v1.reasons },
      v2: { winner: v2.winner, reasons: v2.reasons },
      differ: !same,
    });

    console.log(
      `  ${r.id.slice(0, 8)} № ${r.doc_number ?? '∅'} [${r.outcome ?? '—'}] ` +
        `v1=${v1.winner} v2=${v2.winner}${same ? '' : '  ← РАЗОШЛИСЬ'}`,
    );
    if (!same) {
      console.log(`      v1: ${v1.reasons.join('; ')}`);
      console.log(`      v2: ${v2.reasons.join('; ')}`);
    }
  }

  console.log(`\n[backtest] совпало: ${agree}, разошлось: ${differ}`);
  if (differ > 0) {
    console.log('[backtest] каждое расхождение разобрать вручную по оригиналу документа');
  }

  if (outPath) {
    await writeReportSafely(
      outPath,
      { formatVersion: 1 as const, days, pairs: list.length, agree, differ, results },
      (line) => console.log(`\n[backtest] ${line}`),
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
