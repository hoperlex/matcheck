/**
 * Целостность манифеста корпуса — того, по чему сверяются версии промпта.
 *
 * Манифест правится руками и пересобирается генератором
 * (scripts/corpus-manifest-build.ts). Генератор бережёт строки `source:
 * "manual"`, но ошибка в разметке или неаккуратная пересборка тихо выкидывают
 * файлы из сверки: запись с `kind: "unknown"` просто пропускается фильтром
 * скрипта, и прогон отчитывается «всё зелено» на половине корпуса.
 *
 * Именно так дефект подстановки ИНН и доехал до боя: vision-файлы (фото и
 * сканы) лежали как `unknown`, и корпусный A/B их не видел — проверялись
 * только текстовые PDF, хотя боевые документы приходят фотографиями.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

type Entry = {
  filename: string;
  kind: string;
  parsePath: string;
  hasConsignee: boolean | null;
  source: string;
  expectedDocuments?: {
    docNumber: string;
    consignee: { name: string; inn: string | null; kpp: string | null };
  }[];
};

const manifest = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../scripts/corpus-manifest.json'),
    'utf-8',
  ),
) as { entries: Entry[] };

const entries = manifest.entries;

describe('corpus-manifest — покрытие сверки промптов', () => {
  it('в корпусе не осталось файлов с неопределённым типом', () => {
    // kind: "unknown" = файл молча выпадает из прогона.
    const unknown = entries.filter((e) => e.kind === 'unknown').map((e) => e.filename);
    expect(unknown).toEqual([]);
  });

  it('vision-путь покрыт: есть УПД и накладные, разбираемые картинкой', () => {
    // Главный сценарий портала — фотографии и сканы. Без них сверка проверяет
    // только текстовые PDF, то есть меньшую часть боевого потока.
    const updVision = entries.filter((e) => e.kind === 'upd' && e.parsePath === 'vision');
    const m15Vision = entries.filter((e) => e.kind === 'm15' && e.parsePath === 'vision');
    expect(updVision.length).toBeGreaterThanOrEqual(10);
    expect(m15Vision.length).toBeGreaterThanOrEqual(3);
  });

  it('каждый файл сверки говорит, что ожидается: эталон или явное «графа пуста»', () => {
    // Excel промпт не использует, поэтому от него эталон не требуется.
    //
    // Файлы без грузополучателя (в корпусе это УПД №100000 и две копии
    // Х-3655 — там напечатана только подпись графы) описываются не пустым
    // эталоном, а `hasConsignee: false`. Это тоже проверяемое утверждение, и
    // даже более строгое: модель не должна выдумать сторону там, где её нет.
    const needStatement = entries.filter(
      (e) => (e.kind === 'upd' || e.kind === 'm15') && e.parsePath !== 'excel',
    );
    const silent = needStatement
      .filter((e) => !e.expectedDocuments?.length && e.hasConsignee !== false)
      .map((e) => e.filename);
    expect(silent).toEqual([]);
  });

  it('файлы с пустой графой 4 помечены явно и не имеют эталона имени', () => {
    const emptyGraph = entries.filter((e) => e.hasConsignee === false);
    expect(emptyGraph.length).toBeGreaterThanOrEqual(3);
    for (const e of emptyGraph) {
      expect(e.expectedDocuments ?? [], e.filename).toHaveLength(0);
      expect(e.source, e.filename).toBe('manual');
    }
  });

  it('эталоны размечены вручную и не будут перезаписаны генератором', () => {
    const notManual = entries
      .filter((e) => e.expectedDocuments?.length && e.source !== 'manual')
      .map((e) => e.filename);
    expect(notManual).toEqual([]);
  });

  it('в эталонах указано имя грузополучателя и явно проставлены inn/kpp', () => {
    // null здесь — не «забыли заполнить», а утверждение «в документе реквизитов
    // нет». Именно на нём держится проверка подстановки ИНН покупателя,
    // поэтому поля обязаны присутствовать, а не отсутствовать.
    for (const e of entries) {
      for (const doc of e.expectedDocuments ?? []) {
        expect(doc.consignee.name, e.filename).toBeTruthy();
        expect(doc, e.filename).toHaveProperty('consignee.inn');
        expect(doc, e.filename).toHaveProperty('consignee.kpp');
      }
    }
  });

  it('пакеты УПД описаны по субдокументам, а не одной строкой на файл', () => {
    // multi_upd содержит 4, 5 и 15 логических УПД: один эталон на файл
    // означал бы, что грузополучатель у одного из пятнадцати сойдёт за успех.
    for (const e of entries.filter((x) => x.parsePath === 'multi_upd')) {
      expect(e.expectedDocuments!.length, e.filename).toBeGreaterThan(1);
      const numbers = e.expectedDocuments!.map((d) => d.docNumber);
      expect(new Set(numbers).size, `${e.filename}: номера субдокументов должны различаться`).toBe(
        numbers.length,
      );
    }
  });
});
