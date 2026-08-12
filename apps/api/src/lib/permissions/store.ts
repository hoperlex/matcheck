import { Redis } from 'ioredis';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ManagedRole, PageId, PagePermissions } from '@matcheck/contracts';
import type { Db } from '../../db/client.js';
import { rolePagePermissions } from '../../db/schema.js';
import { overrideKey, type OverrideMap } from './matrix.js';

/**
 * Кеш матрицы прав.
 *
 * Почему кеш вообще. attachUser уже делает два SELECT на КАЖДЫЙ запрос
 * (sessions + users). Третий поход в БД на каждый HTTP добавил бы треть
 * round-trip'ов на лёгких ручках — за настройку, которая меняется раз в
 * месяц. Здесь: один SELECT (≤92 строки, единицы килобайт) раз в 30 секунд
 * на инстанс.
 *
 * Расплата — задержка применения. Она несимметрична и это осознанно:
 * правка через админку инвалидирует кеш немедленно (локально + Redis
 * pub/sub остальным инстансам), а TTL остаётся страховкой на случай
 * недоступного Redis. То есть «сужение прав применилось с лагом до 30 с»
 * возможно только при неработающем Redis.
 */

const CHANNEL = 'matcheck:permissions';
const TTL_MS = 30_000;

/** Пул или транзакция: тот же приём, что в domain/auth/apply-password.ts. */
export type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Чтение overrides ПРЯМО из БД, мимо кеша.
 *
 * Нужно там, где 30-секундная свежесть кеша недопустима: админский GET (иначе
 * правка соседнего админа не видна) и валидация PATCH (каскад и view_required
 * обязаны считаться по фактическому состоянию строк, а не по снимку).
 *
 * `lock: true` — SELECT ... FOR UPDATE: два админа, сохраняющих одну роль
 * одновременно, выстраиваются в очередь, и второй считает каскад уже поверх
 * записи первого. Без блокировки оба читают одно состояние и «последний
 * победил» молча теряет чужую правку соседней ячейки.
 */
export async function readOverrides(
  db: DbLike,
  opts: { roles?: ManagedRole[]; lock?: boolean } = {},
): Promise<OverrideMap> {
  const base = db
    .select({
      role: rolePagePermissions.role,
      pageId: rolePagePermissions.pageId,
      canView: rolePagePermissions.canView,
      canCreate: rolePagePermissions.canCreate,
      canEdit: rolePagePermissions.canEdit,
      canDelete: rolePagePermissions.canDelete,
      canReview: rolePagePermissions.canReview,
    })
    .from(rolePagePermissions);

  const filtered = opts.roles ? base.where(inArray(rolePagePermissions.role, opts.roles)) : base;
  const rows = await (opts.lock ? filtered.for('update') : filtered);

  const map = new Map<string, PagePermissions>();
  for (const r of rows) {
    // Роль admin в таблицу не попадает (CHECK в БД), но если строка всё же
    // возникла — резолвер её игнорирует: admin вне матрицы.
    map.set(overrideKey(r.role as ManagedRole, r.pageId as PageId), {
      view: r.canView,
      create: r.canCreate,
      edit: r.canEdit,
      delete: r.canDelete,
      review: r.canReview,
    });
  }
  return map;
}

export type MatrixStore = {
  /** Overrides из БД; при ошибке чтения — пустая карта (= дефолты). */
  get(): Promise<OverrideMap>;
  /** Сбросить локальный кеш (после записи в этом же процессе). */
  invalidateLocal(): void;
  /** Сбросить локально и уведомить остальные инстансы. */
  invalidateEverywhere(): Promise<void>;
  /** Подписка на инвалидации от других инстансов. Вызывается один раз при старте. */
  startSubscriber(redisUrl: string | undefined): void;
  stop(): Promise<void>;
};

export function createMatrixStore(app: FastifyInstance): MatrixStore {
  let cache: OverrideMap | null = null;
  let loadedAt = 0;
  let inFlight: Promise<OverrideMap> | null = null;
  let subscriber: Redis | null = null;

  async function load(): Promise<OverrideMap> {
    return readOverrides(app.db);
  }

  return {
    async get(): Promise<OverrideMap> {
      const fresh = cache !== null && Date.now() - loadedAt < TTL_MS;
      if (fresh) return cache!;
      // Схлопываем параллельные промахи: на старте под нагрузкой иначе
      // полетело бы столько SELECT'ов, сколько запросов в полёте.
      inFlight ??= load()
        .then((map) => {
          cache = map;
          loadedAt = Date.now();
          return map;
        })
        .catch((err: unknown) => {
          // Fail-open на дефолты: недоступная таблица прав не должна класть
          // портал. Кеш не обновляем — следующий запрос попробует снова.
          app.log.error({ err }, 'permissions: не удалось прочитать матрицу, работаем по дефолтам');
          return new Map<string, PagePermissions>() as OverrideMap;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    invalidateLocal() {
      cache = null;
      loadedAt = 0;
    },

    async invalidateEverywhere() {
      // Сначала локально, потом остальным: обратный порядок оставляет окно,
      // в котором свой же инстанс ещё отвечает по устаревшей матрице.
      cache = null;
      loadedAt = 0;
      try {
        await app.redis.publish(CHANNEL, '1');
      } catch (err) {
        // Не роняем сохранение: правка уже в БД, остальные инстансы
        // подхватят её по TTL (≤30 с).
        app.log.warn({ err }, 'permissions: publish инвалидации не удался');
      }
    },

    startSubscriber(redisUrl: string | undefined) {
      const url = redisUrl ?? 'redis://localhost:6379';
      // Отдельное соединение: после SUBSCRIBE в ioredis на этом сокете
      // нельзя выполнять обычные команды (тот же приём, что в
      // domain/sse/redis-bridge.ts).
      const sub = new Redis(url, { lazyConnect: true });
      subscriber = sub;
      sub.on('error', (err) => {
        app.log.warn({ err }, 'permissions: ошибка redis-подписчика');
      });
      sub.on('message', (channel) => {
        if (channel !== CHANNEL) return;
        cache = null;
        loadedAt = 0;
      });
      void sub
        .connect()
        .then(() => sub.subscribe(CHANNEL))
        .catch((err: unknown) => {
          // Без подписки инвалидация деградирует до TTL — это лаг, а не дыра.
          app.log.warn({ err }, 'permissions: подписка на инвалидации не удалась');
        });
    },

    async stop() {
      if (!subscriber) return;
      try {
        await subscriber.quit();
      } catch {
        /* ignore */
      }
      subscriber = null;
    },
  };
}
