import type { QueryClient } from '@tanstack/react-query';

const CHANNEL_NAME = 'matcheck-invalidation';

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
    for (const key of keys) {
      qc.invalidateQueries({ queryKey: key }).catch(() => undefined);
      bc?.postMessage({ type: 'invalidate', key });
    }
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
  };
}

export function broadcastInvalidate(key: string[]): void {
  bc?.postMessage({ type: 'invalidate', key });
}
