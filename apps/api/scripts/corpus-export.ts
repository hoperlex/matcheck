/**
 * Выгрузка боевых документов в локальный корпус для сверки версий промпта.
 *
 * Зачем. Корпус docs/debug-upd собирался под УПД: накладных М-15 в нём ровно
 * два файла, и оба — сканы без пригодного текстового слоя. Сверять на них
 * промпт накладных бессмысленно: два документа ничего не доказывают ни про
 * анти-регресс, ни про новое поле. Настоящий корпус накладных — это те самые
 * документы, которые уже разобраны в проде (на момент написания их 24), и они
 * же ровно та популяция, поведение на которой мы меняем.
 *
 * Отбор не «по типу документа», а по факту: берутся записи, у которых В ЖУРНАЛЕ
 * вызовов есть обращение с нужным doc_kind. Так в выборку попадает именно то,
 * что прод разбирал этим промптом, — без догадок о маршрутизации.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/corpus-export.ts --out /path/to/corpus
 *   … --doc-kind m15 --limit 5
 *
 * Точечно, когда в корпус добавляются КОНКРЕТНЫЕ документы (например те, на
 * которых зафиксирован дефект, ради исправления которого выпускается версия):
 *   … --ids 0092586f-…,4fcea668-… --out /path/to/corpus
 * По номеру документа такой отбор невозможен: номер повторяется у разных
 * записей, а нужен ровно тот разбор, который проверяли глазами.
 *
 * Только ЧИТАЕТ базу и S3; пишет исключительно в каталог --out (файлы
 * оригиналов и manifest.json рядом с ними). Ничего не меняет в проде.
 *
 * Дальше манифест правится руками: в expectedDocuments вносится то, что
 * напечатано в документе. Скрипт печатает таблицу «номер / дата / позиций /
 * что сейчас в грузополучателе», чтобы это делалось глазами по документу, а не
 * копированием ответа модели.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sql as drSql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { getObject } from '../src/domain/storage/s3.signer.js';

// transport_waybill — корпус накладных для scripts/waybill-prompt-ab.ts:
// отбор тот же (документы, которые прод разбирал этим промптом), а сверяет их
// свой скрипт, потому что накладные приходят пакетом «файл → N документов».
type DocKind = 'm15' | 'upd' | 'transport_waybill';

function argValue(flag: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** Имя файла, безопасное для файловой системы и для аргументов командной строки. */
function safeName(docId: string, filename: string): string {
  const cleaned = filename
    .replace(/[\\/:*?"<>|]/g, '_')
    // Неразрывный пробел (U+00A0) в именах из 1С ломает шаблоны в шелле:
    // набранный вручную обычный пробел с ним не совпадает.
    .replace(/\u00A0/g, ' ')
    .trim();
  return `${docId.slice(0, 8)}__${cleaned}`;
}

type Row = {
  id: string;
  doc_number: string | null;
  doc_date: string | null;
  s3_key: string;
  filename: string;
  mime_type: string | null;
  consignee_name_raw: string | null;
  items: number;
};

async function main(): Promise<void> {
  const docKind = (argValue('--doc-kind', 'm15') ?? 'm15') as DocKind;
  // resolve('') возвращает текущий каталог, поэтому проверять надо СЫРОЙ
  // аргумент: иначе забытый --out молча вываливал корпус в рабочую папку.
  const outArg = argValue('--out');
  if (!outArg) throw new Error('укажите каталог выгрузки: --out /path/to/corpus');
  const outDir = resolve(outArg);
  const limitRaw = argValue('--limit');
  const limit = limitRaw ? Number(limitRaw) : 500;

  // Точечный отбор по идентификаторам.
  //
  // Отбор «последние N этого типа» годится, чтобы собрать корпус с нуля, но не
  // годится, чтобы добавить в него КОНКРЕТНЫЕ документы — например те, на
  // которых зафиксирован дефект, ради исправления которого выпускается новая
  // версия промпта. По номеру документа их не выбрать: номер повторяется
  // (у одного УПД в базе пять записей — по фото на страницу), а нужен ровно
  // тот разбор, который проверяли глазами.
  const idsRaw = argValue('--ids');
  const ids = (idsRaw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of ids) {
    // Проверка формата, а не вкус к аккуратности: идентификаторы уходят в
    // запрос, и опечатка должна остановить выгрузку, а не молча дать пустой
    // результат, который выглядит как «таких документов нет».
    if (!UUID.test(id)) throw new Error(`--ids: «${id}» не похож на идентификатор документа`);
  }
  // При точечном отборе фильтр по журналу вызовов не применяется: документ мог
  // быть разобран другим путём, а нужен именно он.
  const byIds = ids.length > 0;
  const idFilter = byIds
    ? drSql`sd.id in (${drSql.join(
        ids.map((id) => drSql`${id}::uuid`),
        drSql`, `,
      )})`
    : drSql`EXISTS (
             SELECT 1 FROM llm_calls lc
              WHERE lc.source_document_id = sd.id
                AND lc.doc_kind = ${docKind}
           )`;

  const rows = await db.execute<Row>(drSql`
    SELECT sd.id,
           sd.doc_number,
           to_char(sd.doc_date, 'YYYY-MM-DD') AS doc_date,
           a.s3_key,
           a.filename,
           a.mime_type,
           sd.consignee_name_raw,
           (SELECT count(*) FROM source_document_items i WHERE i.source_document_id = sd.id)::int AS items
      FROM source_documents sd
      JOIN source_document_attachments a ON a.source_document_id = sd.id
     WHERE sd.is_technical = false
       AND ${idFilter}
     ORDER BY sd.created_at DESC
     LIMIT ${limit}
  `);

  if (byIds) {
    // Молчаливая недостача опаснее ошибки: недостающий документ означал бы
    // корпус без той самой строки, ради которой всё затевалось.
    const got = new Set([...rows].map((r) => (r as Row).id));
    const lost = ids.filter((id) => !got.has(id));
    if (lost.length > 0) {
      throw new Error(`не найдены документы или вложения к ним: ${lost.join(', ')}`);
    }
  }

  const list = [...rows] as Row[];
  console.log(`[corpus-export] doc_kind=${docKind}: документов найдено ${list.length}`);
  if (list.length === 0) {
    console.log('[corpus-export] нечего выгружать — проверьте --doc-kind');
    return;
  }

  await mkdir(outDir, { recursive: true });

  const entries: unknown[] = [];
  const failed: string[] = [];
  const table: string[] = [];

  for (const r of list) {
    const filename = safeName(r.id, r.filename);
    try {
      const buffer = await getObject(r.s3_key);
      await writeFile(join(outDir, filename), buffer);
    } catch (err) {
      failed.push(`${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    entries.push({
      filename,
      kind: docKind,
      // Картинка разбирается только vision-путём; у PDF путь зависит от того,
      // есть ли в нём текстовый слой, и определяется это не по расширению, а
      // попыткой его извлечь. Поэтому здесь — предположение (source: "guess"),
      // которое человек уточняет вместе с эталоном.
      parsePath: (r.mime_type ?? '').startsWith('image/') ? 'vision' : 'text_pdf',
      hasConsignee: null,
      source: 'guess',
      note: `sd:${r.id}; doc:${r.doc_number ?? '∅'} от ${r.doc_date ?? '∅'}; позиций: ${r.items}`,
    });

    table.push(
      `  ${(r.doc_number ?? '∅').padEnd(14)} ${(r.doc_date ?? '∅').padEnd(11)}` +
        ` позиций: ${String(r.items).padStart(3)}  грузополучатель сейчас: ${r.consignee_name_raw ?? '∅'}`,
    );
  }

  const manifestPath = join(outDir, 'manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        note:
          `Манифест выгрузки боевых документов (doc_kind=${docKind}) для scripts/upd-prompt-ab.ts. ` +
          'Заполните expectedDocuments по тому, что НАПЕЧАТАНО в документе, и поставьте ' +
          'source: "manual" — тогда сверка проверит значение, а не факт непустоты.',
        entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`[corpus-export] выгружено файлов: ${entries.length}, манифест: ${manifestPath}`);
  if (failed.length > 0) {
    // Молча «выгрузить 20 из 24» нельзя: неполный корпус выглядит как полный.
    console.log(`[corpus-export] НЕ СКАЧАЛИСЬ (${failed.length}):`);
    for (const f of failed) console.log(`  ${f}`);
  }
  console.log('\nЗаполните эталон по этим документам (номер / дата / позиций / текущее значение):');
  for (const line of table) console.log(line);
  console.log(
    docKind === 'transport_waybill'
      ? `\nДальше: pnpm --filter @matcheck/api exec tsx scripts/waybill-prompt-ab.ts` +
          ` --base "default v3" --new "default v4" --dir ${outDir}`
      : `\nДальше: pnpm --filter @matcheck/api exec tsx scripts/upd-prompt-ab.ts` +
          ` --doc-kind ${docKind} --dir ${outDir} --manifest ${manifestPath}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$client.end({ timeout: 5 });
  });
