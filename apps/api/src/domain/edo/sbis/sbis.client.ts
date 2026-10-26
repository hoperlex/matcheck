/**
 * Клиент API СБИС: только чтение.
 *
 * Тонкая обёртка над `sbisRpc`/`sbisFetch`: собирает параметры методов по
 * справке и проверяет ответы терпимыми схемами. Решения (сколько листать, когда
 * лента кончилась, что делать с 403) принимает вызывающий — здесь их нет.
 */
import type { SbisSession } from './sbis.auth.js';
import {
  readSbisBody,
  sbisFetch,
  sbisRpc,
  type SbisTransportOptions,
} from './sbis.http.js';
import {
  SbisChangesSchema,
  SbisDocumentSchema,
  SbisOrgListSchema,
  formatSbisDateTime,
  isYes,
  type SbisDocument,
  type SbisOrg,
} from './sbis.types.js';

/** Организация для фильтра ленты: справка требует её на каждой странице с курсором. */
export type SbisOrgRef = {
  kind: 'legal' | 'person';
  inn: string;
  kpp: string | null;
  branch: string | null;
  name: string | null;
};

export function orgRefOf(org: SbisOrg): SbisOrgRef | null {
  if (org.СвЮЛ?.ИНН?.trim()) {
    return {
      kind: 'legal',
      inn: org.СвЮЛ.ИНН.trim(),
      kpp: org.СвЮЛ.КПП?.trim() || null,
      branch: org.СвЮЛ.КодФилиала?.trim() || null,
      name: org.СвЮЛ.Название?.trim() || null,
    };
  }
  if (org.СвФЛ?.ИНН?.trim()) {
    const fio = [org.СвФЛ.Фамилия, org.СвФЛ.Имя, org.СвФЛ.Отчество].filter(Boolean).join(' ');
    return {
      kind: 'person',
      inn: org.СвФЛ.ИНН.trim(),
      kpp: null,
      branch: org.СвФЛ.КодФилиала?.trim() || null,
      name: fio || null,
    };
  }
  return null;
}

export function orgLabel(ref: SbisOrgRef): string {
  return [ref.inn, ref.kpp, ref.branch].filter(Boolean).join('/');
}

export function orgFilter(ref: SbisOrgRef): Record<string, unknown> {
  if (ref.kind === 'person') {
    return { СвФЛ: { ИНН: ref.inn, ...(ref.branch ? { КодФилиала: ref.branch } : {}) } };
  }
  return {
    СвЮЛ: {
      ИНН: ref.inn,
      ...(ref.kpp ? { КПП: ref.kpp } : {}),
      ...(ref.branch ? { КодФилиала: ref.branch } : {}),
    },
  };
}

/**
 * Курсор ленты. `eventTime` — строка СБИС как пришла: пересчёт через Date
 * потерял бы доли секунды, а по ним СБИС находит место в ленте.
 * Без `eventId` — восстановление после ошибки курсора: только время.
 */
export type SbisCursor = {
  eventId: string | null;
  eventTime: string;
  documentId: string | null;
  revisionId: string | null;
};

export type SbisChangesPage = {
  documents: SbisDocument[];
  /** `Навигация.ЕстьЕще`: null — поля нет в ответе. */
  hasMore: boolean | null;
  /** Когда получен ответ — от этого момента живут ссылки на файлы. */
  receivedAt: Date;
};

export type SbisOrgList = {
  orgs: SbisOrg[];
  complete: boolean;
  pages: number;
  stopReason: 'end' | 'page_cap' | 'repeated_page';
};

export type SbisClient = {
  listOurOrganizations(opts?: { pageCap?: number; pageSize?: number }): Promise<SbisOrgList>;
  listChanges(q: {
    org: SbisOrgRef;
    since: Date;
    until: Date;
    cursor: SbisCursor | null;
    pageSize?: number;
  }): Promise<SbisChangesPage>;
  readDocument(q: { documentId: string; revisionId?: string | null }): Promise<SbisDocument>;
  /**
   * Вся лента одного документа — для частичного ответа `ПрочитатьДокумент`.
   * Проверено живым запросом 22.10: параметр — `Фильтр.ДопПоля`, вместе с
   * `Фильтр.ИдентификаторДокумента`; без реквизитов документа СБИС отвечает 1FA.
   */
  listDocumentChanges(q: { org: SbisOrgRef; documentId: string; since: Date; until: Date }): Promise<SbisDocument[]>;
  downloadFile(link: string, maxBytes: number): Promise<{ bytes: Buffer; zip: boolean }>;
};

export type SbisClientDeps = {
  session: SbisSession;
  transport?: Omit<SbisTransportOptions, 'secrets'>;
  now?: () => Date;
  /** Счётчик запросов для отчёта. */
  onRequest?: (what: string) => void;
};

/** Сигнатура zip: локальный заголовок файла или пустой архив. */
export function looksLikeZip(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

function orgKey(org: SbisOrg): string {
  return JSON.stringify([org.СвЮЛ?.ИНН, org.СвЮЛ?.КПП, org.СвЮЛ?.КодФилиала, org.СвФЛ?.ИНН]);
}

export function createSbisClient(deps: SbisClientDeps): SbisClient {
  const { session } = deps;
  const now = deps.now ?? (() => new Date());
  const transport = { ...deps.transport, secrets: session.secrets };

  const rpc = async (rpcMethod: string, params: unknown) => {
    deps.onRequest?.(rpcMethod);
    return sbisRpc({ ...transport, rpcMethod, params, headers: session.headers });
  };

  return {
    async listOurOrganizations({ pageCap = 50, pageSize = 200 } = {}) {
      const orgs: SbisOrg[] = [];
      const seen = new Set<string>();
      let previous: string | null = null;
      for (let page = 0; page < pageCap; page++) {
        const result = SbisOrgListSchema.parse(
          await rpc('СБИС.СписокНашихОрганизаций', {
            Фильтр: { Навигация: { Страница: String(page), РазмерСтраницы: String(pageSize) } },
          }),
        );
        const keys = result.НашаОрганизация.map(orgKey);
        const signature = keys.join('|');
        // Навигацию проигнорировали — та же страница пришла снова. Листать дальше
        // бессмысленно, а список при этом неполный.
        if (page > 0 && signature && signature === previous) {
          return { orgs, complete: false, pages: page + 1, stopReason: 'repeated_page' };
        }
        previous = signature;
        result.НашаОрганизация.forEach((org, i) => {
          if (seen.has(keys[i]!)) return;
          seen.add(keys[i]!);
          orgs.push(org);
        });
        if (!isYes(result.Навигация?.ЕстьЕще)) {
          return { orgs, complete: true, pages: page + 1, stopReason: 'end' };
        }
      }
      return { orgs, complete: false, pages: pageCap, stopReason: 'page_cap' };
    },

    async listChanges({ org, since, until, cursor, pageSize = 50 }) {
      const filter: Record<string, unknown> = {
        ДатаВремяС: cursor?.eventTime ?? formatSbisDateTime(since),
        ДатаВремяПо: formatSbisDateTime(until),
        НашаОрганизация: orgFilter(org),
        ПолныйСертификатЭП: 'Нет',
        Навигация: { РазмерСтраницы: String(Math.min(Math.max(pageSize, 1), 50)) },
      };
      if (cursor?.eventId) {
        filter.ИдентификаторСобытия = cursor.eventId;
        if (cursor.documentId) filter.ИдентификаторДокумента = cursor.documentId;
        if (cursor.revisionId) filter.ИдентификаторРедакции = cursor.revisionId;
      }
      const raw = await rpc('СБИС.СписокИзменений', { Фильтр: filter });
      const receivedAt = now();
      const result = SbisChangesSchema.parse(raw ?? {});
      const flag = result.Навигация?.ЕстьЕще;
      return {
        documents: result.Документ,
        hasMore: flag == null ? null : isYes(flag),
        receivedAt,
      };
    },

    async listDocumentChanges({ org, documentId, since, until }) {
      const raw = await rpc('СБИС.СписокИзменений', {
        Фильтр: {
          ДатаВремяС: formatSbisDateTime(since),
          ДатаВремяПо: formatSbisDateTime(until),
          ИдентификаторДокумента: documentId,
          НашаОрганизация: orgFilter(org),
          ДопПоля: 'СписокПоДокументу',
          ПолныйСертификатЭП: 'Нет',
          Навигация: { РазмерСтраницы: '50' },
        },
      });
      return SbisChangesSchema.parse(raw ?? {}).Документ.filter((d) => d.Идентификатор === documentId);
    },

    async readDocument({ documentId, revisionId }) {
      const document: Record<string, unknown> = { Идентификатор: documentId };
      if (revisionId) document.Редакция = { Идентификатор: revisionId };
      return SbisDocumentSchema.parse((await rpc('СБИС.ПрочитатьДокумент', { Документ: document })) ?? {});
    },

    async downloadFile(link, maxBytes) {
      const url = new URL(link);
      deps.onRequest?.('file');
      const res = await sbisFetch({ ...transport, method: 'GET', url, headers: session.headers });
      const bytes = await readSbisBody(res, maxBytes, url);
      return { bytes, zip: looksLikeZip(bytes) };
    },
  };
}
