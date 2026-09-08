import * as Sentry from '@sentry/react';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  Counterparty,
  Delivery,
  DeliveryPhotoStage,
  Material,
  Shipment,
  Site,
  SourceDocumentDetail,
} from '@matcheck/contracts';

/**
 * Системный объект «Без объекта». Используется при offline-создании приёмки,
 * когда у пользователя ещё нет реальных объектов, и для миграции
 * pending mutations со старой схемы (без siteId).
 */
export const SYSTEM_SITE_ID = '00000000-0000-0000-0000-000000000001';

export type OperationKind = 'delivery' | 'shipment';

export type DeliveryRecord = {
  id: string;
  server: Delivery | null;
  local: Partial<Delivery> | null;
  tombstone: boolean;
  version: number;
  lastSyncedAt: number | null;
};

export type ShipmentRecord = {
  id: string;
  server: Shipment | null;
  local: Partial<Shipment> | null;
  tombstone: boolean;
  version: number;
  lastSyncedAt: number | null;
};

export type MutationRecord = {
  id: string;
  kind: 'delivery_upsert' | 'delivery_delete' | 'shipment_upsert' | 'shipment_delete';
  entityId: string;
  baseVersion: number;
  payload: unknown;
  attempts: number;
  createdAt: number;
  conflictPending?: boolean;
};

/**
 * Фото для приёмки или отгрузки. Поле `deliveryId` исторически — это
 * «operationId»; новые записи различают тип через `operationKind`.
 */
export type PhotoRecord = {
  id: string;
  deliveryId: string;
  operationKind: OperationKind;
  origin: 'local' | 'remote';
  kind: 'document' | 'cargo' | 'vehicle' | 'other';
  // Этап приёмки: 'before' (1-й этап) или 'after' (2-й этап, после
  // подтверждения МОЛ). Для shipment поле всегда 'before' и не используется.
  stage: DeliveryPhotoStage;
  contentHash: string;
  idempotencyKey: string;
  blob?: Blob;
  thumbBlob?: Blob;
  s3Key?: string;
  thumbS3Key?: string;
  takenAt: number;
  uploaded: boolean;
  // Управление фоновой отправкой (A2). Отсутствие полей = поведение 'pending'
  // (совместимо со старыми записями — миграция версии IDB не нужна, индексов
  // по этим полям нет).
  // 'blocked' — терминальная ошибка (приёмка удалена/forbidden), авто-повтор
  // остановлен, но blob сохранён.
  uploadState?: 'pending' | 'blocked';
  uploadAttempts?: number;
  // Барьер backoff: retryPendingUploads пропускает запись, пока now < nextRetryAt.
  nextRetryAt?: number;
  lastUploadError?: { status?: number; code: string; at: number };
};

export type ReferenceRecord =
  | (Counterparty & { kind: 'counterparty' })
  | (Material & { kind: 'material' })
  | (Site & { kind: 'site' });

export type SettingsRecord = {
  key: string;
  value: unknown;
};

/**
 * В `indexes` idb ждёт ТИП КЛЮЧА индекса, а не имя поля: `IndexKey` берёт
 * оттуда тип аргумента для `get`/`getAll`. Пока здесь стояли имена полей,
 * `index('byDelivery').getAll(deliveryId)` требовал литерал `'deliveryId'`
 * вместо самого id — три таких вызова и были частью скрытых ошибок типов.
 */
export interface MatcheckDB extends DBSchema {
  deliveries: { key: string; value: DeliveryRecord; indexes: { byTombstone: IDBValidKey } };
  shipments: { key: string; value: ShipmentRecord; indexes: { byTombstone: IDBValidKey } };
  mutations: { key: string; value: MutationRecord; indexes: { byEntity: string } };
  photos: {
    key: string;
    value: PhotoRecord;
    indexes: { byDelivery: string; byHash: string };
  };
  source_documents: { key: string; value: SourceDocumentDetail };
  references: { key: string; value: ReferenceRecord; indexes: { byKind: string } };
  settings: { key: string; value: SettingsRecord };
}

let dbPromise: Promise<IDBPDatabase<MatcheckDB>> | null = null;

const DB_VERSION = 4;

/**
 * Событие жизненного цикла соединения. Раньше вкладка узнавала о закрытом
 * соединении единственным способом — падением транзакции у пользователя
 * («Не удалось добавить фото: The database connection is closing»), и в
 * телеметрии не оставалось ничего.
 *
 * Что именно закрывает соединение на бою — пока гипотеза: обновление Service
 * Worker само по себе `versionchange` не вызывает, пока не меняется
 * DB_VERSION, а переполнение квоты обычно приходит как QuotaExceededError.
 * Поэтому логируем все входы в это состояние, а не только те, что удалось
 * объяснить заранее.
 */
type DbLifecycleEvent =
  | 'blocked'
  | 'blocking'
  | 'terminated'
  | 'open_failed'
  | 'reopen_after_closing';

function reportDbEvent(event: DbLifecycleEvent, extra?: Record<string, unknown>): void {
  Sentry.captureMessage('idb_connection_event', {
    level: 'warning',
    tags: { area: 'idb', event },
    extra: { dbVersion: DB_VERSION, ...extra },
  });
}

/**
 * Забывает соединение — но только если в кэше лежит ИМЕННО тот промис,
 * которому принадлежит колбэк.
 *
 * Без сравнения по ссылке возникает гонка: колбэк умирающего соединения
 * срабатывает позже, чем кто-то успел открыть новое, и обнуляет уже живой
 * кэш. Следующий вызов db() открыл бы третье соединение, а второе осталось
 * бы висеть незакрытым.
 */
function forgetConnection(owner: Promise<IDBPDatabase<MatcheckDB>>): void {
  if (dbPromise !== owner) return;
  dbPromise = null;
}

/**
 * Признак «соединение закрывается» у ошибки транзакции.
 *
 * Повторять имеет смысл только это: браузер закрыл соединение под нами, и
 * повтор с новым хэндлом пройдёт. QuotaExceededError, наоборот, вернётся
 * снова — повтор лишь удвоит нагрузку и задержит сообщение пользователю.
 */
export function isConnectionClosingError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name !== 'InvalidStateError') return false;
  if (typeof message !== 'string') return false;
  return /clos(ing|ed)/i.test(message);
}

export function db(): Promise<IDBPDatabase<MatcheckDB>> {
  if (dbPromise) return dbPromise;
  // Колбэки ниже замыкаются на `opened`, чтобы сбрасывать кэш только свой:
  // вызываются они асинхронно, когда переменная уже инициализирована.
  const opened: Promise<IDBPDatabase<MatcheckDB>> = openDB<MatcheckDB>('matcheck', DB_VERSION, {
    blocked(currentVersion, blockedVersion) {
      // Наше открытие ждёт чужого соединения — прямой признак, что открыта
      // вторая вкладка со старым бандлом.
      reportDbEvent('blocked', { currentVersion, blockedVersion });
    },
    blocking(currentVersion, blockedVersion) {
      // Другая вкладка просит апгрейд: закрываемся сами, иначе она зависнет.
      // `terminated` после собственного close() idb не зовёт (контракт
      // idb, entry.d.ts) — поэтому кэш обнуляем здесь же, руками.
      reportDbEvent('blocking', { currentVersion, blockedVersion });
      void opened.then((d) => d.close()).catch(() => undefined);
      forgetConnection(opened);
    },
    terminated() {
      // Соединение закрыл браузер (эвикт, «очистить данные сайта»).
      reportDbEvent('terminated');
      forgetConnection(opened);
    },
    upgrade(database, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const dels = database.createObjectStore('deliveries', { keyPath: 'id' });
        dels.createIndex('byTombstone', 'tombstone');
        const muts = database.createObjectStore('mutations', { keyPath: 'id' });
        muts.createIndex('byEntity', 'entityId');
        const photos = database.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('byDelivery', 'deliveryId');
        photos.createIndex('byHash', 'contentHash');
        database.createObjectStore('source_documents', { keyPath: 'id' });
        const refs = database.createObjectStore('references', { keyPath: 'id' });
        refs.createIndex('byKind', 'kind');
        database.createObjectStore('settings', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        // 1) Старые pending-мутации delivery_upsert без siteId зависнут на сервере
        //    с 400 после деплоя. Досыпаем системный siteId и contractorId: null.
        const muts = tx.objectStore('mutations');
        muts.openCursor().then(async function walk(cursor) {
          if (!cursor) return;
          const m = cursor.value;
          if (m.kind === 'delivery_upsert' && m.payload && typeof m.payload === 'object') {
            const payload = m.payload as Record<string, unknown>;
            let dirty = false;
            if (payload.siteId === undefined) {
              payload.siteId = SYSTEM_SITE_ID;
              dirty = true;
            }
            if (payload.contractorId === undefined) {
              payload.contractorId = null;
              dirty = true;
            }
            if (dirty) await cursor.update({ ...m, payload });
          }
          const next = await cursor.continue();
          await walk(next);
        });

        // 2) Локальные правки в deliveries без siteId — заполняем системным.
        const dels = tx.objectStore('deliveries');
        dels.openCursor().then(async function walk(cursor) {
          if (!cursor) return;
          const r = cursor.value;
          if (r.local && r.local.siteId === undefined) {
            await cursor.update({ ...r, local: { ...r.local, siteId: SYSTEM_SITE_ID } });
          }
          const next = await cursor.continue();
          await walk(next);
        });
      }
      if (oldVersion < 3) {
        // Новый store shipments — симметрично deliveries.
        if (!database.objectStoreNames.contains('shipments')) {
          const sh = database.createObjectStore('shipments', { keyPath: 'id' });
          sh.createIndex('byTombstone', 'tombstone');
        }
        // PhotoRecord теперь несёт operationKind. Существующим записям проставляем 'delivery'.
        const photos = tx.objectStore('photos');
        photos.openCursor().then(async function walk(cursor) {
          if (!cursor) return;
          const p = cursor.value;
          // Записи, созданные до v3, поля не имеют. Проверять через `in` нельзя:
          // в типе PhotoRecord поле обязательно, TS сужает ветку до never и
          // spread перестаёт компилироваться. Смотрим на значение.
          if ((p as unknown as Record<string, unknown>).operationKind === undefined) {
            await cursor.update({ ...p, operationKind: 'delivery' as const });
          }
          const next = await cursor.continue();
          await walk(next);
        });
      }
      if (oldVersion < 4) {
        // PhotoRecord теперь несёт stage. Существующим записям проставляем
        // 'before' — все ранее снятые фото логически относятся к 1-му этапу.
        const photos = tx.objectStore('photos');
        photos.openCursor().then(async function walk(cursor) {
          if (!cursor) return;
          const p = cursor.value;
          // См. комментарий выше про `in` и сужение до never.
          if ((p as unknown as Record<string, unknown>).stage === undefined) {
            await cursor.update({ ...p, stage: 'before' as const });
          }
          const next = await cursor.continue();
          await walk(next);
        });
      }
    },
  });
  dbPromise = opened;
  // Отказ открытия тоже нельзя кэшировать навсегда: без сброса вкладка до
  // самой перезагрузки отдавала бы одну и ту же отклонённую попытку.
  void opened.catch((err: unknown) => {
    const { name, message } = (err ?? {}) as { name?: unknown; message?: unknown };
    reportDbEvent('open_failed', {
      name: typeof name === 'string' ? name : undefined,
      message: typeof message === 'string' ? message : undefined,
    });
    forgetConnection(opened);
  });
  return opened;
}

/**
 * Выполняет работу с базой, переоткрывая соединение, если браузер закрыл его
 * под нами.
 *
 * Повтор ровно один и только на ошибке закрывающегося соединения: `fn`
 * получает НОВЫЙ хэндл, поэтому обязана быть идемпотентной — все вызовы ниже
 * либо читают, либо пишут запись по известному ключу.
 */
export async function withDb<T>(fn: (dbi: IDBPDatabase<MatcheckDB>) => Promise<T>): Promise<T> {
  const first = db();
  try {
    return await fn(await first);
  } catch (err) {
    if (!isConnectionClosingError(err)) throw err;
    reportDbEvent('reopen_after_closing');
    forgetConnection(first);
    return await fn(await db());
  }
}

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const row = await withDb((dbi) => dbi.get('settings', key));
  return (row?.value as T) ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await withDb((dbi) => dbi.put('settings', { key, value }));
}
