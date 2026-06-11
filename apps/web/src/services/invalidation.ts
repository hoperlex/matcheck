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
      sse?.close();
      sse = null;
      setTimeout(connectSse, 5000);
    };
  }

  function handle(type: string, evt: MessageEvent) {
    let keys: string[][] = [];
    if (type === 'delivery_updated' || type === 'delivery_deleted') {
      // source-documents: вкладка «Ожидаемые» зависит от привязок в
      // delivery_sources — после создания/удаления приёмки список
      // ожидаемых УПД должен перечитаться.
      // reports: раздел «Материалы» (Stock/Intake/Shipment) агрегируется
      // из delivery_items — без инвалидации показывал бы старые данные
      // до F5 (особенно «Сумма НДС» сразу после Завершить 2 Этап в мобиле).
      keys = [['deliveries'], ['source-documents'], ['sync'], ['reports']];
    } else if (type === 'shipment_updated' || type === 'shipment_deleted') {
      keys = [['shipments'], ['source-documents'], ['sync'], ['reports']];
    } else if (type === 'source_document_updated') {
      keys = [['source-documents'], ['sync']];
    }
    schedule(keys);
    void evt;
  }

  connectSse();

  // Fallback timer: invalidate every 5 minutes in case SSE silently breaks
  const fallback = window.setInterval(
    () => {
      qc.invalidateQueries({ queryKey: ['sync'] }).catch(() => undefined);
    },
    5 * 60 * 1000,
  );

  return () => {
    sse?.close();
    bc?.close();
    clearInterval(fallback);
    if (timer !== null) window.clearTimeout(timer);
  };
}

export function broadcastInvalidate(key: string[]): void {
  bc?.postMessage({ type: 'invalidate', key });
}
