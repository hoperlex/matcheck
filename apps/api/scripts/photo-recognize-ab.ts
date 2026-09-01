/**
 * Сверка двух путей распознавания фото документа: прежний терпимый промпт
 * (domain/photos/recognize.ts) против маршрутизации УПД в основной парсер
 * (classifyImageKind → domain/photos/recognize-upd.ts).
 *
 * Зачем отдельный скрипт. Включение PHOTO_RECOGNIZE_UPD_ROUTE меняет исход уже
 * распознаваемых фото, и «стало лучше на двух примерах» — не основание. Главный
 * риск не в УПД, ради которых всё затевается, а в ЛОЖНОЙ классификации: если
 * классификатор примет транспортную накладную или рукописную бумагу за УПД,
 * строгий промпт вернёт по ней меньше, чем терпимый, и мы потеряем то, что
 * работало. Поэтому выборка стратифицированная, а не «первые N подряд».
 *
 * Что делает: берёт фото ИЗ КЭША распознаваний (там уже есть результат прежнего
 * пути и ссылка на S3-ключ), прогоняет каждое обоими путями и печатает сводку
 * по стратам: где число позиций выросло, где упало, куда ушла классификация,
 * сколько раз сработал бы фолбэк.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/photo-recognize-ab.ts --limit 15
 *   … --strata upd_defect,upd_clean --limit 10 --delay 2000
 *   … --out /tmp/photo-ab.json
 *
 * Страты (--strata, по умолчанию все):
 *   upd_defect  — похоже на УПД и есть признак дефекта: количество равно коду
 *                 ОКЕИ своей единицы либо qty × price расходится с sum;
 *   upd_clean   — похоже на УПД и арифметика сходится: замок против регресса;
 *   waybill     — форма распознана как ТН/ОС-2 (docForm) — ложная
 *                 классификация как УПД видна именно здесь;
 *   other       — всё остальное, включая рукописные и бумаги без цен.
 *
 * Стоит денег: на каждое фото — классификация плюс УПД-разбор (прежний путь не
 * перезапускается, его результат берётся из кэша). НИЧЕГО не пишет: ни в
 * photo_recognized_items, ни в source_documents. Строки в llm_calls появляются
 * с source_document_id = NULL, как и у прочих офлайн-сверок.
 */
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { loadEnv } from '../src/lib/env.js';
import { getObject } from '../src/domain/storage/s3.signer.js';
import { classifyImageKind } from '../src/domain/edo/vision-classifier.js';
import { recognizePhotoUpd } from '../src/domain/photos/recognize-upd.js';

type Stratum = 'upd_defect' | 'upd_clean' | 'waybill' | 'other';
const ALL_STRATA: Stratum[] = ['upd_defect', 'upd_clean', 'waybill', 'other'];

type CachedRow = {
  id: string;
  s3_key: string;
  doc_number: string | null;
  doc_form: string | null;
  items: Array<{
    nameRaw?: string;
    qty?: number | null;
    unit?: string | null;
    price?: number | null;
    sum?: number | null;
  }>;
};

type Outcome = {
  stratum: Stratum;
  photoId: string;
  docNumber: string | null;
  baseItems: number;
  classified: string | null;
  classifyConfidence: number | null;
  updItems: number | null;
  updConfidence: number | null;
  /** Что сделал бы роут: 'upd' — принял разбор, 'fallback' — вернулся к прежнему. */
  decision: 'upd' | 'fallback' | 'not_upd';
  error?: string;
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Код ОКЕИ по единице — тот же список, что в контрактах (suspectUnitCodeAsQty). */
const OKEI: Record<string, number> = {
  шт: 796,
  м: 6,
  м2: 55,
  м3: 113,
  кг: 166,
  т: 168,
  упак: 778,
  л: 112,
};

function normUnit(u: string | null | undefined): string {
  return (u ?? '').toLowerCase().replace(/²/g, '2').replace(/³/g, '3').replace(/[.\s]/g, '');
}

function stratumOf(row: CachedRow): Stratum {
  if (row.doc_form === 'tn_2116' || row.doc_form === 'os2') return 'waybill';
  const items = row.items ?? [];
  if (items.length === 0) return 'other';
  const hasMoney = items.some((i) => i.price != null && i.sum != null);
  if (!hasMoney) return 'other';
  const okeiAsQty = items.some(
    (i) => i.qty != null && OKEI[normUnit(i.unit)] != null && OKEI[normUnit(i.unit)] === i.qty,
  );
  const arithmeticOff = items.some((i) => {
    if (i.qty == null || i.price == null || i.sum == null || i.qty === 0 || i.sum === 0)
      return false;
    return Math.abs(i.qty * i.price - i.sum) > Math.max(1, Math.abs(i.sum) * 0.01);
  });
  return okeiAsQty || arithmeticOff ? 'upd_defect' : 'upd_clean';
}

const MIN_CONFIDENCE = 0.6;

async function main(): Promise<void> {
  const limit = Number(arg('limit', '10'));
  const delayMs = Number(arg('delay', '1500'));
  const strata = (arg('strata') ?? ALL_STRATA.join(',')).split(',') as Stratum[];
  const out = arg('out');

  const sql = postgres(loadEnv().DATABASE_URL, { max: 2 });
  try {
    // Кандидаты берутся из кэша: там уже лежит результат прежнего пути, и
    // повторять его вызов незачем — сверяем с тем, что менеджер видит сейчас.
    const rows = await sql<CachedRow[]>`
      SELECT p.id, dp.s3_key, p.doc_number, p.doc_form, p.items
      FROM photo_recognized_items p
      JOIN delivery_photos dp ON dp.id = p.delivery_photo_id
      WHERE p.error_message IS NULL
        AND p.parser = 'photo_v1'
        AND p.created_at > now() - interval '30 days'
      ORDER BY p.created_at DESC
      LIMIT 2000`;

    const buckets = new Map<Stratum, CachedRow[]>(ALL_STRATA.map((s) => [s, []]));
    for (const row of rows) buckets.get(stratumOf(row))!.push(row);

    const plan: Array<{ stratum: Stratum; row: CachedRow }> = [];
    for (const s of strata) {
      for (const row of (buckets.get(s) ?? []).slice(0, limit)) plan.push({ stratum: s, row });
    }

    console.log('Выборка по стратам:');
    for (const s of ALL_STRATA) {
      const picked = plan.filter((p) => p.stratum === s).length;
      console.log(
        `  ${s.padEnd(11)} доступно ${String(buckets.get(s)!.length).padStart(5)}, берём ${picked}`,
      );
    }
    console.log(`Вызовов модели: ~${plan.length * 2} (классификация + разбор).\n`);

    const results: Outcome[] = [];
    for (const { stratum, row } of plan) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const base = (row.items ?? []).length;
      const outcome: Outcome = {
        stratum,
        photoId: row.id,
        docNumber: row.doc_number,
        baseItems: base,
        classified: null,
        classifyConfidence: null,
        updItems: null,
        updConfidence: null,
        decision: 'not_upd',
      };
      try {
        const buffer = await getObject(row.s3_key);
        const mimeType = row.s3_key.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        const cls = await classifyImageKind(buffer, mimeType, {
          sourceDocumentId: null,
          label: `ab:${row.id}`,
          timeoutMs: 45_000,
        });
        outcome.classified = cls?.kind ?? null;
        outcome.classifyConfidence = cls?.confidence ?? null;
        if (cls && cls.kind === 'upd' && cls.confidence >= MIN_CONFIDENCE) {
          const upd = await recognizePhotoUpd({ buffer, mimeType, label: `ab:${row.id}` });
          outcome.updItems = upd.items.length;
          outcome.updConfidence = upd.confidence;
          outcome.decision =
            upd.items.length > 0 && (upd.confidence ?? 0) >= MIN_CONFIDENCE ? 'upd' : 'fallback';
        }
      } catch (err) {
        outcome.error = err instanceof Error ? err.message.slice(0, 200) : String(err);
        outcome.decision = 'fallback';
      }
      results.push(outcome);
      const mark =
        outcome.decision === 'upd'
          ? `${outcome.baseItems} → ${outcome.updItems}`
          : outcome.decision === 'fallback'
            ? 'фолбэк'
            : `оставлено прежнему (${outcome.classified ?? 'null'})`;
      console.log(
        `[${stratum}] № ${outcome.docNumber ?? '—'} ${mark}${outcome.error ? ` ошибка: ${outcome.error}` : ''}`,
      );
    }

    console.log('\nИтог по стратам:');
    let regressions = 0;
    for (const s of ALL_STRATA) {
      const part = results.filter((r) => r.stratum === s);
      if (part.length === 0) continue;
      const toUpd = part.filter((r) => r.decision === 'upd');
      const grew = toUpd.filter((r) => (r.updItems ?? 0) > r.baseItems).length;
      const same = toUpd.filter((r) => (r.updItems ?? 0) === r.baseItems).length;
      const lost = toUpd.filter((r) => (r.updItems ?? 0) < r.baseItems).length;
      regressions += s === 'waybill' || s === 'other' ? toUpd.length : lost;
      console.log(
        `  ${s.padEnd(11)} всего ${part.length}, в УПД-ветку ${toUpd.length} ` +
          `(позиций больше ${grew}, столько же ${same}, меньше ${lost}), ` +
          `фолбэков ${part.filter((r) => r.decision === 'fallback').length}`,
      );
    }
    console.log(
      `\nПод подозрением на регресс: ${regressions} ` +
        '(не-УПД, ушедшие в УПД-ветку, плюс УПД с потерей позиций).',
    );

    if (out) {
      await writeFile(
        out,
        JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2),
      );
      console.log(`Отчёт: ${out}`);
    }
    // Ненулевой код возврата — чтобы прогон годился для пайплайна, а не только
    // для чтения глазами.
    if (regressions > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

await main();
