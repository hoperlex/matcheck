import { withDb, SYSTEM_SITE_ID, type DeliveryRecord, type MutationRecord } from '../lib/db';
import type { Delivery, DeliveryStatusCode, DeliveryUpsert, Status } from '@matcheck/contracts';
import { api } from './api';
import { localCacheEnabled } from '../lib/localCache';

const PLACEHOLDER_NOT_FILLED: Status = {
  id: '',
  entityType: 'delivery',
  code: 'not_filled',
  label: 'Не оформлена',
  color: 'orange',
  sortOrder: 10,
};

export async function listLocalDeliveries(): Promise<DeliveryRecord[]> {
  // Наблюдатель локальной базой не пользуется (lib/localCache.ts).
  if (!localCacheEnabled()) return [];
  return withDb((dbi) => dbi.getAll('deliveries'));
}

export async function getDelivery(id: string): Promise<DeliveryRecord | undefined> {
  if (!localCacheEnabled()) return undefined;
  return withDb((dbi) => dbi.get('deliveries', id));
}

export function effectiveState(r: DeliveryRecord): Delivery | null {
  if (r.tombstone) return null;
  if (!r.server) {
    // Pure local draft. Compose from local overlay.
    if (!r.local) return null;
    return {
      id: r.id,
      // displayId назначается БД при первом INSERT-е через sequence
      // (миграция 0059). У pure-local-черновика ещё нет; ставим 0 как
      // маркер «не присвоено».
      displayId: 0,
      status: PLACEHOLDER_NOT_FILLED,
      siteId: SYSTEM_SITE_ID,
      supplierId: null,
      contractorId: null,
      vehiclePlate: null,
      driverName: null,
      arrivedAt: null,
      inspectorId: null,
      comment: null,
      version: 0,
      sourceDocumentIds: [],
      items: [],
      photos: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...r.local,
    } as Delivery;
  }
  if (!r.local) return r.server;
  return { ...r.server, ...r.local };
}

export async function upsertServerSnapshot(items: Delivery[]): Promise<void> {
  // Наблюдателю снимки не пишем: копия пережила бы потерю доступа к объекту.
  if (!localCacheEnabled()) return;
  await withDb(async (dbi) => {
    const tx = dbi.transaction('deliveries', 'readwrite');
    for (const item of items) {
      const existing = await tx.store.get(item.id);
      if (existing) {
        await tx.store.put({
          ...existing,
          server: item,
          version: item.version,
          lastSyncedAt: Date.now(),
        });
      } else {
        await tx.store.put({
          id: item.id,
          server: item,
          local: null,
          tombstone: false,
          version: item.version,
          lastSyncedAt: Date.now(),
        });
      }
    }
    await tx.done;
  });
}

/**
 * `keepIfSet` — поля, которые НЕ перезаписываются, если в локальной правке уже
 * есть значение. Так новая ручная запись сохраняет момент операции первого
 * «Сохранить»: повторное «Сохранить» офлайн присылает новое время, но в очередь
 * уходит первое (как на планшете). Проверка — в той же транзакции.
 */
export async function applyLocalEdit(
  id: string,
  patch: Partial<Delivery>,
  keepIfSet: readonly (keyof Delivery)[] = [],
): Promise<void> {
  // Чтение и запись — одной транзакцией: `withDb` повторяет колбэк на новом
  // соединении, и разнесённые get/put повторились бы поверх чужой правки.
  await withDb(async (dbi) => {
    const tx = dbi.transaction('deliveries', 'readwrite');
    const existing = await tx.store.get(id);
    const prevLocal: Partial<Delivery> = existing?.local ?? {};
    const kept: Partial<Delivery> = {};
    for (const key of keepIfSet) {
      if (prevLocal[key] != null) Object.assign(kept, { [key]: prevLocal[key] });
    }
    const next: DeliveryRecord = existing
      ? { ...existing, local: { ...prevLocal, ...patch, ...kept } }
      : {
          id,
          server: null,
          local: patch,
          tombstone: false,
          version: 0,
          lastSyncedAt: null,
        };
    await tx.store.put(next);
    await tx.done;
  });
}

/**
 * Поля локальной правки, которые уходят вместе с выбором получателя в форме
 * «до Сохранить». Признак — тоже: в этом режиме он выбирается в паре с
 * получателем (pendingPurpose) и без него смысла не имеет.
 */
const LOCAL_RECIPIENT_KEYS = ['contractorId', 'recipientMolId', 'purpose'] as const;

/** Есть ли в неотправленной правке выбор получателя (режим «до Сохранить»). */
export function hasLocalRecipientEdit(r: DeliveryRecord): boolean {
  const local = r.local;
  return local != null && ('contractorId' in local || 'recipientMolId' in local);
}

/**
 * Убрать выбор получателя из неотправленной правки приёмки — перед тем как
 * сохранить получателя отдельным PATCH. Иначе лежащая в очереди старая правка
 * (офлайн, conflictPending) ушла бы после PATCH без keepRecipient и вернула бы
 * прежнего получателя: локальная правка живёт до ответа на upsert, снимок
 * сервера её не трогает. Вызывать под withQueueLock (services/mutationQueue.ts):
 * начатая отправка закончится раньше, следующая прочитает правку уже без ключей.
 */
export async function dropLocalRecipient(id: string): Promise<void> {
  if (!localCacheEnabled()) return;
  await withDb(async (dbi) => {
    const tx = dbi.transaction('deliveries', 'readwrite');
    const existing = await tx.store.get(id);
    const local = existing?.local;
    if (existing && local && LOCAL_RECIPIENT_KEYS.some((key) => key in local)) {
      const rest: Partial<Delivery> = { ...local };
      for (const key of LOCAL_RECIPIENT_KEYS) delete rest[key];
      await tx.store.put({ ...existing, local: rest });
    }
    await tx.done;
  });
}

export async function markTombstone(id: string): Promise<void> {
  await withDb(async (dbi) => {
    const tx = dbi.transaction('deliveries', 'readwrite');
    const existing = await tx.store.get(id);
    if (existing) await tx.store.put({ ...existing, tombstone: true });
    await tx.done;
  });
}

export async function enqueueMutation(
  m: Omit<MutationRecord, 'attempts' | 'createdAt'>,
): Promise<void> {
  await withDb((dbi) => dbi.put('mutations', { ...m, attempts: 0, createdAt: Date.now() }));
}

// Soft-delete операции — обращаемся к серверу напрямую и возвращаем свежий DTO.
// Локальное хранилище IndexedDB у помеченных документов не используется: они
// сразу становятся read-only, а после восстановления invalidate перечитает.
export function markDeletion(id: string, reason: string | null = null): Promise<Delivery> {
  return api.post<Delivery>(`/deliveries/${id}/mark-deletion`, { reason });
}

export function unmarkDeletion(id: string): Promise<Delivery> {
  return api.post<Delivery>(`/deliveries/${id}/unmark-deletion`);
}

export function hardDeleteDelivery(id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`/deliveries/${id}`);
}

/**
 * `baseVersion` — версия, с которой форма взяла строки (её кладёт в мутацию
 * карточка), а не `r.version`: ту поллинг карточки переписывает каждые 5 с через
 * `upsertServerSnapshot`, а строки формы при этом не перечитываются. С версией
 * записи устаревшая форма проходила проверку на сервере и молча возвращала
 * удалённые строки — например, после отвязки документа с удалением в другой
 * вкладке.
 */
export function buildUpsertPayload(r: DeliveryRecord, baseVersion: number): DeliveryUpsert {
  const effective = effectiveState(r);
  if (!effective) {
    throw new Error('Cannot build payload for empty delivery');
  }
  return {
    id: r.id,
    statusCode: effective.status.code as DeliveryStatusCode,
    siteId: effective.siteId,
    supplierId: effective.supplierId,
    contractorId: effective.contractorId,
    // recipientMolId — МОЛ-получатель приёмки (альтернатива contractorId).
    // Без этого поля выбор МОЛ в шапке слетал при сохранении: UI его
    // обновляет, но buildPatch → IDB → buildUpsertPayload терял по пути
    // к серверу.
    recipientMolId: effective.recipientMolId,
    // Только явная правка из локального overlay: обычный upsert планшета и
    // сохранение других полей не должны перезаписывать серверный признак.
    ...(r.local?.purpose != null && { purpose: r.local.purpose }),
    // Получателя в форме не правили — он сохраняется отдельным PATCH, и сервер
    // оставляет того, что в строке. Поля получателя выше всё равно уходят
    // (снимок сервера): старый API флаг отбросит и запишет их, а не null.
    ...(r.server !== null && !hasLocalRecipientEdit(r) && { keepRecipient: true }),
    vehiclePlate: effective.vehiclePlate,
    driverName: effective.driverName,
    arrivedAt: effective.arrivedAt,
    comment: effective.comment,
    inTransit: effective.inTransit ?? false,
    isAssets: effective.isAssets ?? false,
    // Ручная запись (без машины, одним этапом) — только при СОЗДАНИИ: сервер
    // учитывает поле лишь при INSERT, а записи, которой ещё нет на сервере, нет
    // и серверного снимка. Время подтверждения — момент первого «Сохранить»,
    // а не время отправки очереди (иначе офлайн разнесёт приход и подтверждение).
    ...(r.server === null && r.local?.isManual === true && { isManual: true }),
    ...(r.server === null &&
      r.local?.confirmedByMolAt != null && { confirmedByMolAt: r.local.confirmedByMolAt }),
    sourceDocumentIds: effective.sourceDocumentIds,
    items: effective.items.map((it) => ({
      id: it.id,
      // Происхождение позиции. Без него строки, заведённые с портала «из УПД»,
      // приезжали на сервер без атрибуции: createDelivery/createShipment берут
      // её только из запроса, и карточка показывала бы материалы «без привязки
      // к документу». Для существующей строки сервер присланное значение
      // игнорирует и берёт сохранённое — переписать атрибуцию клиент не может.
      sourceDocumentId: it.sourceDocumentId ?? null,
      sourceDocumentItemId: it.sourceDocumentItemId ?? null,
      itemKind: it.itemKind,
      materialId: it.materialId,
      assetId: it.assetId,
      inventoryNumber: it.inventoryNumber,
      serialNumber: it.serialNumber,
      nameRaw: it.nameRaw,
      qtyPlanned: it.qtyPlanned,
      qtyActual: it.qtyActual,
      unit: it.unit,
      comment: it.comment,
      lineNo: it.lineNo,
      volumeM3: it.volumeM3,
      massKg: it.massKg,
      // Без price/vatRate/vatSum в payload суммы материалов не доезжали
      // до сервера. Заполняются вручную через материалы-таблицу или
      // подтягиваются автоматически от привязанной УПД.
      price: it.price,
      vatRate: it.vatRate,
      vatSum: it.vatSum,
      volumeConfidence: it.volumeConfidence,
      groupName: it.groupName,
    })),
    baseVersion,
  };
}
