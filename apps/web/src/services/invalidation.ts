import type { QueryClient } from '@tanstack/react-query';

const CHANNEL_NAME = 'matcheck-invalidation';

// Окно throttle для SSE-инвалидации: при шторме событий (несколько
// менеджеров активно правят приёмки/отгрузки) бэк рассылает пачку
// `delivery_updated` подряд. Раньше каждое событие сразу дёргало 4
// invalidateQueries по prefix-keys, и под каждой висели DTO открытой
// приёмки, список, source-documents, reports — итог: 20–40 параллельных
// API-запросов забивали HTTP/1.1-pool Chrome, и фото с Cloud.ru S3
// зависали в очереди до таймаута (ERR_CONNECTION_RESET).
// Решение: коалесцируем ключи в Set и сбрасываем единым пакетом раз в
// 500 мс. Финальное состояние UI идентично — react-query всё равно
// дёрнет refetch с актуальным сервером, просто реже.
const DEBOUNCE_MS = 500;

// Волна 0B: узкая инвалидация reports по сущности. Отчёты в
// apps/api/src/routes/reports.ts читают разные таблицы:
//  - /reports/intake   — только deliveries;
//  - /reports/shipment — только shipments;
//  - operations-counters / inspector-stats / stats-summary — обе.
// Поэтому событие приёмки инвалидирует всё, КРОМЕ журнала отгрузок, и
// наоборот. Материалы/Статистика/счётчики остаются свежими (их ключи,
// зависящие от изменённой сущности, инвалидируются). Префикс из 2
// элементов накрывает реальные ключи с 3-м элементом (userId/фильтры).
const DELIVERY_REPORTS: string[][] = [
  ['reports', 'operations-counters'],
  ['reports', 'intake'],
  ['reports', 'inspector-stats'],
  ['reports', 'stats-summary'],
];
const SHIPMENT_REPORTS: string[][] = [
  ['reports', 'operations-counters'],
  ['reports', 'shipment'],
  ['reports', 'inspector-stats'],
  ['reports', 'stats-summary'],
];

// Ключи для fallback-рефетча, когда SSE молча оборвался (см. ниже).
const FALLBACK_KEYS: string[][] = [
  ['deliveries'],
  ['shipments'],
  ['source-documents'],
  ['reports'],
];

const RECONNECT_MIN_MS = 5000;
const RECONNECT_MAX_MS = 30000;

let bc: BroadcastChannel | null = null;
let sse: EventSource | null = null;

export function setupInvalidation(qc: QueryClient): () => void {
  if (typeof window === 'undefined') return () => undefined;

  try {
    bc = new BroadcastChannel(CHANNEL_NAME);
    bc.onmessage = (evt) => {
      if (evt.data?.type === 'invalidate') {
        qc.invalidateQueries({ queryKey: evt.data.key }).catch(() => undefined);
      }
    };
  } catch {
    /* BroadcastChannel not supported */
  }

  // Set хранит JSON-сериализованные ключи, чтобы дедуплицировать
  // одинаковые приходящие пачкой события (10 delivery_updated подряд
  // → 1 invalidate ['deliveries']).
  const pending = new Set<string>();
  let timer: number | null = null;

  // Здоровье SSE + backoff переподключения. sseConnected гейтит
  // fallback-рефетч (при живом SSE лишняя периодика не нужна). Таймер
  // reconnect хранится, чтобы отменить его при teardown/logout — иначе
  // отложенный connectSse оживил бы поток после выхода.
  let sseConnected = false;
  let reconnectTimer: number | null = null;
  let reconnectDelay = RECONNECT_MIN_MS;

  function flush() {
    timer = null;
    const keys = Array.from(pending, (s) => JSON.parse(s) as string[]);
    pending.clear();
    for (const key of keys) {
      qc.invalidateQueries({ queryKey: key }).catch(() => undefined);
      bc?.postMessage({ type: 'invalidate', key });
    }
  }

  function schedule(keys: string[][]) {
    for (const key of keys) pending.add(JSON.stringify(key));
    // Leading + trailing batch: таймер запускается единожды на пачку и
    // не сдвигается последующими событиями — иначе непрерывный поток
    // мог бы откладывать invalidate бесконечно.
    if (timer === null) {
      timer = window.setTimeout(flush, DEBOUNCE_MS);
    }
  }

  function connectSse() {
    if (sse) sse.close();
    sse = new EventSource('/api/v1/events', { withCredentials: true });
    sse.onopen = () => {
      sseConnected = true;
      reconnectDelay = RECONNECT_MIN_MS;
    };
    sse.addEventListener('delivery_updated', (evt) => {
      handle('delivery_updated', evt);
    });
    sse.addEventListener('delivery_deleted', (evt) => {
      handle('delivery_deleted', evt);
    });
    sse.addEventListener('shipment_updated', (evt) => {
      handle('shipment_updated', evt);
    });
    sse.addEventListener('shipment_deleted', (evt) => {
      handle('shipment_deleted', evt);
    });
    sse.addEventListener('source_document_updated', (evt) => {
      handle('source_document_updated', evt);
    });
    sse.onerror = () => {
      sseConnected = false;
      sse?.close();
      sse = null;
      // Экспоненциальный backoff вместо фиксированных 5с — не долбим
      // /events при длительном обрыве (в т.ч. 403 у ролей без доступа).
      if (reconnectTimer === null) {
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          connectSse();
        }, delay);
      }
    };
  }

  function handle(type: string, evt: MessageEvent) {
    let keys: string[][] = [];
    if (type === 'delivery_updated' || type === 'delivery_deleted') {
      // source-documents: вкладка «Ожидаемые» зависит от привязок в
      // delivery_sources — после создания/удаления приёмки список
      // ожидаемых УПД должен перечитаться.
      keys = [['deliveries'], ['source-documents'], ...DELIVERY_REPORTS];
    } else if (type === 'shipment_updated' || type === 'shipment_deleted') {
      keys = [['shipments'], ['source-documents'], ...SHIPMENT_REPORTS];
    } else if (type === 'source_document_updated') {
      keys = [['source-documents']];
    }
    schedule(keys);
    void evt;
  }

  connectSse();

  // Fallback: если SSE молча оборвался (в проде поток «молчит» из-за
  // прокси/буферизации), разделы должны обновляться без F5. Раньше здесь
  // дёргался no-op ['sync'] — при мёртвом SSE ничего не рефетчилось. Теперь
  // рефетчим реальные ключи, НО только когда SSE не подключён — при живом
  // потоке лишней периодической нагрузки нет.
  const fallback = window.setInterval(
    () => {
      if (sseConnected) return;
      for (const key of FALLBACK_KEYS) {
        qc.invalidateQueries({ queryKey: key }).catch(() => undefined);
      }
    },
    5 * 60 * 1000,
  );

  return () => {
    sse?.close();
    sse = null;
    sseConnected = false;
    bc?.close();
    clearInterval(fallback);
    if (timer !== null) window.clearTimeout(timer);
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };
}

export function broadcastInvalidate(key: string[]): void {
  bc?.postMessage({ type: 'invalidate', key });
}
