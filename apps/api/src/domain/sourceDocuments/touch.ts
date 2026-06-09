import { inArray } from 'drizzle-orm';
import { sourceDocuments } from '../../db/schema.js';

/**
 * Бамп `source_documents.updated_at = NOW()` для указанных id.
 *
 * Зачем: УПД на портале меняет видимость в «Ожидаемые» по факту
 * привязки/отвязки к delivery/shipment. Junction-таблицы (delivery_sources,
 * shipment_sources) сами по себе не меняют `source_documents.updated_at`,
 * поэтому мобильный /sync пропускал такие изменения — УПД зависала
 * фантомом в Inbox инспектора до logout/login.
 *
 * Решение: при любой мутации `delivery_sources` / `shipment_sources`
 * (INSERT и DELETE) дополнительно бампать `updated_at` затронутых УПД.
 * Тогда мобильный /sync вернёт обновлённую УПД в дельте → клиент
 * обновит локальный junction-кэш → Inbox автоматически отразит новое
 * состояние без действий инспектора.
 *
 * Вызывать ВНУТРИ транзакции, в которой делается INSERT/DELETE junction.
 * Если массив пуст — no-op.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function touchSourceDocuments(app: any, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await app.db
    .update(sourceDocuments)
    .set({ updatedAt: new Date() })
    .where(inArray(sourceDocuments.id, [...ids]));
}
