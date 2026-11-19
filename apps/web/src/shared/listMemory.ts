/**
 * Память списков: где человек оставил каждый раздел портала.
 *
 * Фильтры списков живут в адресе страницы, а меню, вкладки и кнопки «назад к
 * списку» вели на голый путь. Человек ставил период, объект и признак в
 * «Операциях», заходил в «Документы», возвращался через меню — и видел список
 * с нуля. Здесь запоминается последний адрес каждой страницы, и все переходы
 * «в раздел» строятся от него.
 *
 * Хранилище — sessionStorage: память живёт до закрытия вкладки браузера (F5 её
 * не стирает), у каждой вкладки своя. В localStorage её класть нельзя:
 * вчерашний период или «Без фото» утром тихо сужали бы список, и казалось бы,
 * что приёмок нет; две вкладки затирали бы память друг друга.
 *
 * Объект, подрядчик и поставщик — общие для всех разделов (stores/globalFilters):
 * восстановленный адрес получает их ПОСЛЕДНИЙ выбор, в том числе снятие.
 */
import { useAuthStore } from '../stores/auth';
import { useGlobalFiltersStore, type GlobalFilters } from '../stores/globalFilters';
import { toCsvIds } from './utils/csvIds';
import type { SearchParamsPatch } from './utils/searchParams';

const STORAGE_KEY = 'matcheck.list-memory.v1';

/** Разделы меню, чьи адреса запоминаются (вместе с вложенными путями). */
const SECTION_ROOTS = [
  '/operations',
  '/documents',
  '/materials',
  '/stats',
  '/references',
  '/admin',
] as const;

/**
 * Параметры открытой карточки приёмки/отгрузки. Пока они в адресе, он не
 * запоминается: переход на карточку извне (из Истории, колокольчика, заказа)
 * иначе затёр бы фильтры «Операций» адресом без них.
 */
const CARD_KEYS = ['delivery', 'shipment', 'new'] as const;

/** Всё, что относится к открытой карточке, — снимается при возврате к списку. */
const CARD_PARAM_KEYS = ['delivery', 'shipment', 'new', 'manual', 'upd', 'from'] as const;

/**
 * Параметры, у которых в «Операциях» своё значение на каждой вкладке
 * (Приёмка/Отгрузка × Ожидаемые/Принятые). Коды статусов и короткие id у
 * приёмок и отгрузок разные, назначение есть только у отгрузок, а номер
 * страницы относится к своему списку. Остальные фильтры — общие.
 */
export const OPERATIONS_TAB_KEYS = ['page', 'status', 'id', 'purpose'] as const;

/** Ключи общих фильтров в адресе страниц, которые их понимают. */
const GLOBAL_KEYS: Record<string, ReadonlyArray<readonly [keyof GlobalFilters, string]>> = {
  '/operations': [
    ['siteIds', 'site'],
    ['contractorIds', 'contractor'],
    ['supplierIds', 'supplier'],
  ],
  '/documents': [
    ['siteIds', 'site'],
    ['contractorIds', 'contractor'],
    ['supplierIds', 'supplier'],
  ],
  // В Истории поступлений поля «Поставщик» нет.
  '/materials': [
    ['siteIds', 'site'],
    ['contractorIds', 'contractor'],
  ],
};

type OperationType = 'delivery' | 'shipment';
type OperationsTab = 'expected' | 'accepted';

type Memory = {
  userId: string;
  /** pathname → query-строка без «?». */
  byPath: Record<string, string>;
  /** Корень раздела → последний адрес внутри него (pathname + query). */
  lastInSection: Record<string, string>;
  /** «delivery:accepted» → параметры этой вкладки (OPERATIONS_TAB_KEYS). */
  opsTabs: Record<string, string>;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function storage(): StorageLike | null {
  // Сам доступ к sessionStorage бросает SecurityError при заблокированных
  // данных сайта — тогда память просто выключена, переходы работают как раньше.
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function currentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

function emptyMemory(userId: string): Memory {
  return { userId, byPath: {}, lastInSection: {}, opsTabs: {} };
}

function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Память текущего пользователя. Чужая (другой человек вошёл в ту же вкладку)
 * не используется: его фильтры не должны достаться следующему.
 */
function load(userId: string): Memory {
  const empty = emptyMemory(userId);
  const s = storage();
  if (!s) return empty;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<Memory> | null;
    if (!parsed || parsed.userId !== userId) return empty;
    const lastInSection: Record<string, string> = {};
    for (const [root, url] of Object.entries(stringRecord(parsed.lastInSection))) {
      // Адрес обязан лежать внутри своего раздела: в navigate не должно уйти
      // ничего, кроме пути портала.
      if (sectionRootOf(url.split('?')[0] ?? '') === root) lastInSection[root] = url;
    }
    return {
      userId,
      byPath: stringRecord(parsed.byPath),
      lastInSection,
      opsTabs: stringRecord(parsed.opsTabs),
    };
  } catch {
    return empty;
  }
}

function save(memory: Memory): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Переполнение или приватный режим — память не обязательна.
  }
}

function loadCurrent(): Memory | null {
  const userId = currentUserId();
  return userId ? load(userId) : null;
}

function sectionRootOf(pathname: string): string | null {
  return SECTION_ROOTS.find((r) => pathname === r || pathname.startsWith(`${r}/`)) ?? null;
}

function buildUrl(pathname: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function operationsTabKey(params: URLSearchParams): string {
  const type: OperationType = params.get('type') === 'shipment' ? 'shipment' : 'delivery';
  const tab: OperationsTab = params.get('tab') === 'accepted' ? 'accepted' : 'expected';
  return `${type}:${tab}`;
}

/**
 * Запоминает адрес страницы. Вызывается на каждую смену адреса (см.
 * useListMemoryRecorder) — страницам о памяти знать не нужно.
 */
export function recordListUrl(pathname: string, search: string): void {
  const root = sectionRootOf(pathname);
  if (!root) return;
  const userId = currentUserId();
  if (!userId) return;
  const params = new URLSearchParams(search);
  if (CARD_KEYS.some((k) => params.has(k))) return;

  const memory = load(userId);
  memory.byPath[pathname] = params.toString();
  memory.lastInSection[root] = buildUrl(pathname, params);
  if (pathname === '/operations') {
    const tabParams = new URLSearchParams();
    for (const key of OPERATIONS_TAB_KEYS) {
      for (const value of params.getAll(key)) tabParams.append(key, value);
    }
    memory.opsTabs[operationsTabKey(params)] = tabParams.toString();
  }
  save(memory);
}

/**
 * Подставляет общие фильтры (объект/подрядчик/поставщик) последнего выбора.
 * Если значение поменялось, снимается и страница: она относилась к другой
 * выдаче.
 */
function applyGlobalFilters(pathname: string, params: URLSearchParams): void {
  const keys = GLOBAL_KEYS[pathname];
  if (!keys) return;
  const globals = useGlobalFiltersStore.getState();
  let changed = false;
  for (const [field, key] of keys) {
    const next = toCsvIds(globals[field]);
    if ((params.get(key) ?? null) === next) continue;
    changed = true;
    if (next) params.set(key, next);
    else params.delete(key);
  }
  if (changed) params.delete('page');
}

function withGlobalFilters(url: string): string {
  const [pathname = url, search = ''] = url.split('?');
  const params = new URLSearchParams(search);
  applyGlobalFilters(pathname, params);
  return buildUrl(pathname, params);
}

/**
 * Куда вести пунктом меню: последнее место внутри раздела вместе с фильтрами.
 * Без памяти — `fallback` (по умолчанию сам корень раздела).
 */
export function sectionUrl(root: string, fallback: string = root): string {
  const memory = loadCurrent();
  return withGlobalFilters(memory?.lastInSection[root] ?? fallback);
}

/**
 * Адрес конкретной страницы с её запомненными фильтрами — для вкладок и кнопок
 * «назад к списку». `patch` правит параметры поверх (undefined — не трогать,
 * null/'' — снять); если он что-то поменял, страница снимается.
 */
export function pageUrl(pathname: string, patch?: SearchParamsPatch): string {
  const memory = loadCurrent();
  const params = new URLSearchParams(memory?.byPath[pathname] ?? '');
  if (patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const next = value || null;
      if ((params.get(key) ?? null) === next) continue;
      changed = true;
      if (next) params.set(key, next);
      else params.delete(key);
    }
    if (changed) params.delete('page');
  }
  applyGlobalFilters(pathname, params);
  return buildUrl(pathname, params);
}

/**
 * Параметры вкладки «Операций» (OPERATIONS_TAB_KEYS) заменяются запомненными
 * для целевой вкладки. Без памяти они просто снимаются — как и раньше при
 * переключении вкладок.
 */
export function applyOperationsTabMemory(
  params: URLSearchParams,
  target: { type: OperationType; tab: OperationsTab },
): void {
  for (const key of OPERATIONS_TAB_KEYS) params.delete(key);
  const saved = loadCurrent()?.opsTabs[`${target.type}:${target.tab}`];
  if (!saved) return;
  const restored = new URLSearchParams(saved);
  for (const key of OPERATIONS_TAB_KEYS) {
    for (const value of restored.getAll(key)) params.append(key, value);
  }
}

/**
 * Ссылка на карточку приёмки/отгрузки из другого раздела. Под карточкой —
 * запомненный список «Операций», поэтому после закрытия человек видит свои
 * фильтры, а не голый список.
 */
export function operationCardUrl(type: OperationType, id: string, from?: string): string {
  const memory = loadCurrent();
  const params = new URLSearchParams(memory?.byPath['/operations'] ?? '');
  for (const key of CARD_PARAM_KEYS) params.delete(key);
  const rememberedType: OperationType = params.get('type') === 'shipment' ? 'shipment' : 'delivery';
  if (rememberedType !== type) {
    const tab: OperationsTab = params.get('tab') === 'accepted' ? 'accepted' : 'expected';
    applyOperationsTabMemory(params, { type, tab });
  }
  params.set('type', type);
  applyGlobalFilters('/operations', params);
  params.set(type, id);
  if (from) params.set('from', from);
  return buildUrl('/operations', params);
}
