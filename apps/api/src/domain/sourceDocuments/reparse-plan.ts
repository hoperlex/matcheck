// Каким путём повторно распознавать документ.
//
// Инвариант: повтор идёт ТЕМ ЖЕ путём, каким документ появился. Универсального
// «разобрать файл заново» не существует — у одного и того же вложения четыре
// разных смысла:
//
//   * одиночный УПД        → разбор всего файла (текст → vision);
//   * М-15                 → тот же файл, но vision-промптом накладной;
//   * сегмент комплекта    → ТОЛЬКО свои страницы из манифеста bundle_segments;
//     разбор всего файла склеил бы 5/15/4 логических УПД в один документ;
//   * ТН/ОС-2 из пакета    → parseWaybillBatch по вложениям документа.
//
// Живёт в domain, а не в worker.ts, по той же причине, что и соседние модули:
// worker.ts на верхнем уровне поднимает очередь и двух BullMQ-воркеров, и его
// импорт из API-кода или из stuck-jobs поднял бы второго воркера в чужом
// процессе. План используют маршрут ручного повтора и generation-aware
// recovery; оба обязаны строить payload одинаково, иначе восстановленное
// задание уедет не тем путём.

import { and, eq, sql as drSql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import {
  bundleImportItems,
  bundleSegments,
  sourceBundles,
  sourceDocumentAttachments,
  sourceDocuments,
} from '../../db/schema.js';
import { dispatchKeyOf } from '../jobs/job-outbox.js';

export type ReparsePlanKind = 'single' | 'm15' | 'segment' | 'waybill';

/**
 * Payload задания повтора. Формы совпадают с UpdParseJobData (plugins/queue.ts);
 * тип здесь свой и структурный, чтобы domain не тянул плагин Fastify.
 */
export type ReparseJobPayload = Record<string, unknown>;

export type ReparsePlan = {
  kind: ReparsePlanKind;
  payload: ReparseJobPayload;
  /**
   * Ключ диспетчеризации, он же jobId. Всегда документный: повтор адресует
   * ДОКУМЕНТ и его поколение.
   *
   * У сегмента это отличается от первичной постановки, и намеренно. Первичное
   * задание сегмента живёт под segmentDispatchKeyOf(segmentId, поколение
   * сборки) — тем же ключом его восстанавливает repair, иначе BullMQ принял бы
   * второе задание того же поколения и сегмент распознался бы дважды. Ручной
   * повтор — другое событие: он происходит уже после публикации комплекта, у
   * него своё поколение документа, и смешивать его с ключом сборки нельзя.
   */
  dedupeKey: string;
};

export type ReparseBlockReason = 'no_attachment' | 'segment_manifest_stale' | 'assembly_busy';

export type ReparsePlanResult = ReparsePlan | { blocked: ReparseBlockReason };

export function isBlocked(r: ReparsePlanResult): r is { blocked: ReparseBlockReason } {
  return 'blocked' in r;
}

/** Человекочитаемое объяснение отказа — для 409 и для логов. */
export const REPARSE_BLOCK_MESSAGES: Record<ReparseBlockReason, string> = {
  no_attachment: 'У документа нет исходного файла — распознавать нечего',
  segment_manifest_stale:
    'Комплект был пересобран: страницы этого документа больше не описаны манифестом',
  assembly_busy: 'Комплект сейчас пересобирается — повторите попытку позже',
};

type DocRow = {
  id: string;
  kind: string;
  parseMode: string | null;
  parseErrorCode: string | null;
  dispatchGeneration: number;
};

/**
 * Строит план повтора по текущему состоянию документа.
 *
 * @param docGeneration поколение, ПОД которое ставится задание. У маршрута это
 * уже увеличенное значение, у recovery — текущее из БД. Отдельным параметром, а
 * не полем doc: маршрут увеличивает счётчик и ставит задание в одной
 * транзакции, и читать документ повторно только ради поколения незачем.
 */
export async function resolveReparsePlan(
  db: Db,
  doc: DocRow,
  docGeneration: number,
  opts: { reparse?: boolean } = {},
): Promise<ReparsePlanResult> {
  const dedupeKey = dispatchKeyOf(doc.id, docGeneration);
  const reparse = opts.reparse ? ({ reparse: true as const } as const) : {};

  // 1. Сегмент комплекта. Проверяется первым: у такого документа есть и
  //    вложение (весь PDF), и kind='upd', так что все прочие правила подошли бы
  //    ему ошибочно.
  const [segment] = await db
    .select({
      id: bundleSegments.id,
      bundleId: bundleSegments.bundleId,
      generation: bundleSegments.generation,
    })
    .from(bundleSegments)
    .where(eq(bundleSegments.sourceDocumentId, doc.id))
    .limit(1);

  if (segment) {
    const [root] = await db
      .select({
        activeGeneration: sourceBundles.activeUploadGeneration,
        status: sourceBundles.status,
      })
      .from(sourceBundles)
      .where(eq(sourceBundles.id, segment.bundleId))
      .limit(1);

    // Манифест того поколения, что и активная загрузка пакета. Разошлись —
    // комплект пересобрали, и страницы этого документа описаны уже другими
    // строками: распознавать по устаревшему манифесту нельзя.
    if (!root || root.activeGeneration !== segment.generation) {
      return { blocked: 'segment_manifest_stale' };
    }
    // Пересборка идёт прямо сейчас — не вмешиваемся.
    if (root.status === 'processing') return { blocked: 'assembly_busy' };

    return {
      kind: 'segment',
      payload: {
        sourceDocumentId: doc.id,
        segmentId: segment.id,
        generation: segment.generation,
        docGeneration,
        // Только ручной повтор ослабляет fencing сборки.
        // Recovery неопубликованного сегмента приходит без этого флага.
        ...reparse,
      },
      dedupeKey,
    };
  }

  // Всем остальным путям нужен исходный файл.
  const [attachment] = await db
    .select({ s3Key: sourceDocumentAttachments.s3Key })
    .from(sourceDocumentAttachments)
    .where(
      and(
        eq(sourceDocumentAttachments.sourceDocumentId, doc.id),
        eq(sourceDocumentAttachments.role, 'original'),
      ),
    )
    .limit(1);

  // 2. Накладные пакетного пути (ТН и ОС-2 из parseWaybillBatch). Проверяется
  //    раньше m15: у обоих kind='transport_waybill', но форму документа
  //    (М-15 против ТН/ОС-2) знает только реестр импорта или parse_mode.
  if (!attachment) return { blocked: 'no_attachment' };

  // Пустой ответ waybill-промпта означает не «этот файл точно накладная», а
  // лишь «в нём не нашли ТН-2116/ОС-2». Частый случай — ТОРГ-12, ошибочно
  // направленная сюда старым роутером. Повторять тот же waybill-вызов
  // бесполезно: накопившийся документ должен получить шанс в общем УПД-пути.
  //
  // Условие строго по коду исхода. Все реально разобранные ТН/ОС-2, включая
  // legacy без parse_mode, продолжают повторяться пакетным парсером.
  if (doc.parseErrorCode === 'no_waybill_found') {
    return {
      kind: 'single',
      payload: { sourceDocumentId: doc.id, s3Key: attachment.s3Key, docGeneration, ...reparse },
      dedupeKey,
    };
  }

  if (doc.kind === 'transport_waybill' || doc.kind === 'os2_transfer') {
    if (await parsedAsM15(db, doc)) {
      return {
        kind: 'm15',
        payload: {
          sourceDocumentId: doc.id,
          s3Key: attachment.s3Key,
          docKind: 'm15',
          docGeneration,
          ...reparse,
        },
        dedupeKey,
      };
    }
    // s3Key в payload не кладём намеренно: пакетный разбор берёт ВСЕ вложения
    // документа, а не один файл, — их и читает воркер.
    return {
      kind: 'waybill',
      payload: { sourceDocumentId: doc.id, mode: 'waybill_single', docGeneration, ...reparse },
      dedupeKey,
    };
  }

  // 3. Всё прочее — общий УПД-путь: формат определяет расширение s3Key, ровно
  //    как при первой загрузке.
  return {
    kind: 'single',
    payload: { sourceDocumentId: doc.id, s3Key: attachment.s3Key, docGeneration, ...reparse },
    dedupeKey,
  };
}

/**
 * Разбирался ли документ vision-промптом М-15.
 *
 * `parse_mode` появился вместе с повтором, поэтому у документов, загруженных
 * раньше, он пуст — для них признак берётся из реестра импорта, где router
 * записал своё решение (`detected_kind='m15'`). Оба источника — факт о
 * прошедшем разборе, а не догадка по типу документа: kind='transport_waybill'
 * одинаков и у М-15, и у ТН из пакетного пути.
 */
async function parsedAsM15(db: Db, doc: DocRow): Promise<boolean> {
  if (doc.parseMode) return doc.parseMode === 'm15_vision';

  const [item] = await db
    .select({ detectedKind: bundleImportItems.detectedKind })
    .from(bundleImportItems)
    .where(
      and(
        eq(bundleImportItems.detectedKind, 'm15'),
        // jsonb-массив созданных документов содержит наш id.
        drSql`${bundleImportItems.createdDocumentIds} @> ${JSON.stringify([doc.id])}::jsonb`,
      ),
    )
    .limit(1);
  return Boolean(item);
}

/** Колонки документа, которых достаточно для построения плана. */
export const REPARSE_DOC_COLUMNS = {
  id: sourceDocuments.id,
  kind: sourceDocuments.kind,
  parseMode: sourceDocuments.parseMode,
  parseErrorCode: sourceDocuments.parseErrorCode,
  dispatchGeneration: sourceDocuments.dispatchGeneration,
} as const;
