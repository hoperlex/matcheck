import type { PublicRejectReason } from '@matcheck/contracts';

// Очередь отправки поставок.
//
// Логика вынесена из компонента намеренно: именно здесь живут правила, которые
// легко сломать незаметно — порядок отправки, продолжение после ошибки и
// повтор только неудачных. В виде чистой функции они проверяются обычными
// тестами, без DOM и рендера.

/** Сколько поставок можно отправить за один заход. */
export const MAX_DELIVERIES = 10;

export type DeliveryState = 'draft' | 'sending' | 'sent' | 'failed';

/** Результат приёма одной поставки сервером. */
export type SendResult = {
  ticket: string;
  filesRejected: Array<{ filename: string; reason: PublicRejectReason }>;
};

/** Минимум, который очередь знает о поставке. */
export type QueueItem = {
  id: string;
  state: DeliveryState;
};

export type QueuePatch = {
  state: DeliveryState;
  ticket?: string;
  error?: string;
  rejected?: Array<{ filename: string; reason: PublicRejectReason }>;
};

export type SubmitQueueDeps<T extends QueueItem> = {
  /** Отправка одной поставки. Бросает при отказе — текст ошибки идёт в панель. */
  send: (item: T) => Promise<SendResult>;
  /** Обновление состояния конкретной поставки в UI. */
  onUpdate: (id: string, patch: QueuePatch) => void;
  /** Как превратить исключение в текст для человека. */
  describeError?: (err: unknown) => string;
};

export type SubmitQueueSummary = { sent: number; failed: number };

function defaultDescribeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Не удалось отправить. Проверьте связь и попробуйте ещё раз.';
}

/**
 * Отправляет поставки ПО ОЧЕРЕДИ и возвращает итог.
 *
 * Работает по снимку списка, а не по живому массиву: пока идёт отправка,
 * пользователь не должен уметь подменить очередь под собой.
 *
 * Отправляются только поставки в состоянии `draft` и `failed` — уже принятые
 * (`sent`) пропускаются, поэтому повторный запуск после частичного сбоя
 * дошлёт ровно то, что не дошло, и ничего не задвоит.
 *
 * Ошибка одной поставки не останавливает остальные: поставщик, у которого
 * упала третья из пяти, не должен отправлять всё заново.
 */
export async function submitDeliveries<T extends QueueItem>(
  snapshot: readonly T[],
  deps: SubmitQueueDeps<T>,
): Promise<SubmitQueueSummary> {
  const describe = deps.describeError ?? defaultDescribeError;
  let sent = 0;
  let failed = 0;

  for (const item of snapshot) {
    if (item.state === 'sent') continue;

    deps.onUpdate(item.id, { state: 'sending' });
    try {
      const res = await deps.send(item);
      deps.onUpdate(item.id, {
        state: 'sent',
        ticket: res.ticket,
        rejected: res.filesRejected,
      });
      sent += 1;
    } catch (err) {
      deps.onUpdate(item.id, { state: 'failed', error: describe(err) });
      failed += 1;
    }
  }

  return { sent, failed };
}
