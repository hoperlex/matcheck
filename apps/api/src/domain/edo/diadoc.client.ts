/**
 * Клиент API Диадока: только чтение.
 *
 * Все запросы идут через diadocFetch, а значит через разрешающий список путей —
 * добавить сюда метод, который что-то отправляет или подписывает, недостаточно,
 * чтобы он заработал. Это сознательная двойная защита: обещание «read-only»
 * держится механизмом, а не дисциплиной.
 */
import { loadEnv } from '../../lib/env.js';
import type { DiadocAuth } from './diadoc.auth.js';
import {
  DIADOC_ENDPOINTS,
  DiadocAuthExpired,
  DiadocGone,
  diadocFetch,
  parseRetryAfterMs,
  readBodyWithLimit,
  readJson,
  type DiadocEnvironment,
} from './diadoc.http.js';
import {
  DiadocBoxEventListSchema,
  DiadocDocumentListSchema,
  DiadocEmployeeSchema,
  DiadocMessageSchema,
  DiadocOrganizationListSchema,
  DiadocOrganizationSchema,
  dateToDiadocTicks,
  type DiadocBoxEvent,
  type DiadocDocumentList,
  type DiadocEmployee,
  type DiadocMessage,
} from './diadoc.types.js';

const LIST_TIMEOUT_MS = 60_000;
const CONTENT_TIMEOUT_MS = 60_000;

export type DiadocBoxSummary = {
  boxId: string;
  title: string;
  inn: string | null;
  kpp: string | null;
};

export type GetNewEventsParams = {
  boxId: string;
  /** Курсор ленты. Именно IndexKey: afterEventId в V8 устарел. */
  afterIndexKey?: string | null;
  /**
   * Отсечка первичной загрузки. Передаётся в САМ запрос, чтобы не перебирать
   * историю ящика: на давно живущем ящике это десятки тысяч лишних событий.
   */
  fromTimestamp?: Date | null;
  signal?: AbortSignal;
};

export type GetDocumentsParams = {
  boxId: string;
  /** `<Тип>.<Класс><Статус>`, например `UniversalTransferDocument.Inbound`. */
  filterCategory: string;
  /** Границы по времени в тиках .NET, ОБЕ включительные. */
  fromTicks?: bigint | null;
  toTicks?: bigint | null;
  afterIndexKey?: string | null;
  /** Размер страницы, 0–100. */
  count?: number;
  sortDirection?: 'Ascending' | 'Descending';
  signal?: AbortSignal;
};

/** Общие параметры запроса: сигнал отмены всей операции. */
export type RequestOptions = { signal?: AbortSignal };

/**
 * Тип документа по справочнику Диадока.
 *
 * `isFormal` — машиночитаем ли первый титул (титул продавца) у данной версии.
 * `null` — справочник об этом не сообщил.
 */
export type DiadocDocumentTypeInfo = {
  name: string;
  title: string | null;
  versions: { fn: string | null; version: string; isFormal: boolean | null }[];
};

export type DiadocClientDeps = {
  auth: DiadocAuth;
  environment: DiadocEnvironment;
  fetchImpl?: typeof fetch;
};

export class DiadocClient {
  constructor(private readonly deps: DiadocClientDeps) {}

  private get api(): string {
    return DIADOC_ENDPOINTS[this.deps.environment].api;
  }

  /**
   * Выполняет запрос, один раз переавторизуясь на 401.
   *
   * Второй 401 подряд означает, что дело не в протухшем токене, — повторять
   * бессмысленно, нужен человек.
   *
   * `Accept: application/json` обязателен и не является вкусовщиной: по
   * умолчанию Диадок сериализует ответы в Protocol Buffers, и без этого
   * заголовка приходят бинарные данные. Первая боевая проба 22.09.2026 упала
   * именно здесь — разбор JSON не удавался на всех методах сразу, а выглядело
   * это как «проверка доступа не удалась».
   *
   * Исключение — содержимое документа: там бинарность законна, и заголовок
   * запрашивается отдельно (см. getEntityContent).
   */
  private async request(
    url: URL,
    method: 'GET' | 'POST' = 'GET',
    opts: { json?: boolean; signal?: AbortSignal; acceptStatuses?: readonly number[] } = {},
  ): Promise<Response> {
    const wantJson = opts.json !== false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const header = await this.deps.auth.header();
      try {
        return await diadocFetch({
          method,
          url,
          headers: {
            Authorization: header,
            ...(wantJson ? { Accept: 'application/json' } : {}),
          },
          timeoutMs: method === 'GET' ? LIST_TIMEOUT_MS : CONTENT_TIMEOUT_MS,
          fetchImpl: this.deps.fetchImpl,
          signal: opts.signal,
          acceptStatuses: opts.acceptStatuses,
        });
      } catch (err) {
        if (err instanceof DiadocAuthExpired && attempt === 0) {
          this.deps.auth.invalidate();
          continue;
        }
        throw err;
      }
    }
    throw new DiadocAuthExpired('повторная авторизация не помогла');
  }

  /**
   * Организации и ящики учётной записи.
   *
   * autoRegister=false обязателен. По умолчанию метод РЕГИСТРИРУЕТ пользователя
   * в организации, если в ящике нет действующего администратора, — то есть
   * молча меняет состояние на стороне Диадока. Для интеграции, которая обещает
   * только читать, это недопустимо.
   */
  async getMyOrganizations(): Promise<DiadocBoxSummary[]> {
    const url = new URL('/GetMyOrganizations', this.api);
    url.searchParams.set('autoRegister', 'false');
    const res = await this.request(url);
    const parsed = DiadocOrganizationListSchema.parse(await readJson(res, url));
    return parsed.Organizations.flatMap((org) =>
      org.Boxes.map((box) => ({
        boxId: box.BoxId,
        title: box.Title ?? org.ShortName ?? org.FullName ?? '',
        inn: org.Inn ?? null,
        kpp: org.Kpp ?? null,
      })),
    );
  }

  /**
   * Права сотрудника в ящике.
   *
   * Проверяем не формальности ради: без полного доступа к документам
   * GetNewEvents требует указания подразделения, а GetMessage может ответить
   * 403, если в сообщении есть хоть один недоступный документ. Такую учётную
   * запись лучше отвергнуть сразу с внятным текстом, чем ловить 403 в проходе.
   */
  async getMyEmployee(boxId: string): Promise<DiadocEmployee> {
    const url = new URL('/GetMyEmployee', this.api);
    url.searchParams.set('boxId', boxId);
    const res = await this.request(url);
    return DiadocEmployeeSchema.parse(await readJson(res, url));
  }

  /**
   * Страница ленты событий.
   *
   * Набор фильтров при пагинации МЕНЯТЬ НЕЛЬЗЯ: курсор действителен только для
   * того же запроса. Поэтому отсечка по времени и направление передаются на
   * каждой странице одинаково.
   */
  async getNewEvents(params: GetNewEventsParams): Promise<{ events: DiadocBoxEvent[] }> {
    const url = new URL('/V8/GetNewEvents', this.api);
    url.searchParams.set('boxId', params.boxId);
    url.searchParams.set('documentDirection', 'Inbound');
    url.searchParams.set('orderBy', 'Ascending');
    if (params.afterIndexKey) url.searchParams.set('afterIndexKey', params.afterIndexKey);
    if (params.fromTimestamp) {
      url.searchParams.set('timestampFromTicks', dateToDiadocTicks(params.fromTimestamp));
    }
    const res = await this.request(url, 'GET', { signal: params.signal });
    const parsed = DiadocBoxEventListSchema.parse(await readJson(res, url));
    return { events: parsed.Events };
  }

  /**
   * Страница списка документов (V3).
   *
   * Как и у ленты, набор фильтров между страницами менять нельзя: ключ
   * `afterIndexKey` действителен только для того же запроса. Ключ кодирует
   * URLSearchParams — документация требует передавать его закодированным.
   */
  async getDocuments(params: GetDocumentsParams): Promise<DiadocDocumentList> {
    const url = new URL('/V3/GetDocuments', this.api);
    url.searchParams.set('boxId', params.boxId);
    url.searchParams.set('filterCategory', params.filterCategory);
    if (params.fromTicks !== undefined && params.fromTicks !== null) {
      url.searchParams.set('timestampFromTicks', params.fromTicks.toString());
    }
    if (params.toTicks !== undefined && params.toTicks !== null) {
      url.searchParams.set('timestampToTicks', params.toTicks.toString());
    }
    if (params.sortDirection) url.searchParams.set('sortDirection', params.sortDirection);
    if (params.afterIndexKey) url.searchParams.set('afterIndexKey', params.afterIndexKey);
    url.searchParams.set('count', String(params.count ?? 100));
    const res = await this.request(url, 'GET', { signal: params.signal });
    return DiadocDocumentListSchema.parse(await readJson(res, url));
  }

  /**
   * Справочник типов документов ящика.
   *
   * Нужен, чтобы «машиночитаемый» в осмотре определял Диадок, а не наша
   * догадка: прежде машиночитаемым считался только УПД, и счёт-фактура в XML
   * показывалась как «скан или PDF». Разбор намеренно терпимый — справочник
   * вспомогательный, и его незнакомая форма не должна ронять осмотр.
   */
  async getDocumentTypes(boxId: string, opts: RequestOptions = {}): Promise<DiadocDocumentTypeInfo[]> {
    const url = new URL('/V2/GetDocumentTypes', this.api);
    url.searchParams.set('boxId', boxId);
    const res = await this.request(url, 'GET', { signal: opts.signal });
    return parseDocumentTypes(await readJson(res, url));
  }

  /** Метаданные сообщения со списком сущностей. */
  async getMessage(boxId: string, messageId: string): Promise<DiadocMessage> {
    const url = new URL('/V6/GetMessage', this.api);
    url.searchParams.set('boxId', boxId);
    url.searchParams.set('messageId', messageId);
    const res = await this.request(url);
    return DiadocMessageSchema.parse(await readJson(res, url));
  }

  /**
   * Содержимое сущности.
   *
   * Предел размера применяется потоково: к моменту проверки «после скачивания»
   * память уже израсходована, то есть защита срабатывала бы после ущерба.
   */
  async getEntityContent(
    boxId: string,
    messageId: string,
    entityId: string,
    maxBytes?: number,
    opts: RequestOptions = {},
  ): Promise<Buffer> {
    const url = new URL('/V4/GetEntityContent', this.api);
    url.searchParams.set('boxId', boxId);
    url.searchParams.set('messageId', messageId);
    url.searchParams.set('entityId', entityId);
    // Здесь ответ — сам файл документа, а не структура: просить JSON нечего.
    const res = await this.request(url, 'GET', { json: false, signal: opts.signal });
    return readBodyWithLimit(res, maxBytes ?? loadEnv().EDO_XML_MAX_BYTES, url);
  }

  /**
   * Реквизиты организации по ящику: ИНН, КПП, название. Ящик не найден — `null`
   * (Диадок отвечает 404, это не сбой).
   */
  async getOrganization(boxId: string, opts: RequestOptions = {}): Promise<DiadocOrganizationInfo | null> {
    const url = new URL('/GetOrganization', this.api);
    url.searchParams.set('boxId', boxId);
    let res: Response;
    try {
      res = await this.request(url, 'GET', { signal: opts.signal });
    } catch (err) {
      if (err instanceof DiadocGone) return null;
      throw err;
    }
    const org = DiadocOrganizationSchema.parse(await readJson(res, url));
    return {
      inn: org.Inn?.trim() || null,
      kpp: org.Kpp?.trim() || null,
      name: org.ShortName?.trim() || org.FullName?.trim() || null,
    };
  }

  /**
   * Печатная форма документа (PDF).
   *
   * Форма собирается асинхронно: пока она не готова, Диадок отвечает 200 с
   * пустым телом и заголовком `Retry-After` — тогда `retry`, повторять решает
   * вызывающий. 409 — Диадок не формирует форму для этого документа
   * (`unavailable` с текстом ответа): это свойство документа, а не сбой.
   */
  async generatePrintForm(
    boxId: string,
    messageId: string,
    documentId: string,
    maxBytes: number,
    opts: RequestOptions = {},
  ): Promise<DiadocPrintFormResult> {
    const url = new URL('/GeneratePrintForm', this.api);
    url.searchParams.set('boxId', boxId);
    url.searchParams.set('messageId', messageId);
    url.searchParams.set('documentId', documentId);
    const res = await this.request(url, 'GET', { json: false, signal: opts.signal, acceptStatuses: [409] });
    if (res.status === 409) {
      const text = (await readBodyWithLimit(res, PRINT_FORM_ERROR_MAX_BYTES, url)).toString('utf-8');
      return { state: 'unavailable', status: 409, text: text.trim().slice(0, 500) };
    }
    const retryAfter = res.headers.get('Retry-After');
    const body = await readBodyWithLimit(res, maxBytes, url);
    if (body.length === 0) return { state: 'retry', afterMs: parseRetryAfterMs(retryAfter) };
    return { state: 'ready', pdf: body };
  }
}

/** Текст отказа печатной формы — для описи; больше не нужно. */
const PRINT_FORM_ERROR_MAX_BYTES = 64 * 1024;

export type DiadocOrganizationInfo = { inn: string | null; kpp: string | null; name: string | null };

export type DiadocPrintFormResult =
  | { state: 'ready'; pdf: Buffer }
  | { state: 'retry'; afterMs: number }
  | { state: 'unavailable'; status: 409; text: string };

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

/** Разбор ответа GetDocumentTypes: берём только то, что понимаем. */
export function parseDocumentTypes(raw: unknown): DiadocDocumentTypeInfo[] {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return asArray(root.DocumentTypes).flatMap((type) => {
    const name = str(type.Name);
    if (!name) return [];
    const versions = asArray(type.Functions).flatMap((fn) =>
      asArray(fn.Versions).flatMap((v) => {
        const version = str(v.Version);
        if (!version) return [];
        const titles = asArray(v.Titles);
        const first = titles.find((t) => t.Index === 0) ?? titles[0];
        const isFormal = typeof first?.IsFormal === 'boolean' ? first.IsFormal : null;
        return [{ fn: str(fn.Name), version, isFormal }];
      }),
    );
    return [{ name, title: str(type.Title), versions }];
  });
}
