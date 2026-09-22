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
  diadocFetch,
  readBodyWithLimit,
  type DiadocEnvironment,
} from './diadoc.http.js';
import {
  DiadocBoxEventListSchema,
  DiadocEmployeeSchema,
  DiadocMessageSchema,
  DiadocOrganizationListSchema,
  dateToDiadocTicks,
  type DiadocBoxEvent,
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
    opts: { json?: boolean } = {},
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
    const parsed = DiadocOrganizationListSchema.parse(await res.json());
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
    return DiadocEmployeeSchema.parse(await res.json());
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
    const res = await this.request(url);
    const parsed = DiadocBoxEventListSchema.parse(await res.json());
    return { events: parsed.Events };
  }

  /** Метаданные сообщения со списком сущностей. */
  async getMessage(boxId: string, messageId: string): Promise<DiadocMessage> {
    const url = new URL('/V6/GetMessage', this.api);
    url.searchParams.set('boxId', boxId);
    url.searchParams.set('messageId', messageId);
    const res = await this.request(url);
    return DiadocMessageSchema.parse(await res.json());
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
  ): Promise<Buffer> {
    const url = new URL('/V4/GetEntityContent', this.api);
    url.searchParams.set('boxId', boxId);
    url.searchParams.set('messageId', messageId);
    url.searchParams.set('entityId', entityId);
    // Здесь ответ — сам файл документа, а не структура: просить JSON нечего.
    const res = await this.request(url, 'GET', { json: false });
    return readBodyWithLimit(res, maxBytes ?? loadEnv().EDO_XML_MAX_BYTES);
  }
}
