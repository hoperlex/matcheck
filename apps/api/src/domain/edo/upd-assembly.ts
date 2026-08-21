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

export type PlanUpdSegmentsOptions = {
  /**
   * `globalPage → inputOrder` файла, из которого страница получена.
   *
   * Нужна, чтобы переставлять ФАЙЛЫ, а не отдельные страницы: внутри
   * многостраничного PDF порядок физический и осмысленный, ломать его нельзя.
   */
  pageOwners?: ReadonlyMap<number, number>;
  /** Рубильник UPD_ASSEMBLY_REORDER_V1. Выключен — поведение прежнее целиком. */
  reorder?: boolean;
};

/**
 * Порядок «шапка первой» — или null, если случай неоднозначный.
 *
 * Условия намеренно узкие. Одной страницы `upd_main` в пакете НЕ достаточно:
 * у второй УПД шапку могли прочитать как продолжение, и тогда перестановка
 * приклеила бы её к чужому документу. Требование «ровно два одностраничных
 * файла, один main и один continuation» такую возможность резко сужает —
 * приклеивать больше не к чему.
 *
 * Полностью её не исключает даже это: две одностраничные УПД, у одной из
 * которых шапка прочитана неверно, выглядят точно так же. Различить их без
 * номера документа на странице нельзя, а его классификатор не возвращает.
 *
 * Цена такой ошибки — два документа СОЛЬЮТСЯ В ОДИН: одной карточки не
 * досчитаются, а её позиции окажутся в чужой. Риск принят сознательно против
 * гарантированно разваленного комплекта сегодня, но недооценивать его нельзя:
 * расширять условия применимости без номера документа на странице — нельзя.
 */
function headerFirstOrder(
  classification: PageClassification[],
  selectedPages: number[],
  totalPages: number,
  plan: SegmentPlan,
  pageOwners?: ReadonlyMap<number, number>,
): number[] | null {
  if (!pageOwners) return null;

  // Лечим ровно один вид отказа. Прочие причины (страница сверх предела,
  // неупомянутые страницы, чужой тип внутри) перестановкой не исправляются.
  const orphanContinuation = plan.segments.some(
    (seg) => seg.confidence === 'fallback' && seg.reasons[0] === 'continuation_without_main',
  );
  if (!orphanContinuation) return null;

  // Ровно две страницы во всём пакете, и обе идут в сегментацию: ни одна не
  // отброшена как чужая и ни одна не осталась неупомянутой.
  if (totalPages !== 2 || selectedPages.length !== 2) return null;

  // Каждая страница — из своего файла. Два листа одного PDF переставлять
  // нельзя: там порядок задан самим документом.
  const owners = selectedPages.map((page) => pageOwners.get(page));
  if (owners.some((owner) => owner === undefined)) return null;
  if (new Set(owners).size !== 2) return null;

  // Типы известны и ровно те, что нужны. Проверка заодно отсекает `unknown`,
  // `other` и всё, что классификатор не отнёс ни к шапке, ни к продолжению:
  // при любом третьем типе счётчики не сойдутся.
  const typeByPage = new Map(classification.map((c) => [c.page, c.type]));
  const mains = selectedPages.filter((page) => typeByPage.get(page) === 'upd_main');
  const continuations = selectedPages.filter(
    (page) => typeByPage.get(page) === 'upd_continuation',
  );
  if (mains.length !== 1 || continuations.length !== 1) return null;

  // Шапка и так первая — переставлять нечего, отказ был по другой причине.
  if (selectedPages[0] === mains[0]) return null;

  return [mains[0]!, continuations[0]!];
}

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
  opts?: PlanUpdSegmentsOptions,
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

  const plan = evaluatePageOrder(
    classification,
    selectedPages,
    maxPagesPerSegment,
    reasons,
    unclassified.length === 0,
    false,
  );
  if (plan.confident) return plan;

  // Нарезке не поверили. Единственный отказ, который лечится перестановкой, —
  // «продолжение без начала»: страница с шапкой в пакете есть, но загружена
  // второй. Пробуем поставить её вперёд и пересчитать.
  if (!opts?.reorder) return plan;
  const headerFirst = headerFirstOrder(classification, selectedPages, totalPages, plan, opts.pageOwners);
  if (!headerFirst) return plan;
  const reordered = evaluatePageOrder(
    classification,
    headerFirst,
    maxPagesPerSegment,
    reasons,
    unclassified.length === 0,
    true,
  );
  // Перестановка не помогла — отдаём ИСХОДНЫЙ план: он честно описывает, что
  // увидел классификатор, и по нему разбирают инциденты.
  if (!reordered.confident) return plan;
  return { ...reordered, reasons: [...reordered.reasons, REORDERED_REASON] };
}

/** Отметка в reasons: по ней на бою видно, что план получен перестановкой. */
export const REORDERED_REASON =
  'порядок файлов скорректирован: страница с шапкой поставлена первой';

/**
 * Оценивает ОДИН порядок страниц: режет на сегменты и решает, можно ли верить.
 *
 * Вынесено из planUpdSegments, потому что порядков может быть два — исходный и
 * с шапкой вперёд, — и оба обязаны оцениваться одним и тем же правилом.
 */
function evaluatePageOrder(
  classification: PageClassification[],
  selectedPages: number[],
  maxPagesPerSegment: number,
  baseReasons: string[],
  classifiedFully: boolean,
  preserveOrder: boolean,
): SegmentPlan {
  const reasons = [...baseReasons];
  const segments = segmentUpdPages(classification, selectedPages, { preserveOrder });
  if (segments.length === 0) {
    return { segments, confident: false, reasons: [...reasons, 'сегментация не дала документов'] };
  }

  let confident = classifiedFully;
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
