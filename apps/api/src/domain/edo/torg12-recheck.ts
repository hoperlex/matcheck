import type { ImageDocKind } from './vision-classifier.js';
import type { PageClassification, PageType } from './upd-page-prefilter.js';

/**
 * Перепроверка ТОРГ-12 — правила без сети и окружения.
 *
 * Зачем. Товарная накладная РОКВУЛ (ТОРГ-12, ОКУД 0330212) печатается на двух
 * листах: на первом шапка и пустая таблица, на втором строки, «Итого» и подписи.
 * Пользователи грузят их двумя фото одной загрузкой, и оба классификатора
 * ошибаются ровно в одном месте:
 *   * классификатор ФАЙЛА называет лист со строками формой М-15 (боевые
 *     документы: у всех десяти вторых листов parse_mode='m15_vision'), и лист
 *     уходит отдельным документом ещё до сборки;
 *   * классификатор СТРАНИЦ называет лист с шапкой «ТН» из-за рамки
 *     «Транспортная накладная» в правом верхнем углу — сборка откатывается с
 *     «нет ни одной УПД-страницы», и шапка разбирается без строк.
 *
 * Почему не рубильники ROUTER_CLASSIFY_TORG12 / PAGE_CLASSIFY_TORG12. Они
 * подменяют текст классификатора для ВСЕХ загрузок (тысячи вызовов в месяц),
 * и любой сдвиг в ответах модели задел бы документы, которые сегодня
 * распознаются верно. Здесь обратная гарантия, по построению:
 *   * переспрашивается только то, что СЕЙЧАС названо М-15 / ТН (файл) или
 *     ТН / сертификат / М-15 (страница);
 *   * заменить вердикт можно только на «УПД»;
 *   * всё, что сейчас «УПД» или «прочее», не переспрашивается и не меняется.
 */

export type Torg12RecheckMode = 'off' | 'shadow' | 'on';

/** Порог уверенности, с которым роутер вообще принимает вердикт модели. */
export const TORG12_RECHECK_MIN_CONFIDENCE = 0.6;

export type FileVerdict = { kind: ImageDocKind; confidence: number };

/** Вердикты классификатора файла, которые переспрашиваются. */
const FILE_SUSPICIOUS: ReadonlySet<ImageDocKind> = new Set<ImageDocKind>(['m15', 'transport_waybill']);

/**
 * Нужна ли перепроверка файлу.
 *
 * Только ПРИНЯТЫЙ роутером вердикт (уверенность от порога): неуверенный ответ
 * роутер и так не применяет, файл уходит по прежней ветке, и трогать её здесь
 * значило бы менять поведение для документов, к ТОРГ-12 отношения не имеющих.
 */
export function fileNeedsRecheck(base: FileVerdict | null | undefined): base is FileVerdict {
  return (
    base != null &&
    base.confidence >= TORG12_RECHECK_MIN_CONFIDENCE &&
    FILE_SUSPICIOUS.has(base.kind)
  );
}

/**
 * Итог перепроверки файла. Замена — только на «УПД» и только уверенная;
 * любой другой ответ, включая отсутствие ответа, оставляет вердикт как был.
 */
export function mergeFileVerdict(
  base: FileVerdict,
  recheck: FileVerdict | null | undefined,
): { verdict: FileVerdict; changed: boolean } {
  if (!fileNeedsRecheck(base)) return { verdict: base, changed: false };
  if (recheck && recheck.kind === 'upd' && recheck.confidence >= TORG12_RECHECK_MIN_CONFIDENCE) {
    return { verdict: recheck, changed: true };
  }
  return { verdict: base, changed: false };
}

/** Типы страниц, которые переспрашиваются. */
const PAGE_SUSPICIOUS: ReadonlySet<PageType> = new Set<PageType>([
  'transport_waybill',
  'certificate',
  'm15',
]);

const PAGE_UPD: ReadonlySet<PageType> = new Set<PageType>(['upd_main', 'upd_continuation']);

/** Нужна ли перепроверка пакету: есть хотя бы одна подозрительная страница. */
export function pagesNeedRecheck(base: readonly PageClassification[]): boolean {
  return base.some((p) => PAGE_SUSPICIOUS.has(p.type));
}

/**
 * Итог перепроверки страниц пакета.
 *
 * Пакет считается ТОРГ-12 только если перепроверка нашла ШАПКУ (upd_main)
 * среди страниц, которые обычный вызов назвал ТН / сертификатом / М-15. Без
 * такой находки ничего не меняется вовсе — ни одна страница: настоящая ТН при
 * УПД остаётся ТН, даже если модель на втором вопросе передумала про соседний
 * лист.
 *
 * Когда шапка найдена, заменяются только страницы с вердиктом из подозрительных
 * или «прочее» и только на upd_main / upd_continuation. «Прочее» допускается
 * здесь, и только здесь: лист со строками ТОРГ-12 без шапки обычный вызов
 * называет и так. Страницы, уже признанные УПД, не трогаются никогда.
 */
export function mergePageVerdicts(
  base: readonly PageClassification[],
  recheck: readonly PageClassification[] | null | undefined,
): { classification: PageClassification[]; changedPages: number[] } {
  const unchanged = { classification: [...base], changedPages: [] as number[] };
  if (!recheck || !pagesNeedRecheck(base)) return unchanged;

  const byPage = new Map(recheck.map((p) => [p.page, p]));
  const headerFound = base.some(
    (p) => PAGE_SUSPICIOUS.has(p.type) && byPage.get(p.page)?.type === 'upd_main',
  );
  if (!headerFound) return unchanged;

  const changedPages: number[] = [];
  const classification = base.map((p) => {
    if (!(PAGE_SUSPICIOUS.has(p.type) || p.type === 'other')) return p;
    const r = byPage.get(p.page);
    if (!r || !PAGE_UPD.has(r.type)) return p;
    changedPages.push(p.page);
    // Номер страницы — из базы: по нему страница связана с файлом пакета.
    return { ...r, page: p.page };
  });
  return { classification, changedPages };
}
