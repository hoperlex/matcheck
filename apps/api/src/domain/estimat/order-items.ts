import { eq } from 'drizzle-orm';
import type { EstimatOrderItemsResponse } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { estimatSupplierOrders } from '../../db/schema.js';
import type { EstimatConfig } from './config.js';
import { createEstimatClient, EstimatError, type EstimatClientOptions, type EstimatClient } from './estimat.http.js';

/**
 * Состав заказа запрашивается у EstiMat по требованию — при раскрытии блока
 * «Заказ» или карточки заказа. Обход его не тянет: это был бы запрос на каждый
 * заказ каждые полчаса.
 *
 * Кэш в памяти процесса API. Ключ включает дату изменения, визу и стадию из
 * нашей таблицы: обход принёс изменённый заказ — ключ другой, состав читается
 * заново. Изменений между обходами портал не видит и так, поэтому кэш не делает
 * данные старше, чем сама синхронизация.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const ITEMS_TIMEOUT_MS = 10_000;

type CacheEntry = { at: number; value: EstimatOrderItemsResponse };
const cache = new Map<string, CacheEntry>();

export function resetOrderItemsCache(): void {
  cache.clear();
}

function remember(key: string, value: EstimatOrderItemsResponse): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

export type OrderItemsDeps = {
  db: Db;
  config: EstimatConfig;
  createClient?: (opts: EstimatClientOptions) => EstimatClient;
};

export async function loadOrderItems(deps: OrderItemsDeps, orderId: string): Promise<EstimatOrderItemsResponse | null> {
  const [order] = await deps.db
    .select({
      id: estimatSupplierOrders.id,
      updatedAt: estimatSupplierOrders.estimatUpdatedAt,
      approvedAt: estimatSupplierOrders.supplyApprovedAt,
      stage: estimatSupplierOrders.sourcingStatus,
    })
    .from(estimatSupplierOrders)
    .where(eq(estimatSupplierOrders.id, orderId))
    .limit(1);
  if (!order) return null;
  if (!deps.config.ok) {
    return { state: 'disabled', fetchedAt: null, message: deps.config.reason, items: [] };
  }

  const key = [order.id, order.updatedAt?.toISOString() ?? '', order.approvedAt?.toISOString() ?? '', order.stage].join(':');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const client = (deps.createClient ?? createEstimatClient)({
    baseUrl: deps.config.baseUrl,
    token: deps.config.token,
    timeoutMs: ITEMS_TIMEOUT_MS,
    // Человек ждёт ответа: на «занято» не ждём минутами, а говорим об этом.
    retryRateLimit: false,
  });
  try {
    const items = await client.getSupplierOrderItems(order.id);
    const value: EstimatOrderItemsResponse = {
      state: 'ready',
      fetchedAt: new Date().toISOString(),
      message: null,
      items: items.map((i) => ({
        id: i.id,
        materialName: i.materialName,
        unit: i.unit,
        quantity: i.quantity,
        deliveryDate: i.deliveryDate,
        contractorName: i.contractorName,
      })),
    };
    remember(key, value);
    return value;
  } catch (err) {
    const busy = err instanceof EstimatError && (err.code === 'rate_limited' || err.code === 'database_busy');
    const message = busy
      ? 'EstiMat занят, попробуйте позже'
      : err instanceof EstimatError
        ? err.message
        : 'EstiMat не ответил';
    return { state: 'unavailable', fetchedAt: null, message, items: [] };
  }
}
