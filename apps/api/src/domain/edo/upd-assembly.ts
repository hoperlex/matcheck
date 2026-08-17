// Сборка логических УПД из страниц пакета — детерминированная часть.
//
// Задача: поставщик привозит машину и фотографирует документы постранично.
// Каждая фотография — отдельный файл, но УПД в них, скажем, три: страницы 1-2
// от № 1691, страницы 3-4-5 от № 1736, страница 6 от № 1381. Пофайловый разбор
// делает из этого шесть документов, два из которых — обрубки без шапки.
//
// Здесь живёт всё, что решается без БД и без сети: как склеить ответы
// классификатора, посчитанные порциями, и можно ли доверять получившейся
// нарезке. Работа с S3, манифестом и документами — в worker.

import type { PageClassification, PageType } from './upd-page-prefilter.js';
import { segmentUpdPages, type UpdPageSegment } from './upd-batch.parser.js';

/**
 * Адрес страницы внутри пакета.
 *
 * Переживает пересборку: файл идентифицируется строкой реестра и порядковым
 * номером в пачке, а не ключом S3 (тот может смениться при повторной заливке)
 * и не позицией в выборке (она ничем не задана).
 */
export type PageRef = {
  registryItemId: string | null;
  inputOrder: number;
  /** Номер страницы внутри файла, 1-based. У фотографии всегда 1. */
  pageInFile: number;
};

/** Страница пакета, готовая к классификации и извлечению. */
export type AssemblyPage = {
  ref: PageRef;
  /** Сквозной номер страницы в пакете, 1-based — им оперирует классификатор. */
  globalPage: number;
  /** PNG в нормальном разрешении — уходит в извлечение. */
  full: Buffer;
  /** Уменьшенный PNG — уходит в классификацию. */
  thumb: Buffer;
};

export type SegmentPlan = {
  segments: UpdPageSegment[];
  /**
   * Можно ли публиковать результат сборки.
   *
   * false означает не «ошибка», а «нарезке нельзя доверять»: пакет уйдёт
   * прежним путём «файл = документ». Лучше шесть честных обрубков, которые
   * менеджер видит и правит, чем три документа с чужими позициями.
   */
  confident: boolean;
  reasons: string[];
};

/**
 * Склеивает классификацию, полученную порциями, в сквозную нумерацию.
 *
 * classifyPages нумерует страницы заново с единицы в КАЖДОМ вызове — он не
 * знает, что до него уже классифицировали пятнадцать страниц. Без сдвига
 * шестнадцатая страница вернулась бы как первая и попала бы в чужой сегмент.
 *
 * @param chunks результаты вызовов в том же порядке, что и порции страниц
 * @param chunkSizes размеры порций — сдвиг считается по ним, а не по длине
 *   ответа: модель может не упомянуть часть страниц, и накопленный сдвиг
 *   поехал бы.
 */
export function mergeClassificationChunks(
  chunks: PageClassification[][],
  chunkSizes: number[],
): PageClassification[] {
  const out: PageClassification[] = [];
  let offset = 0;
  chunks.forEach((chunk, i) => {
    for (const c of chunk) {
      out.push({ ...c, page: c.page + offset });
    }
    offset += chunkSizes[i] ?? 0;
  });
  return out.sort((a, b) => a.page - b.page);
}

/** Типы страниц, которые уверенно не относятся к УПД и в сегменты не идут. */
const DROPPED_TYPES: ReadonlySet<PageType> = new Set<PageType>([
  'transport_waybill',
  'certificate',
]);

/**
 * Планирует сегменты по классификации всех страниц пакета.
 *
 * @param totalPages сколько страниц реально есть в пакете. Передаётся отдельно,
 *   потому что классификатор возвращает ТОЛЬКО те страницы, которые упомянул в
 *   JSON: если модель ответила про 1, 2 и 4, страница 3 в его ответе просто
 *   отсутствует. Отдать такой список в segmentUpdPages как есть — молча
 *   потерять страницу вместе с её позициями.
 * @param maxPagesPerSegment предел страниц на один vision-вызов.
 */
export function planUpdSegments(
  classification: PageClassification[],
  totalPages: number,
  maxPagesPerSegment: number,
): SegmentPlan {
  const reasons: string[] = [];
  const byPage = new Map(classification.map((c) => [c.page, c]));

  // Страницы, которые идут в сегментацию: все реальные, кроме уверенно чужих.
  // Не упомянутая классификатором страница остаётся в наборе — segmentUpdPages
  // увидит её как unknown, прикрепит к текущему сегменту и пометит его
  // uncertain. Это и нужно: страница не теряется, а пакет честно признаётся
  // сомнительным.
  const selectedPages: number[] = [];
  const unclassified: number[] = [];
  for (let page = 1; page <= totalPages; page++) {
    const known = byPage.get(page);
    if (known && DROPPED_TYPES.has(known.type)) continue;
    if (!known) unclassified.push(page);
    selectedPages.push(page);
  }
  if (unclassified.length > 0) {
    reasons.push(`классификатор не упомянул страницы: ${unclassified.join(', ')}`);
  }

  if (selectedPages.length === 0) {
    return { segments: [], confident: false, reasons: [...reasons, 'нет ни одной УПД-страницы'] };
  }

  const segments = segmentUpdPages(classification, selectedPages);
  if (segments.length === 0) {
    return { segments, confident: false, reasons: [...reasons, 'сегментация не дала документов'] };
  }

  let confident = unclassified.length === 0;
  for (const seg of segments) {
    // `uncertain` НЕ отменяет сборку, если сегмент начат шапкой.
    //
    // Такой сегмент получается, когда к документу с распознанным `upd_main`
    // прикрепилась страница, которую классификатор не отнёс ни к шапке, ни к
    // продолжению: оборот с подписями и печатями, приложение, спецификация.
    // Границы документов при этом определены достоверно — по шапкам, — и
    // отменять из-за такой страницы весь комплект незачем. На бою это была
    // САМАЯ ЧАСТАЯ причина отката: 18 случаев из 52 за месяц, то есть машины
    // разваливались на отдельные документы там, где нарезка была верной.
    //
    // Чужой документ внутри пачки сюда не попадает: сертификаты и накладные
    // отсеиваются раньше (DROPPED_TYPES) и в сегменты не входят вовсе.
    //
    // А вот `fallback` доверия по-прежнему лишает — это сегмент, открытый НЕ
    // шапкой: продолжение без начала либо непонятная страница сама по себе.
    // Там неизвестно даже, сколько документов в пачке.
    const startedByHeader = seg.reasons[0] === 'opened_by_upd_main';
    const trustworthy = seg.confidence === 'normal' || (seg.confidence === 'uncertain' && startedByHeader);
    if (!trustworthy) {
      confident = false;
      reasons.push(`сегмент ${seg.segmentIndex}: ${seg.confidence} (${seg.reasons.join(', ')})`);
    } else if (seg.confidence === 'uncertain') {
      // Причину всё равно записываем: сегмент уезжает в распознавание с чужой
      // страницей внутри, и при разборе инцидента это первое, что понадобится.
      reasons.push(
        `сегмент ${seg.segmentIndex}: принят с оговоркой (${seg.reasons.join(', ')})`,
      );
    }
    if (seg.pages.length > maxPagesPerSegment) {
      confident = false;
      reasons.push(
        `сегмент ${seg.segmentIndex}: ${seg.pages.length} страниц — больше предела ${maxPagesPerSegment}`,
      );
    }
  }

  return { segments, confident, reasons };
}

/**
 * Адреса страниц сегмента — то, что уезжает в манифест.
 *
 * Порядок сохраняется: продолжение таблицы позиций читается только вместе с
 * предшествующей страницей.
 */
export function pageRefsOfSegment(segment: UpdPageSegment, pages: AssemblyPage[]): PageRef[] {
  const byGlobal = new Map(pages.map((p) => [p.globalPage, p]));
  return segment.pages
    .map((p) => byGlobal.get(p)?.ref)
    .filter((r): r is PageRef => r != null);
}

/**
 * Файлы, чьи страницы вошли в сегмент, — по ним собираются вложения документа.
 * Один файл может дать страницы нескольким сегментам (многостраничный PDF), и
 * наоборот, несколько файлов — одному (россыпь фотографий).
 */
export function inputOrdersOfSegment(segment: UpdPageSegment, pages: AssemblyPage[]): number[] {
  const byGlobal = new Map(pages.map((p) => [p.globalPage, p]));
  const orders = new Set<number>();
  for (const p of segment.pages) {
    const page = byGlobal.get(p);
    if (page) orders.add(page.ref.inputOrder);
  }
  return [...orders].sort((a, b) => a - b);
}
