/**
 * Read-only аудит разрешения фото документов по объектам.
 * НИЧЕГО не пишет: только SELECT + Range-GET первых килобайт из S3.
 *
 * Зачем: жалоба «на объекте фото документов мелкое и в чёрной рамке» упирается в
 * разрешение снимка, а в БД оно не хранится. Скрипт скачивает заголовок каждого
 * файла (не файл целиком) и считает габариты из SOF-маркера.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api tsx scripts/audit-photo-dims.ts
 *   pnpm --filter @matcheck/api tsx scripts/audit-photo-dims.ts --days 30
 *   pnpm --filter @matcheck/api tsx scripts/audit-photo-dims.ts --site "Метрополия"
 *   pnpm --filter @matcheck/api tsx scripts/audit-photo-dims.ts --photo-id <uuid>
 *
 * Чего скрипт НЕ делает:
 *   - не определяет конкретный планшет. У фото нет created_by_session_id, он есть
 *     только у приёмки/отгрузки, а фото мог добавить другой планшет позже. Колонка
 *     «UA операции» — косвенная подсказка, проверять надо все планшеты объекта.
 *   - не находит чёрные поля, вшитые в кадр: у такого снимка габариты нормальные,
 *     это видно только глазами.
 */
import postgres from 'postgres';
import { presign, s3FetchWithRetry } from '../src/domain/storage/s3.signer.js';
import { readJpegSize, type JpegSizeResult } from '../src/domain/photos/jpeg-size.js';

/** Пороги те же, что в apps/web/src/pages/kpp/PhotoDocumentPreview.tsx. */
const LOW_RES_PX = 1280;
const SUSPECT_RES_PX = 1600;

/** Сколько байт с начала файла дочитывать, пока не найдётся SOF. */
const RANGE_STEPS = [64 * 1024, 256 * 1024, 1024 * 1024];
const CONCURRENCY = 6;
const PER_SITE_LIMIT = 40;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const siteArg = argValue('--site');
const photoIdArg = argValue('--photo-id');
const days = Number(argValue('--days') ?? '14');

const sql = postgres(url, { max: 1 });

type PhotoRow = {
  id: string;
  s3Key: string;
  createdAt: Date;
  siteName: string;
  opKind: string;
  displayId: string | number | null;
  ua: string | null;
};

type Outcome =
  | { kind: 'ok'; w: number; h: number }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

/**
 * Читает тело ответа не более `limit` байт и обрывает загрузку. Нужен, когда S3
 * проигнорировал Range и ответил 200 на весь файл — иначе аудит выкачает гигабайты.
 */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, limit);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).subarray(0, limit);
}

let rangeIgnoredCount = 0;

async function measure(key: string): Promise<Outcome> {
  let parsed: JpegSizeResult = 'truncated';
  for (const limit of RANGE_STEPS) {
    const controller = new AbortController();
    // Presign выписываем прямо перед запросом: за длинный прогон ссылка, выданная
    // заранее, успела бы протухнуть.
    const signed = await presign({ method: 'GET', key, expiresIn: 300 });
    const res = await s3FetchWithRetry(() =>
      fetch(signed, {
        headers: { Range: `bytes=0-${limit - 1}` },
        signal: controller.signal,
      }),
    );
    if (!res.ok) {
      controller.abort();
      return { kind: 'error', message: `HTTP ${res.status}` };
    }
    const honoursRange = res.status === 206 && res.headers.get('content-range') !== null;
    if (!honoursRange) rangeIgnoredCount++;
    const buf = honoursRange
      ? Buffer.from(await res.arrayBuffer()).subarray(0, limit)
      : await readCapped(res, limit);

    parsed = readJpegSize(buf);
    if (parsed === 'not-jpeg') return { kind: 'unsupported' };
    if (parsed !== 'truncated') return { kind: 'ok', w: parsed.w, h: parsed.h };
    // Файл кончился раньше лимита — дочитывать нечего, заголовок битый.
    if (buf.length < limit) break;
  }
  return { kind: 'error', message: 'SOF не найден в первом мегабайте' };
}

async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!);
    }
  });
  await Promise.all(runners);
  return results;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

async function loadPhotos(): Promise<PhotoRow[]> {
  if (photoIdArg) {
    return (await sql<PhotoRow[]>`
      SELECT dp.id, dp.s3_key AS "s3Key", dp.created_at AS "createdAt",
             s.name AS "siteName", 'приёмка' AS "opKind",
             d.display_id AS "displayId", se.last_seen_ua AS ua
      FROM delivery_photos dp
      JOIN deliveries d ON d.id = dp.delivery_id
      JOIN sites s ON s.id = d.site_id
      LEFT JOIN sessions se ON se.id = d.created_by_session_id
      WHERE dp.id = ${photoIdArg}
      UNION ALL
      SELECT sp.id, sp.s3_key, sp.created_at,
             s.name, 'отгрузка', sh.display_id, se.last_seen_ua
      FROM shipment_photos sp
      JOIN shipments sh ON sh.id = sp.shipment_id
      JOIN sites s ON s.id = sh.site_id
      LEFT JOIN sessions se ON se.id = sh.created_by_session_id
      WHERE sp.id = ${photoIdArg}`) as unknown as PhotoRow[];
  }

  const siteFilter = siteArg ? `%${siteArg}%` : null;
  return (await sql<PhotoRow[]>`
    WITH photos AS (
      SELECT dp.id, dp.s3_key, dp.created_at, s.id AS site_id, s.name AS site_name,
             'приёмка' AS op_kind, d.display_id, se.last_seen_ua
      FROM delivery_photos dp
      JOIN deliveries d ON d.id = dp.delivery_id
      JOIN sites s ON s.id = d.site_id
      LEFT JOIN sessions se ON se.id = d.created_by_session_id
      WHERE dp.kind = 'document'
        AND dp.uploaded_at IS NOT NULL
        AND dp.created_at >= now() - (${days} || ' days')::interval
        AND (${siteFilter}::text IS NULL OR s.name ILIKE ${siteFilter})
      UNION ALL
      SELECT sp.id, sp.s3_key, sp.created_at, s.id, s.name,
             'отгрузка', sh.display_id, se.last_seen_ua
      FROM shipment_photos sp
      JOIN shipments sh ON sh.id = sp.shipment_id
      JOIN sites s ON s.id = sh.site_id
      LEFT JOIN sessions se ON se.id = sh.created_by_session_id
      WHERE sp.kind = 'document'
        AND sp.uploaded_at IS NOT NULL
        AND sp.created_at >= now() - (${days} || ' days')::interval
        AND (${siteFilter}::text IS NULL OR s.name ILIKE ${siteFilter})
    ), ranked AS (
      -- Лимит на объект берём ПОСЛЕ объединения, иначе он выберет одни приёмки.
      SELECT *, row_number() OVER (PARTITION BY site_id ORDER BY created_at DESC) AS rn
      FROM photos
    )
    SELECT id, s3_key AS "s3Key", created_at AS "createdAt", site_name AS "siteName",
           op_kind AS "opKind", display_id AS "displayId", last_seen_ua AS ua
    FROM ranked
    WHERE rn <= ${PER_SITE_LIMIT}
    ORDER BY site_name, created_at DESC`) as unknown as PhotoRow[];
}

async function main(): Promise<void> {
  const photos = await loadPhotos();
  if (photos.length === 0) {
    console.log('Фото документов по заданным условиям не найдено.');
    return;
  }
  console.log(
    `Проверяю ${photos.length} фото${photoIdArg ? '' : ` за ${days} дн.`}` +
      `${siteArg ? `, объект ~ «${siteArg}»` : ''}…\n`,
  );

  const outcomes = await runPool(
    photos,
    async (p) => {
      try {
        return await measure(p.s3Key);
      } catch (err) {
        return {
          kind: 'error' as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    CONCURRENCY,
  );

  type Bucket = {
    site: string;
    longest: number[];
    errors: number;
    unsupported: number;
    samples: { photo: PhotoRow; w: number; h: number }[];
  };
  const bySite = new Map<string, Bucket>();
  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i]!;
    const outcome = outcomes[i]!;
    const bucket = bySite.get(photo.siteName) ?? {
      site: photo.siteName,
      longest: [],
      errors: 0,
      unsupported: 0,
      samples: [],
    };
    if (outcome.kind === 'ok') {
      bucket.longest.push(Math.max(outcome.w, outcome.h));
      bucket.samples.push({ photo, w: outcome.w, h: outcome.h });
    } else if (outcome.kind === 'unsupported') bucket.unsupported++;
    else bucket.errors++;
    bySite.set(photo.siteName, bucket);
  }

  console.log('=== Разрешение фото документов по объектам ===');
  console.log(
    `(мелкое < ${LOW_RES_PX}px по длинной стороне, подозрительное < ${SUSPECT_RES_PX}px)`,
  );
  console.table(
    [...bySite.values()]
      .map((b) => {
        // Доли считаем только среди разобранных: объект с массовыми сетевыми
        // ошибками иначе выглядел бы благополучным.
        const parsed = b.longest.length;
        const low = b.longest.filter((v) => v < LOW_RES_PX).length;
        const suspect = b.longest.filter(
          (v) => v >= LOW_RES_PX && v < SUSPECT_RES_PX,
        ).length;
        return {
          Объект: b.site,
          Разобрано: parsed,
          Ошибок: b.errors,
          'Не JPEG': b.unsupported,
          Медиана: median(b.longest) ?? '—',
          Мин: parsed > 0 ? Math.min(...b.longest) : '—',
          [`< ${LOW_RES_PX}`]: parsed > 0 ? `${Math.round((low / parsed) * 100)}%` : '—',
          [`${LOW_RES_PX}–${SUSPECT_RES_PX - 1}`]:
            parsed > 0 ? `${Math.round((suspect / parsed) * 100)}%` : '—',
        };
      })
      .sort((a, b) => String(a.Объект).localeCompare(String(b.Объект))),
  );

  const problems = [...bySite.values()]
    .flatMap((b) => b.samples)
    .filter((s) => Math.max(s.w, s.h) < SUSPECT_RES_PX)
    .sort((a, b) => Math.max(a.w, a.h) - Math.max(b.w, b.h));

  console.log('\n=== Операции с мелкими снимками ===');
  if (problems.length === 0) {
    console.log('  (нет)');
  } else {
    console.table(
      problems.slice(0, 100).map((s) => ({
        Объект: s.photo.siteName,
        Операция: `${s.photo.opKind} ${s.photo.displayId ?? '—'}`,
        Дата: new Date(s.photo.createdAt).toISOString().slice(0, 16).replace('T', ' '),
        Размер: `${s.w}×${s.h}`,
        'UA операции (косвенно)': s.photo.ua ?? '—',
        'photo-id': s.photo.id,
      })),
    );
    if (problems.length > 100) {
      console.log(`  …и ещё ${problems.length - 100} — сузь период через --days или --site`);
    }
  }

  if (rangeIgnoredCount > 0) {
    console.log(
      `\nПримечание: S3 проигнорировал Range в ${rangeIgnoredCount} запросах — ` +
        'чтение обрывалось вручную по лимиту.',
    );
  }
  console.log(
    '\nUA относится к сессии, создавшей операцию, а не к устройству, снявшему фото:\n' +
      'на объекте с мелкими снимками проверяй все планшеты.',
  );
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error('Ошибка аудита:', err instanceof Error ? err.message : err);
    await sql.end();
    process.exit(1);
  });
