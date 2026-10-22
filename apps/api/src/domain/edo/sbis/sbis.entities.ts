/**
 * Вложения из ленты СБИС.
 *
 * Где лежат. Новые вложения приходят в `Документ.Событие[].Вложение[]`. Отбор
 * идёт по вложениям, а не по документам: у вложения своё `Направление`, и оно
 * не обязано совпадать с направлением пакета, поэтому фильтр «входящий
 * документ» мог бы потерять УПД. Направления здесь не фильтруются — проба
 * раскладывает их, а для сверки берёт только входящие вложения события
 * «Получение» (справка: входящий документ фиксируется по этому событию).
 *
 * Повторы. Одно и то же вложение приходит в нескольких событиях — это одна
 * запись. Новая редакция того же вложения — другая запись: у неё может быть
 * другое содержимое.
 */
import { partyOf, type SbisAttachment, type SbisDocument } from './sbis.types.js';

/** Типы вложений УПД в СБИС (регистр важен); `…Покуп` — титулы покупателя, не берём. */
export const SBIS_UPD_TYPES: ReadonlySet<string> = new Set(['УпдСчфДоп', 'УпдДоп']);

export const RECEIPT_EVENT = 'Получение';
export const INCOMING = 'Входящий';

export type SbisAttachmentRecord = {
  documentId: string;
  documentType: string | null;
  documentDirection: string | null;
  documentDeleted: boolean;
  documentNumber: string | null;
  documentDate: string | null;
  /** `Документ.Редакция[0].Идентификатор` — для `ПрочитатьДокумент` той же редакции. */
  documentRevisionId: string | null;
  counterparty: { inn: string | null; kpp: string | null; name: string | null };
  eventId: string | null;
  eventName: string | null;
  eventTime: string | null;
  /** null — у вложения нет идентификатора: такое не считается и не скачивается. */
  attachmentId: string | null;
  attachmentType: string | null;
  attachmentDirection: string | null;
  service: boolean;
  formatVersion: string | null;
  attachmentNumber: string | null;
  attachmentDate: string | null;
  attachmentRevision: { id: string | null; number: string | null; time: string | null };
  fileName: string | null;
  link: string | null;
  /** Когда получен ответ с этой ссылкой (ISO). Срок жизни ссылки считается не от события. */
  linkReceivedAt: string;
  /** Кандидат в УПД: тип УПД, не служебное, есть ссылка на файл. */
  isUpd: boolean;
};

const s = (v: string | undefined) => v?.trim() || null;

export function revisionOf(att: SbisAttachment): SbisAttachmentRecord['attachmentRevision'] {
  const raw = Array.isArray(att.Редакция) ? att.Редакция[0] : att.Редакция;
  if (!raw || typeof raw !== 'object') return { id: null, number: null, time: null };
  const r = raw as Record<string, unknown>;
  const pick = (k: string) => (r[k] == null ? null : String(r[k]).trim() || null);
  return { id: pick('Идентификатор'), number: pick('Номер'), time: pick('ДатаВремя') };
}

export function isUpdAttachment(att: SbisAttachment): boolean {
  return (
    SBIS_UPD_TYPES.has(att.Тип?.trim() ?? '') &&
    att.Служебный?.trim().toLowerCase() !== 'да' &&
    !!att.Файл?.Ссылка?.trim()
  );
}

/** Все вложения документа из его событий — по одной записи на появление. */
export function collectSbisAttachments(doc: SbisDocument, pageReceivedAt: Date): SbisAttachmentRecord[] {
  const out: SbisAttachmentRecord[] = [];
  const counterparty = partyOf(doc.Контрагент);
  for (const event of doc.Событие) {
    for (const att of event.Вложение) {
      out.push({
        documentId: s(doc.Идентификатор) ?? '',
        documentType: s(doc.Тип),
        documentDirection: s(doc.Направление),
        documentDeleted: doc.Удален?.trim().toLowerCase() === 'да',
        documentNumber: s(doc.Номер),
        documentDate: s(doc.Дата),
        documentRevisionId: s(doc.Редакция[0]?.Идентификатор),
        counterparty,
        eventId: s(event.Идентификатор),
        eventName: s(event.Название),
        eventTime: s(event.ДатаВремя),
        attachmentId: s(att.Идентификатор),
        attachmentType: s(att.Тип),
        attachmentDirection: s(att.Направление),
        service: att.Служебный?.trim().toLowerCase() === 'да',
        formatVersion: s(att.ВерсияФормата),
        attachmentNumber: s(att.Номер),
        attachmentDate: s(att.Дата),
        attachmentRevision: revisionOf(att),
        fileName: s(att.Файл?.Имя),
        link: s(att.Файл?.Ссылка),
        linkReceivedAt: pageReceivedAt.toISOString(),
        isUpd: isUpdAttachment(att),
      });
    }
  }
  return out;
}

export function attachmentKey(r: Pick<SbisAttachmentRecord, 'documentId' | 'attachmentId'>): string {
  return `${r.documentId}/${r.attachmentId ?? ''}`;
}

export function revisionKey(r: SbisAttachmentRecord): string {
  const rev = r.attachmentRevision;
  return `${attachmentKey(r)}#${rev.id ?? rev.number ?? rev.time ?? ''}`;
}

/** Входящее вложение события «Получение» — только такие идут в сверку. */
export function isIncomingReceipt(
  r: Pick<SbisAttachmentRecord, 'attachmentDirection' | 'eventName'>,
): boolean {
  return r.attachmentDirection === INCOMING && r.eventName === RECEIPT_EVENT;
}

/** Вложение (редакция) после склейки повторов из разных событий. */
export type SbisUniqueAttachment = SbisAttachmentRecord & {
  occurrences: number;
  eventNames: string[];
  /** Хоть одно появление — входящее в событии «Получение». */
  incomingReceipt: boolean;
};

/**
 * Склейка повторов по редакции вложения. Ссылка берётся из последнего появления:
 * она получена позже и проживёт дольше.
 */
export class SbisAttachmentSet {
  private readonly byRevision = new Map<string, SbisUniqueAttachment>();
  /** Повторные появления той же редакции вложения. */
  repeats = 0;
  /** Вложения без идентификатора — не учитываются. */
  withoutId = 0;

  add(records: readonly SbisAttachmentRecord[]): void {
    for (const r of records) {
      if (!r.attachmentId || !r.documentId) {
        this.withoutId += 1;
        continue;
      }
      const key = revisionKey(r);
      const existing = this.byRevision.get(key);
      if (!existing) {
        this.byRevision.set(key, {
          ...r,
          occurrences: 1,
          eventNames: r.eventName ? [r.eventName] : [],
          incomingReceipt: isIncomingReceipt(r),
        });
        continue;
      }
      this.repeats += 1;
      existing.occurrences += 1;
      if (r.eventName && !existing.eventNames.includes(r.eventName)) existing.eventNames.push(r.eventName);
      if (isIncomingReceipt(r)) {
        existing.incomingReceipt = true;
        existing.eventName = r.eventName;
        existing.eventId = r.eventId;
        existing.eventTime = r.eventTime;
      }
      if (r.link) {
        existing.link = r.link;
        existing.linkReceivedAt = r.linkReceivedAt;
        existing.isUpd = existing.isUpd || r.isUpd;
      }
    }
  }

  revisions(): SbisUniqueAttachment[] {
    return [...this.byRevision.values()];
  }

  /** Уникальные вложения без учёта редакций. */
  attachmentCount(filter: (r: SbisUniqueAttachment) => boolean = () => true): number {
    return new Set(this.revisions().filter(filter).map(attachmentKey)).size;
  }
}
