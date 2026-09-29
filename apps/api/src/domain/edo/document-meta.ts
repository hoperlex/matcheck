/**
 * Что Диадок сообщает о документе до скачивания содержимого.
 *
 * Зачем отдельный нормализатор. Сведения разбросаны по трём местам и в двух
 * поколениях API:
 *
 *   - номер и дата: актуально — коллекция `DocumentInfo.Metadata`
 *     («ключ → значение»), прямые поля `DocumentNumber`/`DocumentDate` Диадок
 *     объявил устаревшими и может перестать заполнять;
 *   - время: у события ленты его нет вовсе, у документа это
 *     `DeliveryTimestampTicks`, у сообщения — `TimestampTicks`;
 *   - признаки «брать нельзя»: тестовый документ помечается и у сообщения, и у
 *     документа, аннулирование — статусом, а не флагом.
 *
 * Номер и дата отсюда — только до разбора. После разбора итоговым источником
 * становится сам подписанный XML, а расхождение с метаданными показывается в
 * диагностике как ранний признак того, что парсер читает не те поля.
 */
import type { DiadocEntity, DiadocMessage } from './diadoc.types.js';
import { diadocTimestampToDate } from './diadoc.types.js';

/** Аннулирование завершено: запрос на аннулирование ещё не аннулирование. */
export const REVOCATION_ACCEPTED = 'RevocationAccepted';

export type EdoDocumentMeta = {
  number: string | null;
  date: string | null;
  /** Откуда взяты номер и дата: из коллекции Metadata или из устаревших полей. */
  numberSource: 'metadata' | 'legacy' | null;
  /** Итог по метаданным, если Диадок его сообщает, — только для показа. */
  totalSum: string | null;
  totalVat: string | null;
  receivedAt: Date | null;
  receivedAtSource: 'delivery' | 'message' | null;
  isTest: boolean;
  revocationStatus: string | null;
  revoked: boolean;
  senderSignatureStatus: string | null;
  isDeleted: boolean;
  /** Вся коллекция Metadata как есть — для диагностики. */
  metadata: Record<string, string>;
};

/**
 * Коллекция Metadata в виде словаря.
 *
 * По документации это массив `{Key, Value}`. На случай иной сериализации
 * принимается и плоский объект; всё прочее даёт пустой словарь, а не падение.
 */
export function metadataMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const { Key, Value } = item as { Key?: unknown; Value?: unknown };
      if (typeof Key === 'string' && Value !== undefined && Value !== null && typeof Value !== 'object') {
        out[Key] = String(Value);
      }
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null && typeof value !== 'object') out[key] = String(value);
    }
  }
  return out;
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeDocumentInfo(
  entity: DiadocEntity,
  message: Pick<DiadocMessage, 'IsTest' | 'IsDeleted' | 'TimestampTicks' | 'Timestamp'>,
): EdoDocumentMeta {
  const info = entity.DocumentInfo;
  const metadata = metadataMap(info?.Metadata);

  const metaNumber = nonEmpty(metadata.DocumentNumber);
  const metaDate = nonEmpty(metadata.DocumentDate);
  const legacyNumber = nonEmpty(info?.DocumentNumber);
  const legacyDate = nonEmpty(info?.DocumentDate);

  const delivered = diadocTimestampToDate(info?.DeliveryTimestampTicks);
  const sent =
    diadocTimestampToDate(message.TimestampTicks) ?? diadocTimestampToDate(message.Timestamp);

  const revocationStatus = nonEmpty(info?.RevocationStatus);

  return {
    number: metaNumber ?? legacyNumber,
    date: metaDate ?? legacyDate,
    numberSource: metaNumber || metaDate ? 'metadata' : legacyNumber || legacyDate ? 'legacy' : null,
    totalSum: nonEmpty(metadata.TotalSum) ?? nonEmpty(info?.TotalSum?.toString()),
    totalVat: nonEmpty(metadata.TotalVat),
    receivedAt: delivered ?? sent,
    receivedAtSource: delivered ? 'delivery' : sent ? 'message' : null,
    isTest: Boolean(message.IsTest) || Boolean(info?.IsTest),
    revocationStatus,
    revoked: revocationStatus === REVOCATION_ACCEPTED,
    senderSignatureStatus: nonEmpty(info?.SenderSignatureStatus),
    isDeleted: Boolean(info?.IsDeleted) || Boolean(message.IsDeleted),
    metadata,
  };
}

/**
 * Плоский список «путь → значение» для показа администратору.
 *
 * Содержимое (`Content`) не показывается: там лежит сам файл. Предел — чтобы
 * сообщение с десятком вложений не превратило отчёт в простыню.
 */
export function flattenForDisplay(value: unknown, limit = 150): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = [];
  const walk = (v: unknown, path: string) => {
    if (out.length >= limit || v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (typeof v === 'object') {
      for (const [key, child] of Object.entries(v)) {
        if (key === 'Content') continue;
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    out.push({ path, value: String(v) });
  };
  walk(value, '');
  return out;
}
