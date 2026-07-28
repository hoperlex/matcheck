import { z } from 'zod';

/**
 * Комментарий приёмки/отгрузки — ОДНА текстовая колонка (deliveries.comment,
 * shipments.comment), в которую мобильный клиент пакует три логические части:
 *
 *   1 Этап: "<текст>"
 *   2 Этап: "<текст>"
 *   Примечание: <текст>
 *
 * Источник истины по формату — мобильный билдер:
 *   matcheck.mobile .../presentation/viewmodel/Stage2FormViewModel.kt
 *     → buildCombinedComment()
 *   matcheck.mobile .../presentation/viewmodel/DispatchStage2FormViewModel.kt
 *     → зеркальная реализация для отгрузок
 * «Примечание» на 1 этапе — это вручную введённый номер УПД (Stage1FormViewModel),
 * и мобильные списки резолвят из него заголовок карточки регексом
 * ^(?:УПД|Примечание):\s*(.+)$ — менять формат нельзя.
 *
 * Модуль живёт в contracts, а не в apps/web, потому что строку теперь пересобирает
 * СЕРВЕР (PATCH /:id/comment со слотами): единственный способ гарантировать, что
 * вывод совпадает с мобильным byte-в-byte, — держать build/parse в одном месте и
 * пинить их юнит-тестами (apps/api/test/operation-comment.test.ts).
 */

/** Лимит одного слота. Применяется и в zod-схеме, и в UI (maxLength). */
export const COMMENT_SLOT_MAX = 2000;
/** Лимит сырого комментария целиком (raw-режим). */
export const COMMENT_RAW_MAX = 8000;

export interface OperationCommentSlots {
  stage1?: string | null;
  stage2?: string | null;
  note?: string | null;
}

export interface ParsedOperationComment {
  stage1: string | null;
  stage2: string | null;
  note: string | null;
  /** True, если найден хотя бы один из префиксов. Определяет ВИД блока в UI. */
  hasStructure: boolean;
  /** Строки без распознанного префикса (backward-compat, см. ниже). */
  leftovers: string[];
  /**
   * True, если строка полностью представима тремя слотами БЕЗ потерь, то есть
   * buildOperationComment(parsed) === raw байт-в-байт. Определяет, можно ли
   * редактировать слотами: при false пересборка съела бы неизвестные строки,
   * лишние пробелы или хвостовой перевод — такие комментарии правятся только
   * целиком (raw-режим).
   */
  isCanonical: boolean;
}

// Регексы совпадают с мобильными byte-в-byte. Якорь `$` — причина, по которой
// buildOperationComment обязан схлопывать переносы внутри слота: многострочное
// значение после split('\n') не совпало бы ни с одним из них.
const STAGE1_REGEX = /^1 Этап:\s*"(.*)"$/;
const STAGE2_REGEX = /^2 Этап:\s*"(.*)"$/;
const NOTE_REGEX = /^Примечание:\s*(.+)$/;

/** Переносы внутри слота → пробел; пустой/пробельный слот → null (isNullOrBlank в Kotlin). */
function flattenSlot(value: string | null | undefined): string | null {
  if (value == null) return null;
  const flat = value.replace(/\r\n|\r|\n/g, ' ');
  return flat.trim().length === 0 ? null : flat;
}

/**
 * Сборка комментария из слотов. Зеркало Kotlin buildCombinedComment:
 * пропуск blank-частей, join('\n'), пустой результат → null.
 */
export function buildOperationComment(slots: OperationCommentSlots): string | null {
  const stage1 = flattenSlot(slots.stage1);
  const stage2 = flattenSlot(slots.stage2);
  const note = flattenSlot(slots.note);
  const lines: string[] = [];
  if (stage1 !== null) lines.push(`1 Этап: "${stage1}"`);
  if (stage2 !== null) lines.push(`2 Этап: "${stage2}"`);
  if (note !== null) lines.push(`Примечание: ${note}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Разбор комментария. Любые «прочие» непустые строки без префикса считаются
 * хвостом 2 Этапа — backward-compat с приёмками, созданными до перехода мобильного
 * на данный формат, чтобы не потерять старый текст в UI. Такая строка при этом
 * НЕ каноническая: пересборка потеряла бы её как отдельную сущность.
 */
export function parseOperationComment(raw: string | null | undefined): ParsedOperationComment {
  if (!raw || raw.trim().length === 0) {
    return {
      stage1: null,
      stage2: null,
      note: null,
      hasStructure: false,
      leftovers: [],
      isCanonical: false,
    };
  }
  let stage1: string | null = null;
  let stage2: string | null = null;
  let note: string | null = null;
  let hasStructure = false;
  const leftovers: string[] = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (s.length === 0) continue;
    const m1 = STAGE1_REGEX.exec(s);
    if (m1) {
      stage1 = m1[1] ?? null;
      hasStructure = true;
      continue;
    }
    const m2 = STAGE2_REGEX.exec(s);
    if (m2) {
      stage2 = m2[1] ?? null;
      hasStructure = true;
      continue;
    }
    const mn = NOTE_REGEX.exec(s);
    if (mn) {
      note = (mn[1] ?? '').trim() || null;
      hasStructure = true;
      continue;
    }
    leftovers.push(s);
  }
  if (stage2 === null && leftovers.length > 0) {
    stage2 = leftovers.join('\n');
  }
  const isCanonical =
    hasStructure &&
    leftovers.length === 0 &&
    buildOperationComment({ stage1, stage2, note }) === raw;
  return { stage1, stage2, note, hasStructure, leftovers, isCanonical };
}

export type MergeCommentResult =
  | { ok: true; comment: string | null }
  | { ok: false; reason: 'not_canonical' };

/**
 * Слот-мерж: читаем ТЕКУЩЕЕ значение, подменяем только присланные слоты
 * (undefined = «не трогать», null/'' = «очистить»), пересобираем.
 *
 * Смысл — пережить гонку с мобилой: пока менеджер правил «Примечание», инспектор
 * мог дописать «2 Этап». Отправка строки целиком откатила бы его текст, слот-мерж
 * сохраняет.
 *
 * Пустой текущий комментарий — валидная база (можно добавить первый слот).
 * Неканонический — отказ: слепая пересборка потеряла бы неизвестные строки.
 */
export function mergeOperationComment(
  current: string | null | undefined,
  patch: OperationCommentSlots,
): MergeCommentResult {
  let base: OperationCommentSlots;
  if (!current || current.trim().length === 0) {
    base = { stage1: null, stage2: null, note: null };
  } else {
    const parsed = parseOperationComment(current);
    if (!parsed.isCanonical) return { ok: false, reason: 'not_canonical' };
    base = { stage1: parsed.stage1, stage2: parsed.stage2, note: parsed.note };
  }
  return {
    ok: true,
    comment: buildOperationComment({
      stage1: patch.stage1 !== undefined ? patch.stage1 : base.stage1,
      stage2: patch.stage2 !== undefined ? patch.stage2 : base.stage2,
      note: patch.note !== undefined ? patch.note : base.note,
    }),
  };
}

/**
 * Raw-режим: пробельная строка → null, иначе строка КАК ЕСТЬ, без trim.
 * Именно ради сохранения переносов и отступов raw-режим и существует —
 * trim здесь молча портил бы legacy-комментарии.
 */
export function normalizeRawComment(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  return raw.trim().length === 0 ? null : raw;
}

/**
 * Тело PATCH /api/v1/{deliveries|shipments}/:id/comment.
 * Ровно один из двух режимов: raw (comment) или слотовый (stage1/stage2/note).
 */
export const OperationCommentPatchSchema = z
  .object({
    comment: z.string().max(COMMENT_RAW_MAX).nullable().optional(),
    stage1: z.string().max(COMMENT_SLOT_MAX).nullable().optional(),
    stage2: z.string().max(COMMENT_SLOT_MAX).nullable().optional(),
    note: z.string().max(COMMENT_SLOT_MAX).nullable().optional(),
  })
  .refine(
    (b) => {
      const hasSlots =
        b.stage1 !== undefined || b.stage2 !== undefined || b.note !== undefined;
      const hasRaw = b.comment !== undefined;
      return hasRaw !== hasSlots;
    },
    {
      message:
        'Укажите либо comment (текст целиком), либо хотя бы один из stage1/stage2/note — но не оба режима сразу',
    },
  );
export type OperationCommentPatch = z.infer<typeof OperationCommentPatchSchema>;
