/**
 * Офлайн-бэктест перепроверки ТОРГ-12 (TORG12_RECHECK) перед режимом `on`.
 *
 * Один вопрос: превратит ли перепроверка в «УПД» что-нибудь, кроме листов
 * товарной накладной ТОРГ-12. На бою режим shadow набирает случаи медленно
 * (несколько в день), поэтому здесь берётся прошлый месяц сразу.
 *
 * Три части:
 *   1. ФАЙЛЫ не РОКВУЛ — детерминированно-случайная выборка решений роутера
 *      «М-15» и «ТН» за --days дней (не больше одного файла на пакет). Базовый
 *      вердикт — из сохранённого следа file_classification, повторно
 *      базовый вопрос не задаётся. Один вызов на файл: текст CLASSIFY_PROMPT_TORG12,
 *      затем mergeFileVerdict, как в воркере.
 *   2. ПАКЕТЫ не РОКВУЛ — сборки, где классификатор страниц назвал страницы
 *      «ТН» / «сертификат» / «М-15». Страницы восстанавливаются по pageMap
 *      сохранённого следа page_classification, базовая классификация — из него
 *      же. Один вызов на порцию: PAGE_CLASSIFY_TORG12_PROMPT, затем
 *      mergePageVerdicts.
 *   3. ПАРЫ РОКВУЛ (8 известных пакетов, лист 1 + лист 2) — пакет целиком, как
 *      его прошёл бы воркер при `on`: перепроверка файлов «М-15/ТН» → кандидаты
 *      сборки → классификация страниц обычным текстом → перепроверка → нарезка
 *      с перестановкой. Ожидание — один уверенный сегмент, шапка первой.
 *
 * Ворота: в частях 1–2 ноль замен. Любая замена — файл или пакет копируется в
 * --out/review для просмотра глазами, код выхода 1. Часть 3 — польза, а не
 * безопасность: итог печатается отдельно.
 *
 * Скрипт НИЧЕГО не пишет в БД: все запросы идут в транзакциях READ ONLY.
 * Поэтому классификация файла повторяет classifyImageKind без его записи в
 * llm_calls: тот же текст промпта, температура 0, потолок 200 токенов, PDF —
 * первая страница через poppler, разбор ответа через normalizeKind. Меняются
 * эти параметры в vision-classifier.ts — менять и здесь.
 *
 * Режим разреза по номерам на бою выключен (`splitMode: off` во всех следах),
 * поэтому страницы спрашиваются текстом без номера — как в воркере. Пакеты с
 * другим splitMode в выборку не попадают.
 *
 * Запуск на hub (вызовы модели платные, их число печатается до старта):
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps --user root \
 *     -v /srv/matcheck/torg12-backtest:/out matcheck-api \
 *     node_modules/.bin/tsx scripts/torg12-recheck-backtest.ts --out /out
 *   # только отбор, без вызовов модели:
 *   ... scripts/torg12-recheck-backtest.ts --plan-only
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { getObject } from '../src/domain/storage/s3.signer.js';
import { renderPdf, toClassifyThumb, imageToVisionPage } from '../src/domain/edo/page-render.js';
import {
  classifyPages,
  PAGE_CLASSIFY_TORG12_PROMPT,
  type PageClassification,
} from '../src/domain/edo/upd-page-prefilter.js';
import {
  mergeClassificationChunks,
  planUpdSegments,
  type SegmentPlan,
} from '../src/domain/edo/upd-assembly.js';
import {
  CLASSIFY_PROMPT_TORG12,
  normalizeKind,
  type ImageDocKind,
} from '../src/domain/edo/vision-classifier.js';
import {
  callOpenRouter,
  pdfToPngsViaPoppler,
  stripJsonFences,
} from '../src/domain/edo/upd-vision.parser.js';
import {
  fileNeedsRecheck,
  mergeFileVerdict,
  mergePageVerdicts,
  pagesNeedRecheck,
  type FileVerdict,
} from '../src/domain/edo/torg12-recheck.js';
import { decryptField, buildAad } from '../src/domain/auth/crypto.js';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('нужен DATABASE_URL');
  process.exit(2);
}

const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = Number(argOf('days') ?? 30);
const m15Count = Number(argOf('m15') ?? 10);
const tnCount = Number(argOf('tn') ?? 10);
/** Сборки только из «ТН» / «сертификата» / «М-15» — самая массовая зона. */
const bundleCount = Number(argOf('bundles') ?? 10);
/**
 * Смешанные сборки: страницы УПД рядом с ТН / сертификатом. Главный риск —
 * настоящая ТН при настоящем УПД, — и их мало (8 за 30 дней), поэтому по
 * умолчанию берутся все.
 */
const mixedCount = Number(argOf('mixed') ?? 20);
/** Соль детерминированной выборки: тот же --seed даёт те же файлы. */
const seed = argOf('seed') ?? 'torg12-backtest';
const outDir = argOf('out');
const planOnly = args.includes('--plan-only');
const delayMs = Number(argOf('delay') ?? 500);

/** Те же константы, что в воркере и классификаторе. */
const ROCKWOOL_INN = '5012093506';
const ASSEMBLY_CLASSIFY_CHUNK = 15;
const MAX_PAGES_PER_SEGMENT = 5;
const CLASSIFY_IMAGE_MAX_TOKENS = 200;

/**
 * Пары РОКВУЛ: корневой пакет и строки реестра обоих листов. Эталон — по
 * снимкам 10.11 (manifest корпуса corpus-rockwool-a). В P5 и P7 в пакете есть
 * и другие файлы: они проходят тот же путь и попадают в отчёт отдельно.
 */
const PAIRS: Array<{
  label: string;
  docNumber: string;
  bundleId: string;
  sheet1: string;
  sheet2: string;
}> = [
  {
    label: 'P1',
    docNumber: '10626044499',
    bundleId: 'fdf3eb0c-0290-4d4f-970c-a4e1e2818d2f',
    sheet1: 'e81de686-9123-48c8-a826-4bab5c536853',
    sheet2: '603f823a-a58f-486f-beb0-c9931ef3dd14',
  },
  {
    label: 'P2',
    docNumber: '10626052853',
    bundleId: 'edecffef-6162-4497-816b-88b59e3a74ba',
    sheet1: 'f5fbe035-5a58-4081-848f-3147d82339b7',
    sheet2: 'b4454a8b-721f-4bb9-9dba-486a1a59b1c3',
  },
  {
    label: 'P3',
    docNumber: '10626052607',
    bundleId: 'ce853c8c-5153-455d-8216-9ca3b3489289',
    sheet1: 'ff39e804-0b8a-431e-968b-44e2e9368b09',
    sheet2: '0ad7293c-5653-4797-aad8-5643f1fbe431',
  },
  {
    label: 'P4',
    docNumber: '10626052249',
    bundleId: '12b24859-bda0-486e-98e5-d3e719a056c8',
    sheet1: '20076de7-8060-442c-aee5-812602433eb3',
    sheet2: '225b8bff-f3b5-4e11-b6d3-cae873f4c720',
  },
  {
    label: 'P5',
    docNumber: '10626046470',
    bundleId: '4a69de45-bdbd-4ec8-9ba4-f174b6f50c8c',
    sheet1: '1d382eeb-73af-4ba3-ba08-39078941c021',
    sheet2: '3935dd69-ba04-400f-b407-da6ae83526a0',
  },
  {
    label: 'P6',
    docNumber: '10626046283',
    bundleId: '212397d8-c744-42d1-9a87-252f5c8317b5',
    sheet1: '16c09d25-54bb-48d1-9d70-dd05c62891b6',
    sheet2: '8cbc30a2-3852-4d53-9380-6a980fae2bc9',
  },
  {
    label: 'P7',
    docNumber: '10626051945',
    bundleId: '73dc0ce5-b27b-437f-a6e9-5ff3d4f2b714',
    sheet1: '590aaf95-6c2d-46bd-bc4c-dd57852ab96e',
    sheet2: 'b8405ee5-0f74-40a9-a67d-0cbafbaa56d3',
  },
  {
    label: 'P8',
    docNumber: '10626048091',
    bundleId: 'c8c27bb9-fcf9-4336-a319-fd20b7e35f45',
    sheet1: '8ea262b9-537a-4f9d-aa0e-52c50b9cb5eb',
    sheet2: 'a8b92a0f-a19a-4577-a6d6-856d8068d113',
  },
];

// prepare: false — как у боевого клиента (src/db/client.ts): база за пулером.
const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

/**
 * Любой запрос — в транзакции READ ONLY: даже ошибка в тексте запроса не
 * может ничего записать на бою.
 */
async function ro<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin('read only', fn)) as T;
}

type Creds = { apiBaseUrl: string; apiKey: string; model: string };

/** Провайдер — как resolveOpenRouterCreds в воркере: по умолчанию и только openrouter. */
async function creds(): Promise<Creds> {
  return ro(async (tx) => {
    const [provider] = await tx<{ model: string; kind: string }[]>`
      SELECT model, kind FROM llm_providers WHERE is_default = true LIMIT 1`;
    if (!provider || provider.kind !== 'openrouter') {
      throw new Error(
        'провайдер по умолчанию не openrouter — воркер в этом случае сборку не делает',
      );
    }
    const [cred] = await tx<{ api_base_url: string; api_key_encrypted: unknown }[]>`
      SELECT api_base_url, api_key_encrypted FROM llm_provider_credentials
      WHERE kind = 'openrouter' LIMIT 1`;
    if (!cred) throw new Error('нет ключа openrouter');
    return {
      apiBaseUrl: cred.api_base_url,
      apiKey: decryptField(
        cred.api_key_encrypted as never,
        buildAad('llm_provider_credentials', 'openrouter'),
      ),
      model: provider.model,
    };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let modelCalls = 0;

// ── входы ──────────────────────────────────────────────────────────────────

type ItemRow = {
  id: string;
  /** Тип из реестра — запасной, если следа классификации нет. */
  detected_kind?: string | null;
  bundle_id: string;
  input_s3_key: string;
  mime_type: string | null;
  source_filename: string;
  input_order: number | null;
};

/** Вердикт роутера по файлу из сигнала «vision-kind:<kind>:<confidence>». */
function verdictFromSignals(signals: unknown): FileVerdict | null {
  if (!Array.isArray(signals)) return null;
  const s = signals.find((x): x is string => typeof x === 'string' && x.startsWith('vision-kind:'));
  if (!s) return null;
  const [, kind, conf] = s.split(':');
  const confidence = Number(conf);
  if (!kind || !Number.isFinite(confidence)) return null;
  return { kind: kind as ImageDocKind, confidence };
}

/** Последний след классификации файла: базовый вердикт и признак Excel. */
async function baseVerdictOf(
  itemId: string,
): Promise<{ verdict: FileVerdict | null; detectedKind: string | null; excel: boolean }> {
  const [row] = await ro(
    (tx) => tx<{ payload: { detectedKind?: string; signals?: unknown } }[]>`
      SELECT payload FROM recognition_evidence_events
      WHERE evidence_type = 'file_classification' AND payload->>'registryItemId' = ${itemId}
      ORDER BY created_at DESC LIMIT 1`,
  );
  const signals = row?.payload?.signals;
  return {
    verdict: verdictFromSignals(signals),
    detectedKind: row?.payload?.detectedKind ?? null,
    excel:
      Array.isArray(signals) &&
      signals.some((s) => typeof s === 'string' && s.startsWith('excel-routed')),
  };
}

type SampleFile = ItemRow & { base: FileVerdict; evidenceAt: string };

/**
 * Выборка файлов не РОКВУЛ с вердиктом роутера `kind`. Только вердикты модели
 * по картинке (сигнал vision-kind) и не Excel — ровно то, что переспрашивает
 * воркер. Не больше одного файла на пакет; порядок — md5 от id с солью.
 */
async function sampleFiles(kind: 'm15' | 'transport_waybill', n: number): Promise<SampleFile[]> {
  if (n <= 0) return [];
  const rows = await ro(
    (tx) => tx<(ItemRow & { signals: unknown; evidence_at: Date })[]>`
      WITH ev AS (
        SELECT DISTINCT ON (e.bundle_id)
               e.bundle_id, e.created_at, e.payload->>'registryItemId' AS item_id, e.payload->'signals' AS signals
        FROM recognition_evidence_events e
        WHERE e.evidence_type = 'file_classification'
          AND e.created_at >= now() - ${`${days} days`}::interval
          AND e.payload->>'detectedKind' = ${kind}
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.payload->'signals') s
                      WHERE s LIKE ${`vision-kind:${kind}:%`})
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.payload->'signals') s
                          WHERE s LIKE 'excel-routed%')
        ORDER BY e.bundle_id, e.created_at DESC
      )
      SELECT i.id, i.bundle_id, i.input_s3_key, i.mime_type, i.source_filename, i.input_order,
             ev.signals, ev.created_at AS evidence_at
      FROM ev
      JOIN bundle_import_items i ON i.id::text = ev.item_id AND i.input_s3_key IS NOT NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM source_documents sd JOIN source_bundles sb ON sb.id = sd.bundle_id
        WHERE (sb.id = ev.bundle_id OR sb.parent_bundle_id = ev.bundle_id)
          AND regexp_replace(coalesce(sd.supplier_inn_raw, ''), '[^0-9]', '', 'g') = ${ROCKWOOL_INN})
      ORDER BY md5(ev.item_id || ${seed})
      LIMIT ${n}`,
  );
  const out: SampleFile[] = [];
  for (const r of rows) {
    const base = verdictFromSignals(r.signals);
    if (!base || !fileNeedsRecheck(base)) continue;
    out.push({ ...r, base, evidenceAt: r.evidence_at.toISOString() });
  }
  return out;
}

type SampleBundle = {
  stratum: 'mixed' | 'suspicious_only';
  evidenceId: string;
  bundleId: string;
  evidenceAt: string;
  classification: PageClassification[];
  pageMap: Array<{
    globalPage: number;
    registryItemId: string;
    inputOrder: number;
    pageInFile: number;
  }>;
  segments: unknown;
  confident: boolean | null;
};

/**
 * Выборка сборок не РОКВУЛ со страницами «ТН» / «сертификат» / «М-15».
 * `mixed` — есть ли в сборке ещё и страницы УПД.
 */
async function sampleBundles(mixed: boolean, n: number): Promise<SampleBundle[]> {
  if (n <= 0) return [];
  const rows = await ro(
    (tx) => tx<
      { id: string; bundle_id: string; created_at: Date; payload: Record<string, unknown> }[]
    >`
      WITH pc AS (
        SELECT DISTINCT ON (e.bundle_id) e.id, e.bundle_id, e.created_at, e.payload
        FROM recognition_evidence_events e
        WHERE e.evidence_type = 'page_classification'
          AND e.created_at >= now() - ${`${days} days`}::interval
          AND coalesce(e.payload->>'splitMode', 'off') = 'off'
          AND coalesce(e.payload->>'torg12Prompt', 'false') = 'false'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.payload->'classification') c
                      WHERE c->>'type' IN ('transport_waybill', 'certificate', 'm15'))
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.payload->'classification') c
                      WHERE c->>'type' IN ('upd_main', 'upd_continuation')) = ${mixed}::boolean
        ORDER BY e.bundle_id, e.created_at DESC
      )
      SELECT pc.id, pc.bundle_id, pc.created_at, pc.payload
      FROM pc
      WHERE NOT EXISTS (
        SELECT 1 FROM source_documents sd JOIN source_bundles sb ON sb.id = sd.bundle_id
        WHERE (sb.id = pc.bundle_id OR sb.parent_bundle_id = pc.bundle_id)
          AND regexp_replace(coalesce(sd.supplier_inn_raw, ''), '[^0-9]', '', 'g') = ${ROCKWOOL_INN})
      ORDER BY md5(pc.id::text || ${seed})
      LIMIT ${n}`,
  );
  return rows.map((r) => ({
    stratum: mixed ? ('mixed' as const) : ('suspicious_only' as const),
    evidenceId: r.id,
    bundleId: r.bundle_id,
    evidenceAt: r.created_at.toISOString(),
    classification: [...((r.payload.classification as PageClassification[]) ?? [])].sort(
      (a, b) => a.page - b.page,
    ),
    pageMap: (r.payload.pageMap as SampleBundle['pageMap']) ?? [],
    segments: r.payload.segments ?? null,
    confident: typeof r.payload.confident === 'boolean' ? r.payload.confident : null,
  }));
}

async function itemsByIds(ids: string[]): Promise<Map<string, ItemRow>> {
  if (ids.length === 0) return new Map();
  const rows = await ro(
    (tx) => tx<ItemRow[]>`
      SELECT id, bundle_id, input_s3_key, mime_type, source_filename, input_order
      FROM bundle_import_items WHERE id = ANY(${tx.array(ids)}::uuid[]) AND input_s3_key IS NOT NULL`,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Файлы пакета, которые роутер разбирает (auto, с ключом S3), по порядку загрузки. */
async function bundleItems(bundleId: string): Promise<ItemRow[]> {
  return ro(
    (tx) => tx<ItemRow[]>`
      SELECT id, bundle_id, input_s3_key, mime_type, source_filename, input_order, detected_kind
      FROM bundle_import_items
      WHERE bundle_id = ${bundleId} AND input_s3_key IS NOT NULL AND processing_mode = 'auto'
      ORDER BY input_order NULLS LAST, created_at`,
  );
}

// ── модель ─────────────────────────────────────────────────────────────────

/**
 * Перепроверка файла: classifyImageKind(…, { prompt: 'torg12' }) без записи в
 * журнал (см. заголовок). Сбой — null, как и у классификатора: замены нет.
 */
async function recheckFile(
  buffer: Buffer,
  mimeType: string | null,
  c: Creds,
): Promise<{ verdict: FileVerdict | null; raw: string | null; error: string | null }> {
  try {
    const mime = (mimeType ?? '').toLowerCase();
    let file: { buffer: Buffer; mimeType: string };
    if (mime === 'application/pdf' || (!mime.startsWith('image/') && !mime)) {
      const pngs = await pdfToPngsViaPoppler(buffer, 1);
      if (!pngs.length || !pngs[0]) return { verdict: null, raw: null, error: 'pdf не отрисован' };
      file = { buffer: pngs[0], mimeType: 'image/png' };
    } else {
      file = { buffer, mimeType: mime || 'image/jpeg' };
    }
    modelCalls += 1;
    const r = await callOpenRouter({
      ...c,
      temperature: 0,
      maxTokens: CLASSIFY_IMAGE_MAX_TOKENS,
      promptText: CLASSIFY_PROMPT_TORG12,
      files: [file],
    });
    if (!r.raw) return { verdict: null, raw: null, error: 'пустой ответ' };
    let parsed: unknown = JSON.parse(stripJsonFences(r.raw));
    if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
    const p = (parsed ?? {}) as { kind?: string; confidence?: number };
    return {
      verdict: {
        kind: normalizeKind(p.kind),
        confidence: typeof p.confidence === 'number' ? p.confidence : 0,
      },
      raw: r.raw,
      error: null,
    };
  } catch (err) {
    return { verdict: null, raw: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Классификация страниц порциями — как handleUpdAssemblyJob. */
async function classifyAll(
  thumbs: Buffer[],
  prompt: string | undefined,
  c: Creds,
): Promise<PageClassification[]> {
  const chunks: PageClassification[][] = [];
  const sizes: number[] = [];
  for (let i = 0; i < thumbs.length; i += ASSEMBLY_CLASSIFY_CHUNK) {
    const slice = thumbs.slice(i, i + ASSEMBLY_CLASSIFY_CHUNK);
    modelCalls += 1;
    const res = await classifyPages({ ...c, thumbs: slice, ...(prompt ? { prompt } : {}) });
    chunks.push(res.classification);
    sizes.push(slice.length);
    if (delayMs > 0) await sleep(delayMs);
  }
  return mergeClassificationChunks(chunks, sizes);
}

type Page = {
  globalPage: number;
  itemId: string;
  inputOrder: number;
  pageInFile: number;
  thumb: Buffer;
};

/** Страницы файлов ровно как buildAssemblyPages: PDF — все листы, картинка — одна. */
async function pagesOf(items: ItemRow[]): Promise<{ pages: Page[]; buffers: Map<string, Buffer> }> {
  const pages: Page[] = [];
  const buffers = new Map<string, Buffer>();
  for (const it of items) {
    const buffer = await getObject(it.input_s3_key);
    buffers.set(it.id, buffer);
    const isPdf =
      (it.mime_type ?? '').toLowerCase() === 'application/pdf' ||
      /\.pdf$/i.test(it.source_filename);
    const rendered = isPdf ? await renderPdf(buffer, {}) : [await imageToVisionPage(buffer)];
    for (const [idx, full] of rendered.entries()) {
      pages.push({
        globalPage: pages.length + 1,
        itemId: it.id,
        inputOrder: it.input_order ?? 0,
        pageInFile: idx + 1,
        thumb: await toClassifyThumb(full),
      });
    }
  }
  return { pages, buffers };
}

// ── отчёт ──────────────────────────────────────────────────────────────────

const safeName = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80);

async function saveForReview(sub: string, name: string, buffer: Buffer): Promise<string | null> {
  if (!outDir) return null;
  const dir = path.join(outDir, 'review', sub);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, safeName(name));
  await writeFile(file, buffer);
  return file;
}

const short = (id: string) => id.slice(0, 8);
const fmtVerdict = (v: FileVerdict | null) =>
  v ? `${v.kind}:${v.confidence.toFixed(2)}` : 'нет ответа';
const fmtPages = (cls: PageClassification[]) => cls.map((p) => `${p.page}=${p.type}`).join(' ');
const fmtPlan = (plan: SegmentPlan) =>
  `${plan.confident ? 'уверенно' : 'НЕуверенно'}; сегменты ${
    plan.segments.map((s) => `[${s.pages.join(',')}]`).join(' ') || '—'
  }${plan.droppedPages.length ? `; отброшены ${plan.droppedPages.map((d) => `${d.page}:${d.type}`).join(',')}` : ''}`;

// ── части ──────────────────────────────────────────────────────────────────

type FileResult = {
  group: 'sample_m15' | 'sample_tn';
  itemId: string;
  bundleId: string;
  filename: string;
  evidenceAt: string;
  base: FileVerdict;
  recheck: FileVerdict | null;
  raw: string | null;
  error: string | null;
  changed: boolean;
  reviewCopy: string | null;
};

async function runFiles(files: Array<SampleFile & { group: FileResult['group'] }>, c: Creds) {
  const out: FileResult[] = [];
  console.info(`\n── 1. файлы не РОКВУЛ: ${files.length} ──`);
  for (const f of files) {
    let buffer: Buffer;
    try {
      buffer = await getObject(f.input_s3_key);
    } catch (err) {
      console.info(
        `  ${short(f.id)} ${f.source_filename}: файл не прочитан из S3 — пропуск (${String(err)})`,
      );
      continue;
    }
    const r = await recheckFile(buffer, f.mime_type, c);
    const merged = mergeFileVerdict(f.base, r.verdict);
    const reviewCopy = merged.changed
      ? await saveForReview('files', `${f.group}-${short(f.id)}__${f.source_filename}`, buffer)
      : null;
    out.push({
      group: f.group,
      itemId: f.id,
      bundleId: f.bundle_id,
      filename: f.source_filename,
      evidenceAt: f.evidenceAt,
      base: f.base,
      recheck: r.verdict,
      raw: r.raw,
      error: r.error,
      changed: merged.changed,
      reviewCopy,
    });
    console.info(
      `  ${merged.changed ? 'ЗАМЕНА ' : '       '}${short(f.id)} ${fmtVerdict(f.base)} → ${fmtVerdict(r.verdict)}` +
        `  ${f.source_filename}${r.error ? `  (сбой: ${r.error})` : ''}`,
    );
    if (delayMs > 0) await sleep(delayMs);
  }
  return out;
}

type BundleResult = {
  stratum: SampleBundle['stratum'];
  bundleId: string;
  evidenceId: string;
  evidenceAt: string;
  pages: number;
  base: PageClassification[];
  recheck: PageClassification[] | null;
  changedPages: number[];
  basePlanConfident: boolean | null;
  wouldPlan: { confident: boolean; segments: number[][]; dropped: string[] } | null;
  error: string | null;
  reviewDir: string | null;
};

async function runBundles(bundles: SampleBundle[], c: Creds) {
  const out: BundleResult[] = [];
  console.info(`\n── 2. сборки не РОКВУЛ: ${bundles.length} ──`);
  for (const b of bundles) {
    const ids = [
      ...new Set(
        [...b.pageMap].sort((x, y) => x.globalPage - y.globalPage).map((p) => p.registryItemId),
      ),
    ];
    const items = await itemsByIds(ids);
    const ordered = ids.map((id) => items.get(id)).filter((x): x is ItemRow => !!x);
    const result: BundleResult = {
      stratum: b.stratum,
      bundleId: b.bundleId,
      evidenceId: b.evidenceId,
      evidenceAt: b.evidenceAt,
      pages: b.pageMap.length,
      base: b.classification,
      recheck: null,
      changedPages: [],
      basePlanConfident: b.confident,
      wouldPlan: null,
      error: null,
      reviewDir: null,
    };
    if (ordered.length !== ids.length) {
      result.error = 'не все файлы сборки найдены в реестре';
      out.push(result);
      console.info(`  ${short(b.bundleId)}: ${result.error} — пропуск`);
      continue;
    }
    let pages: Page[];
    let buffers: Map<string, Buffer>;
    try {
      ({ pages, buffers } = await pagesOf(ordered));
    } catch (err) {
      result.error = `страницы не подготовились: ${String(err)}`;
      out.push(result);
      console.info(`  ${short(b.bundleId)}: ${result.error} — пропуск`);
      continue;
    }
    // Нумерация следа должна совпасть с нашей: иначе базовая классификация
    // относилась бы к другим страницам, и сравнение было бы бессмысленным.
    const sameLayout =
      pages.length === b.pageMap.length &&
      pages.every((p) => {
        const m = b.pageMap.find((x) => x.globalPage === p.globalPage);
        return m && m.registryItemId === p.itemId && m.pageInFile === p.pageInFile;
      });
    if (!sameLayout) {
      result.error = `страниц ${pages.length}, в следе ${b.pageMap.length} — раскладка не совпала`;
      out.push(result);
      console.info(`  ${short(b.bundleId)}: ${result.error} — пропуск`);
      continue;
    }
    try {
      const recheck = await classifyAll(
        pages.map((p) => p.thumb),
        PAGE_CLASSIFY_TORG12_PROMPT,
        c,
      );
      const merged = mergePageVerdicts(b.classification, recheck);
      result.recheck = recheck;
      result.changedPages = merged.changedPages;
      if (merged.changedPages.length > 0) {
        const plan = planUpdSegments(merged.classification, pages.length, MAX_PAGES_PER_SEGMENT, {
          pageOwners: new Map(pages.map((p) => [p.globalPage, p.inputOrder])),
          reorder: true,
          splitByDocNumber: false,
        });
        result.wouldPlan = {
          confident: plan.confident,
          segments: plan.segments.map((s) => s.pages),
          dropped: plan.droppedPages.map((d) => `${d.page}:${d.type}`),
        };
        for (const it of ordered) {
          const saved = await saveForReview(
            `bundles/${short(b.bundleId)}`,
            `${it.input_order ?? 0}__${it.source_filename}`,
            buffers.get(it.id)!,
          );
          if (saved) result.reviewDir = path.dirname(saved);
        }
      }
      console.info(
        `  ${merged.changedPages.length ? 'ЗАМЕНА ' : '       '}${short(b.bundleId)} ` +
          `${b.stratum === 'mixed' ? 'смеш.' : 'ТН   '} стр.${pages.length}: ` +
          `${fmtPages(b.classification)}  →  ${fmtPages(recheck)}` +
          (merged.changedPages.length ? `  [заменены ${merged.changedPages.join(',')}]` : ''),
      );
    } catch (err) {
      result.error = `классификация не удалась: ${err instanceof Error ? err.message : String(err)}`;
      console.info(`  ${short(b.bundleId)}: ${result.error}`);
    }
    out.push(result);
  }
  return out;
}

type ReplayFile = {
  itemId: string;
  inputOrder: number | null;
  filename: string;
  role: 'sheet1' | 'sheet2' | 'other';
  base: FileVerdict | null;
  baseKind: string | null;
  recheck: FileVerdict | null;
  changed: boolean;
  /** Куда файл ушёл бы при `on`: в сборку или своим маршрутом. */
  route: 'assembly' | 'own_route' | 'not_rechecked_own_route';
  reviewCopy: string | null;
};

type ReplayResult = {
  label: string;
  docNumber: string;
  bundleId: string;
  files: ReplayFile[];
  assemblyItems: string[];
  base: PageClassification[] | null;
  recheck: PageClassification[] | null;
  changedPages: number[];
  plan: { confident: boolean; segments: number[][]; dropped: string[] } | null;
  ok: boolean;
  why: string;
};

/** Типы, с которыми роутер отправляет файл в сборку (см. isAssemblyCandidate). */
const ASSEMBLY_KINDS = new Set(['upd', 'unknown']);

async function runPairs(c: Creds) {
  const out: ReplayResult[] = [];
  console.info(`\n── 3. пары РОКВУЛ: ${PAIRS.length} пакетов целиком ──`);
  for (const pair of PAIRS) {
    const res: ReplayResult = {
      label: pair.label,
      docNumber: pair.docNumber,
      bundleId: pair.bundleId,
      files: [],
      assemblyItems: [],
      base: null,
      recheck: null,
      changedPages: [],
      plan: null,
      ok: false,
      why: '',
    };
    try {
      const items = await bundleItems(pair.bundleId);
      if (!items.some((i) => i.id === pair.sheet1) || !items.some((i) => i.id === pair.sheet2)) {
        throw new Error('листы пары не найдены среди файлов пакета');
      }
      const members: ItemRow[] = [];
      for (const it of items) {
        const role = it.id === pair.sheet1 ? 'sheet1' : it.id === pair.sheet2 ? 'sheet2' : 'other';
        const ev = await baseVerdictOf(it.id);
        const baseKind = ev.detectedKind ?? it.detected_kind ?? null;
        let recheck: FileVerdict | null = null;
        let changed = false;
        let reviewCopy: string | null = null;
        let finalKind = baseKind;
        let route: ReplayFile['route'] = 'not_rechecked_own_route';
        if (!ev.excel && fileNeedsRecheck(ev.verdict)) {
          const buffer = await getObject(it.input_s3_key);
          recheck = (await recheckFile(buffer, it.mime_type, c)).verdict;
          const merged = mergeFileVerdict(ev.verdict, recheck);
          changed = merged.changed;
          finalKind = merged.verdict.kind;
          // Прочие файлы пакета РОКВУЛ: замена у них — не цель, а то, что надо
          // увидеть глазами (настоящая ТН при поставке остаться ТН обязана).
          if (changed && role === 'other') {
            reviewCopy = await saveForReview(
              `rockwool-other/${pair.label}`,
              `${it.input_order ?? 0}__${it.source_filename}`,
              buffer,
            );
          }
          if (delayMs > 0) await sleep(delayMs);
        }
        const toAssembly = finalKind != null && ASSEMBLY_KINDS.has(finalKind);
        if (toAssembly) {
          members.push(it);
          route = 'assembly';
        } else if (recheck || fileNeedsRecheck(ev.verdict)) {
          route = 'own_route';
        }
        res.files.push({
          itemId: it.id,
          inputOrder: it.input_order,
          filename: it.source_filename,
          role,
          base: ev.verdict,
          baseKind,
          recheck,
          changed,
          route,
          reviewCopy,
        });
        console.info(
          `  ${pair.label} #${it.input_order ?? '?'} ${role.padEnd(6)} ${baseKind ?? '—'}` +
            `${ev.verdict ? ` (${fmtVerdict(ev.verdict)})` : ''}` +
            `${recheck ? ` → ${fmtVerdict(recheck)}` : ''}${changed ? ' ЗАМЕНА' : ''} → ` +
            `${route === 'assembly' ? 'в сборку' : 'свой маршрут'}`,
        );
      }
      res.assemblyItems = members.map((m) => m.id);
      if (
        !members.some((m) => m.id === pair.sheet1) ||
        !members.some((m) => m.id === pair.sheet2)
      ) {
        res.why = 'в сборку попадают не оба листа';
        out.push(res);
        console.info(`  ${pair.label}: НЕТ — ${res.why}`);
        continue;
      }

      const { pages } = await pagesOf(members);
      // Обычный вызов воркера: splitMode off, PAGE_CLASSIFY_TORG12 выключен —
      // классификатор без явного текста.
      const base = await classifyAll(
        pages.map((p) => p.thumb),
        undefined,
        c,
      );
      res.base = base;
      let classification = base;
      let reorder = false;
      if (pagesNeedRecheck(base)) {
        const recheck = await classifyAll(
          pages.map((p) => p.thumb),
          PAGE_CLASSIFY_TORG12_PROMPT,
          c,
        );
        const merged = mergePageVerdicts(base, recheck);
        res.recheck = recheck;
        res.changedPages = merged.changedPages;
        if (merged.changedPages.length > 0) {
          classification = merged.classification;
          reorder = true;
        }
      }
      const plan = planUpdSegments(classification, pages.length, MAX_PAGES_PER_SEGMENT, {
        pageOwners: new Map(pages.map((p) => [p.globalPage, p.inputOrder])),
        reorder,
        splitByDocNumber: false,
      });
      res.plan = {
        confident: plan.confident,
        segments: plan.segments.map((s) => s.pages),
        dropped: plan.droppedPages.map((d) => `${d.page}:${d.type}`),
      };
      const p1 = pages.find((p) => p.itemId === pair.sheet1)!.globalPage;
      const p2 = pages.find((p) => p.itemId === pair.sheet2)!.globalPage;
      const seg = plan.segments.find((s) => s.pages.includes(p1) && s.pages.includes(p2));
      res.ok = plan.confident && !!seg && seg.pages[0] === p1;
      res.why = res.ok
        ? 'один уверенный сегмент, шапка первой'
        : !plan.confident
          ? 'план неуверенный — пакет откатится'
          : !seg
            ? 'листы в разных сегментах'
            : 'шапка не первой';
      console.info(
        `  ${pair.label}: страницы ${fmtPages(base)}` +
          (res.recheck
            ? `  → перепроверка ${fmtPages(res.recheck)}`
            : '  (перепроверка не нужна)') +
          `\n      план: ${fmtPlan(plan)} — ${res.ok ? 'ДА' : 'НЕТ'}: ${res.why}`,
      );
    } catch (err) {
      res.why = `сбой: ${err instanceof Error ? err.message : String(err)}`;
      console.info(`  ${pair.label}: ${res.why}`);
    }
    out.push(res);
  }
  return out;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const m15 = (await sampleFiles('m15', m15Count)).map((f) => ({
    ...f,
    group: 'sample_m15' as const,
  }));
  const tn = (await sampleFiles('transport_waybill', tnCount)).map((f) => ({
    ...f,
    group: 'sample_tn' as const,
  }));
  const bundles = [
    ...(await sampleBundles(true, mixedCount)),
    ...(await sampleBundles(false, bundleCount)),
  ];
  const bundleChunks = bundles.reduce(
    (a, b) => a + Math.max(1, Math.ceil(b.pageMap.length / ASSEMBLY_CLASSIFY_CHUNK)),
    0,
  );
  // Пары: файлы М-15/ТН пакета (≈ 2 на пакет) + две классификации страниц.
  const expected = m15.length + tn.length + bundleChunks + PAIRS.length * 4;
  console.info(
    `период ${days} дн., соль «${seed}»\n` +
      `выборка: М-15 ${m15.length}, ТН ${tn.length}, сборок ${bundles.length} ` +
      `(смешанных ${bundles.filter((b) => b.stratum === 'mixed').length}) ` +
      `(страниц ${bundles.reduce((a, b) => a + b.pageMap.length, 0)}), пар РОКВУЛ ${PAIRS.length}\n` +
      `ожидаемо вызовов модели: около ${expected}`,
  );
  if (planOnly) {
    for (const f of [...m15, ...tn]) {
      console.info(
        `  файл ${f.group} ${short(f.id)} ${fmtVerdict(f.base)} ${f.source_filename} (${f.evidenceAt.slice(0, 10)})`,
      );
    }
    for (const b of bundles) {
      console.info(
        `  сборка ${b.stratum} ${short(b.bundleId)} стр.${b.pageMap.length}: ${fmtPages(b.classification)}`,
      );
    }
    await sql.end({ timeout: 5 });
    return;
  }

  const c = await creds();
  const files = await runFiles([...m15, ...tn], c);
  const bundleResults = await runBundles(bundles, c);
  const pairs = await runPairs(c);

  const fileFlips = files.filter((f) => f.changed);
  const bundleFlips = bundleResults.filter((b) => b.changedPages.length > 0);
  const otherFlips = pairs.flatMap((p) =>
    p.files.filter((f) => f.role === 'other' && f.changed).map((f) => ({ pair: p.label, ...f })),
  );
  const errors = files.filter((f) => f.error).length + bundleResults.filter((b) => b.error).length;
  const pairsOk = pairs.filter((p) => p.ok).length;
  const passed = fileFlips.length === 0 && bundleFlips.length === 0;

  console.info('\n── итог ──');
  console.info(`вызовов модели: ${modelCalls}`);
  console.info(`файлы не РОКВУЛ: ${files.length}, замен ${fileFlips.length}  ← должно быть 0`);
  for (const f of fileFlips) {
    console.info(
      `  ${f.group} ${short(f.itemId)} ${fmtVerdict(f.base)} → ${fmtVerdict(f.recheck)} ${f.filename} → ${f.reviewCopy ?? '(без --out)'}`,
    );
  }
  console.info(
    `сборки не РОКВУЛ: ${bundleResults.length}, с заменами ${bundleFlips.length}  ← должно быть 0`,
  );
  for (const b of bundleFlips) {
    console.info(
      `  ${short(b.bundleId)} стр. ${b.changedPages.join(',')}; план после: ` +
        `${b.wouldPlan ? `${b.wouldPlan.confident ? 'уверенно' : 'неуверенно'} ${JSON.stringify(b.wouldPlan.segments)}` : '—'}` +
        ` → ${b.reviewDir ?? '(без --out)'}`,
    );
  }
  console.info(`сбоев (не в счёт ворот, но смотреть): ${errors}`);
  console.info(`прочие файлы пакетов РОКВУЛ с заменой (посмотреть глазами): ${otherFlips.length}`);
  for (const f of otherFlips) {
    console.info(
      `  ${f.pair} #${f.inputOrder} ${fmtVerdict(f.base)} → ${fmtVerdict(f.recheck)} ${f.filename}`,
    );
  }
  console.info(`пары РОКВУЛ собрались бы в один документ: ${pairsOk} из ${pairs.length}`);
  for (const p of pairs.filter((x) => !x.ok)) console.info(`  ${p.label}: ${p.why}`);
  console.info(
    passed
      ? '\nВОРОТА ПРОЙДЕНЫ (чужие документы не меняются)'
      : '\nВОРОТА НЕ ПРОЙДЕНЫ — замены к просмотру в review/',
  );

  if (outDir) {
    await mkdir(outDir, { recursive: true });
    const file = path.join(
      outDir,
      `torg12-recheck-backtest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    await writeFile(
      file,
      JSON.stringify(
        {
          meta: {
            days,
            seed,
            m15Count,
            tnCount,
            bundleCount,
            mixedCount,
            modelCalls,
            at: new Date().toISOString(),
          },
          gate: {
            passed,
            fileFlips: fileFlips.length,
            bundleFlips: bundleFlips.length,
            errors,
            otherFlips: otherFlips.length,
            pairsOk,
            pairs: pairs.length,
          },
          files,
          bundles: bundleResults,
          pairs,
        },
        null,
        2,
      ),
    );
    console.info(`отчёт: ${file}`);
  }

  await sql.end({ timeout: 5 });
  // Явный выход: keep-alive соединения S3 иначе держат процесс после отчёта.
  process.exit(passed ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 5 }).catch(() => undefined);
  process.exit(2);
});
