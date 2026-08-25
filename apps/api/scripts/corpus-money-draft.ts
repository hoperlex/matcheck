/**
 * ЧЕРНОВИК денежной разметки корпуса из текстового слоя PDF.
 *
 * Зачем отдельный скрипт и отдельный файл. Корпусный A/B считает
 * `expectedDocuments` в манифесте ИСТИНОЙ и блокирует активацию промпта при
 * расхождении. Значит туда нельзя писать ничего, что не сверил человек с
 * бланком: ошибка в эталоне не «немного портит отчёт», а запрещает верную
 * версию промпта или пропускает неверную.
 *
 * Поэтому здесь только черновик: значения берутся детерминированно из
 * текстового слоя (`pdftotext -layout`), без участия модели, и складываются в
 * ОТДЕЛЬНЫЙ файл corpus-money-draft.json. Перенос в манифест — руками, после
 * визуальной сверки.
 *
 * Почему по границам граф, а не регулярками по числам. В строке УПД до девяти
 * числовых колонок, и «второе число слева» — не цена, а код единицы измерения.
 * Единственный надёжный ориентир — служебная строка бланка с номерами граф
 * («А 1 1а 1б 2 2а 3 4 5 6 7 8 9 …»): она задаёт координаты колонок, и данные
 * выровнены по ним. Отсюда qty = графа 3, price = графа 4 (без НДС),
 * vatSum = графа 8, sum = графа 9 (с НДС) — те же графы, что требует промпт.
 *
 * Что скрипт НЕ делает:
 *   * не трогает манифест;
 *   * не угадывает: строка, где число не читается однозначно, попадает в
 *     `unparsed` с исходным текстом, а не заполняется «примерно»;
 *   * не работает со сканами и фото — там текстового слоя нет вовсе.
 *
 * Запуск:
 *   pnpm --filter @matcheck/api exec tsx scripts/corpus-money-draft.ts
 *   pnpm --filter @matcheck/api exec tsx scripts/corpus-money-draft.ts --file "УПД … .pdf"
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extract, type DraftEntry } from './corpus-money-lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(HERE, 'corpus-manifest.json');
const OUT = join(HERE, 'corpus-money-draft.json');
const CORPUS = join(HERE, '../../../docs/debug-upd');

function main(): void {
  const only = process.argv.includes('--file')
    ? process.argv[process.argv.indexOf('--file') + 1]
    : null;

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as {
    entries: { filename: string; parsePath: string }[];
  };
  // Имена в манифесте и на диске могут различаться нормализацией Unicode.
  const onDisk = new Map(readdirSync(CORPUS).map((f) => [f.normalize('NFC'), f]));

  const targets = manifest.entries.filter(
    (e) =>
      (e.parsePath === 'text_pdf' || e.parsePath === 'multi_upd') &&
      (!only || e.filename.includes(only)),
  );

  const out: DraftEntry[] = [];
  for (const entry of targets) {
    const real = onDisk.get(entry.filename.normalize('NFC'));
    if (!real) {
      out.push({ ...entry, documents: [], skipped: 'файла нет в docs/debug-upd' });
      continue;
    }
    let text = '';
    try {
      text = execFileSync('pdftotext', ['-layout', join(CORPUS, real), '-'], {
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      out.push({ ...entry, documents: [], skipped: `pdftotext: ${(err as Error).message}` });
      continue;
    }
    const documents = extract(text);
    out.push(
      documents.length > 0
        ? { filename: entry.filename, parsePath: entry.parsePath, documents }
        : {
            filename: entry.filename,
            parsePath: entry.parsePath,
            documents: [],
            skipped: 'служебная строка граф не найдена — разметить вручную',
          },
    );
  }

  const docs = out.reduce((acc, e) => acc + e.documents.length, 0);
  const items = out.reduce(
    (acc, e) => acc + e.documents.reduce((a, d) => a + d.items.length, 0),
    0,
  );
  const unparsed = out.reduce(
    (acc, e) => acc + e.documents.reduce((a, d) => a + d.unparsed.length, 0),
    0,
  );
  const mismatched = out.flatMap((e) =>
    e.documents.filter((d) => d.totalsMismatch).map((d) => ({ file: e.filename, doc: d })),
  );
  const notCovered = out.flatMap((e) =>
    e.documents.filter((d) => d.notCovered).map((d) => ({ file: e.filename, doc: d })),
  );

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        note:
          'ЧЕРНОВИК. Значения извлечены из текстового слоя PDF (pdftotext -layout), без модели. ' +
          'В corpus-manifest.json переносить ТОЛЬКО после визуальной сверки с бланком.',
        generatedBy: 'scripts/corpus-money-draft.ts',
        columns: 'qty = графа 3, price = графа 4 (без НДС), vatSum = графа 8, sum = графа 9 (с НДС)',
        entries: out,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  console.log(`файлов: ${out.length}, документов: ${docs}, позиций: ${items}`);
  console.log(`строк, требующих ручного взгляда: ${unparsed}`);
  if (mismatched.length > 0) {
    console.log(`\nИТОГ НЕ СХОДИТСЯ С ПОЗИЦИЯМИ (${mismatched.length}) — черновик неполон:`);
    for (const m of mismatched) {
      console.log(`  ${m.file} № ${m.doc.docNumber}: ${m.doc.totalsMismatch}`);
    }
  }
  if (notCovered.length > 0) {
    console.log(`\nНЕ ПОКРЫТО денежной сверкой (${notCovered.length}) — в эталон не переносить:`);
    for (const n of notCovered) {
      console.log(`  ${n.file} № ${n.doc.docNumber}: ${n.doc.notCovered}`);
    }
  }

  const skipped = out.filter((e) => e.skipped);
  if (skipped.length > 0) {
    console.log(`\nне покрыто (${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s.filename} — ${s.skipped}`);
  }
  console.log(`\nчерновик: ${OUT}`);
}

main();
