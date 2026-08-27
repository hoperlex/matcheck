/**
 * Генератор манифеста корпуса docs/debug-upd для сверки версий промпта.
 *
 * Зачем. Корпус — 62 разнородных файла: УПД, М-15, транспортные накладные,
 * PDF с текстовым слоем, сканы, фото и Excel. Скрипту сверки промптов нужно
 * знать по каждому файлу три вещи: это вообще УПД; каким путём его разбирает
 * прод; должен ли в нём найтись грузополучатель. Отбирать «на лету» по
 * classifyFile нельзя — сканы и фото он намеренно отдаёт как unknown +
 * needsVision, и тогда из сверки выпали бы ровно те файлы, ради которых
 * vision-промпт и существует.
 *
 * Манифест — обычный JSON, его можно и нужно править руками: значения,
 * которые скрипт вывести не может (тип скана, наличие грузополучателя на
 * фото), помечены "source": "guess". Проверенные глазами строки помечайте
 * "source": "manual" — генератор их не перезаписывает.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/corpus-manifest-build.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/corpus-manifest-build.ts --dir ../../docs/debug-upd
 *
 * НИЧЕГО не пишет в БД и не вызывает LLM: только читает файлы корпуса и
 * пишет scripts/corpus-manifest.json. Безопасно запускать где угодно.
 *
 * Чего скрипт НЕ делает: не решает, годен ли файл для сверки (это решает
 * человек, правя манифест), и не открывает Excel — для .xls/.xlsx путь
 * разбора известен по расширению.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { classifyFile } from '../src/domain/edo/document-router.js';
import { DOC_MIME_BY_EXT } from './prompt-ab-lib.js';

type ParsePath = 'vision' | 'text_pdf' | 'multi_upd' | 'excel';

type ManifestEntry = {
  filename: string;
  /** Что это за документ. Только 'upd' участвует в сверке промпта УПД. */
  kind: 'upd' | 'm15' | 'transport_waybill' | 'os2_transfer' | 'unknown';
  /** Каким путём его разбирает прод. */
  parsePath: ParsePath;
  /** Есть ли в документе грузополучатель (графа 4). null — неизвестно. */
  hasConsignee: boolean | null;
  /** 'guess' — вывел генератор, 'manual' — проверено человеком (не трогаем). */
  source: 'guess' | 'manual';
  /**
   * Эталон: что напечатано в документе. Заполняется РУКАМИ у записей
   * source: "manual" — генератор такие строки не перезаписывает.
   *
   * Массив, а не одно значение: в одном файле бывает несколько логических УПД
   * (в корпусе есть пакеты на 4, 5 и 15 документов), и одно значение на файл
   * ничего бы не доказывало — грузополучатель у одного из пятнадцати выглядел
   * бы успехом. Сверка идёт по docNumber, порядок сегментов значения не имеет.
   *
   * Без этого поля сверка промпта может проверить только «поле непустое», а
   * утверждения «совпал с эталоном» и «не взят водитель из графы „Через кого“»
   * машинной проверке недоступны.
   */
  expectedDocuments?: {
    docNumber: string;
    consignee: { name: string; inn: string | null; kpp: string | null };
  }[];
  /** Почему так решили — чтобы правки руками были осмысленными. */
  note?: string;
};

// Общая таблица плюс форматы, которые разбирает НЕ модель: Excel идёт через
// структурный парсер, .txt — через текстовый путь. Промпт в них не участвует,
// но в корпусе такие файлы лежат, и генератор обязан их видеть.
const MIME_BY_EXT: Record<string, string> = {
  ...DOC_MIME_BY_EXT,
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain',
};

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const dir = resolve(argValue('--dir') ?? join(process.cwd(), '../../docs/debug-upd'));
  const outPath = resolve(argValue('--out') ?? join(process.cwd(), 'scripts/corpus-manifest.json'));

  const existing = new Map<string, ManifestEntry>();
  if (existsSync(outPath)) {
    const prev = JSON.parse(await readFile(outPath, 'utf8')) as { entries: ManifestEntry[] };
    for (const e of prev.entries ?? []) existing.set(e.filename, e);
  }

  const files = (await readdir(dir)).filter((f) => MIME_BY_EXT[extname(f).toLowerCase()]);
  files.sort();

  const entries: ManifestEntry[] = [];
  for (const filename of files) {
    const kept = existing.get(filename);
    if (kept?.source === 'manual') {
      entries.push(kept);
      continue;
    }

    const buffer = await readFile(join(dir, filename));
    const ext = extname(filename).toLowerCase();
    const mime = MIME_BY_EXT[ext]!;

    const cls = await classifyFile(buffer, mime, basename(filename));

    // Путь разбора повторяет решения worker'а: Excel → структурный парсер,
    // текстовый PDF с ≥2 счёт-фактурами → multi-UPD, прочий текстовый PDF →
    // text-LLM, всё остальное (сканы, фото) → vision.
    let parsePath: ParsePath;
    if (ext === '.xlsx' || ext === '.xls') parsePath = 'excel';
    else if (cls.parserUsed === 'tryParseTextUpdBundle') parsePath = 'multi_upd';
    else if (cls.parserUsed === 'parseUpdPdf') parsePath = 'text_pdf';
    else parsePath = 'vision';

    // Грузополучателя ищем в ТЕКСТОВОМ СЛОЕ (pdf-parse), а не в сырых байтах:
    // содержимое PDF сжато, и поиск по буферу кириллицу не найдёт.
    // Для сканов, фото и Excel оставляем null — без разбора не определить.
    let hasConsignee: boolean | null = null;
    if (parsePath === 'text_pdf' || parsePath === 'multi_upd') {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const r = await parser.getText();
        hasConsignee = /Грузополучател/i.test(r.text ?? '') ? true : false;
      } catch {
        hasConsignee = null;
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }

    entries.push({
      filename,
      kind: cls.detectedKind,
      parsePath,
      hasConsignee: kept?.hasConsignee ?? hasConsignee,
      source: 'guess',
      note: cls.signals.slice(0, 3).join('; ') || undefined,
    });
  }

  const updCount = entries.filter((e) => e.kind === 'upd').length;
  const unknownCount = entries.filter((e) => e.kind === 'unknown').length;
  await writeFile(
    outPath,
    `${JSON.stringify(
      {
        note:
          'Манифест корпуса для scripts/upd-prompt-ab.ts. Правьте руками и ставьте ' +
          'source: "manual" — такие строки генератор не перезаписывает. kind: unknown ' +
          'у сканов и фото — их тип надо проставить глазами, иначе они не попадут в сверку.',
        entries,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(
    `[corpus-manifest] файлов: ${entries.length}, из них upd: ${updCount}, unknown: ${unknownCount}`,
  );
  console.log(`[corpus-manifest] записан ${outPath}`);
  console.log(
    '[corpus-manifest] проверьте строки с kind: "unknown" и hasConsignee: null — ' +
      'без ручной пометки они не участвуют в сверке.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
