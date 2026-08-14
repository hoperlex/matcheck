import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  DEFAULT_MATRIX,
  ErrorResponseSchema,
  LOCKED_CELLS,
  MANAGED_ROLES,
  ManagedRoleSchema,
  PAGE_ACTIONS,
  PAGE_CATALOG,
  PAGE_BY_ID,
  RolePermissionsPatchSchema,
  RolePermissionsResponseSchema,
  canExpand,
  isActionApplicable,
  isLockedCell,
  isNeverGrantable,
  type ManagedRole,
  type PageAction,
  type PageId,
  type PagePermissions,
} from '@matcheck/contracts';
import { asZod } from '../../lib/fastify.js';
import { authEvents, rolePagePermissions } from '../../db/schema.js';
import { fullMatrix, type OverrideMap } from '../../lib/permissions/matrix.js';
import { readOverrides, type DbLike } from '../../lib/permissions/store.js';
import { computeCellCoverage } from '../../lib/permissions/cell-coverage.js';
import { HttpError, badRequest } from '../../lib/http-error.js';

/** Колонка таблицы по действию. */
const COLUMN: Record<
  PageAction,
  'canView' | 'canCreate' | 'canEdit' | 'canDelete' | 'canReview' | 'canReparse'
> = {
  view: 'canView',
  create: 'canCreate',
  edit: 'canEdit',
  delete: 'canDelete',
  review: 'canReview',
  reparse: 'canReparse',
};

type Change = {
  role: ManagedRole;
  page: PageId;
  action: PageAction;
  allowed: boolean;
  /** Значение, которое видел клиент. Расхождение с БД = конфликт правок (409). */
  expected?: boolean;
};

/**
 * Ошибка валидации матрицы с машиночитаемым кодом. Обычный badRequest отдал бы
 * `error: 'HttpError'`, а UI различает причины отказа (заблокированная ячейка
 * читается иначе, чем «нельзя выдать право»).
 */
function invalid(code: string, message: string) {
  const err = badRequest(message);
  err.name = code;
  return err;
}

/**
 * Конфликт правок: ячейку изменил другой администратор. 409, а не 400 —
 * запрос корректен, изменилось состояние, и клиенту нужно перечитать матрицу и
 * повторить, а не исправлять данные.
 */
function conflict(code: string, message: string) {
  const err = new HttpError(409, message);
  err.name = code;
  return err;
}

type Write = {
  role: ManagedRole;
  page: PageId;
  /** Только колонки, которые реально меняем: остальные не трогаем, чтобы
   *  не затереть параллельную правку другого админа. */
  patch: Partial<Record<PageAction, boolean>>;
  audit: Change[];
};

/**
 * Итоговое состояние строк: дефолт → override → дельта.
 *
 * Чистая функция без БД — её вызывают уже внутри транзакции, поверх строк,
 * прочитанных с блокировкой. Бросает invalid() при неразрешимом противоречии.
 */
function computeWrites(changes: Change[], overrides: OverrideMap): Write[] {
  const byRow = new Map<string, { role: ManagedRole; page: PageId; cells: Change[] }>();
  for (const c of changes) {
    const key = `${c.role}:${c.page}`;
    const row = byRow.get(key) ?? { role: c.role, page: c.page, cells: [] };
    row.cells.push(c);
    byRow.set(key, row);
  }

  const writes: Write[] = [];

  for (const row of byRow.values()) {
    const base = DEFAULT_MATRIX[row.role][row.page];
    const existing = overrides.get(`${row.role}:${row.page}`);
    const current: PagePermissions = { ...base, ...(existing ?? {}) };

    const patch: Partial<Record<PageAction, boolean>> = {};
    const audit: Change[] = [];
    for (const c of row.cells) {
      // Оптимистичная блокировка на уровне ЯЧЕЙКИ. Клиент присылает значение,
      // которое видел, принимая решение; если в БД уже другое — между чтением
      // и сохранением эту же ячейку правил кто-то ещё, и молча затирать его
      // работу нельзя. Проверка здесь, внутри транзакции поверх SELECT ... FOR
      // UPDATE: снаружи она была бы гонкой сама по себе.
      if (c.expected !== undefined && current[c.action] !== c.expected) {
        throw conflict(
          'stale_cell',
          `Ячейку ${row.role}:${row.page}:${c.action} успел изменить другой администратор — ` +
            'обновите страницу и повторите',
        );
      }
      patch[c.action] = c.allowed;
      audit.push(c);
    }

    const next: PagePermissions = { ...current, ...patch };

    // Каскад: «Просмотр» — база. Сняли его — гасим остальные сами и
    // пишем производные изменения в аудит. Требовать их в дельте было бы
    // строже, но заставило бы каждого клиента (включая curl и будущие
    // интеграции) знать это правило.
    //
    // Каскад НЕ трогает действия, которые клиент в этом же запросе явно
    // просил включить: «выключи просмотр и включи редактирование» — это
    // противоречие, а не повод молча выполнить половину. Такие остаются
    // включёнными и ловятся проверкой dangling ниже.
    if (!next.view) {
      for (const action of PAGE_ACTIONS) {
        if (action === 'view') continue;
        if (!next[action]) continue;
        if (patch[action] === true) continue;
        if (!isActionApplicable(row.page, action)) continue;
        // Заблокированную ячейку каскад не трогает — она всё равно
        // форсируется резолвером, и запись false вводила бы в заблуждение.
        if (isLockedCell(row.role, row.page, action)) continue;
        next[action] = false;
        patch[action] = false;
        audit.push({ role: row.role, page: row.page, action, allowed: false });
      }
    }

    // Явное нарушение: право действия оставлено включённым при
    // выключенном просмотре. Такое состояние интерфейс не умеет ни
    // показать, ни исправить.
    const dangling = PAGE_ACTIONS.filter(
      (a) => a !== 'view' && next[a] && isActionApplicable(row.page, a),
    );
    if (!next.view && dangling.length > 0) {
      throw invalid(
        'view_required',
        `Действия ${dangling.join(', ')} на странице ${row.page} требуют права «Просмотр»`,
      );
    }

    writes.push({ role: row.role, page: row.page, patch, audit });
  }

  return writes;
}

export async function rolePermissionRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  // Покрытие ячеек зависит только от реестра маршрутов — считаем один раз.
  const coverage = computeCellCoverage();

  const catalogDto = PAGE_CATALOG.map((p) => ({
    id: p.id,
    group: p.group,
    label: p.label,
    actions: p.actions,
    hidden: p.hidden ?? false,
    base: p.base as Record<PageAction, ManagedRole[]>,
  }));

  /**
   * Ответ и для GET, и для мутаций: клиент перерисовывается без второго
   * запроса.
   *
   * Матрица здесь — ВСЕГДА фактическое содержимое БД, независимо от
   * PERMISSIONS_ENFORCE, и это отличие от /me/permissions осознанное. Там флаг=0
   * обязан отдавать дефолты (полнота отката: интерфейс возвращается к
   * исходному виду). Здесь наоборот: вкладка «Роли» показывает то, что лежит в
   * БД, — иначе сохранение «отскакивало» бы (PATCH записал, ответ и следующий
   * GET показывают прежнюю галочку), а сценарий «настроить матрицу заранее →
   * включить флаг» был бы невозможен. Что матрица не применяется, клиент
   * понимает по `enforced: false` и показывает баннер.
   *
   * Читаем мимо кеша: 30-секундная свежесть скрыла бы от админа правку
   * соседнего админа и собственную запись сразу после PATCH.
   */
  async function buildResponse() {
    const overrides = await readOverrides(app.db);
    // Сколько строк-отклонений у каждой роли. Из матрицы это не вывести:
    // строка может совпадать с дефолтом (после каскада), и она всё равно
    // существует. Клиенту число нужно, чтобы «Сбросить к дефолту» не стёр
    // строки, добавленные соседом уже после того, как страница загрузилась.
    const overrideRows = {} as Record<ManagedRole, number>;
    for (const role of MANAGED_ROLES) overrideRows[role] = 0;
    for (const key of overrides.keys()) {
      const role = key.split(':')[0] as ManagedRole;
      if (role in overrideRows) overrideRows[role] += 1;
    }

    return {
      enforced: app.permissions.enforced,
      catalog: catalogDto,
      matrix: fullMatrix(overrides),
      lockedCells: [...LOCKED_CELLS],
      overrideRows,
      // Считается из реестра, а не из БД, — поэтому один раз на модуль.
      cellCoverage: coverage,
    };
  }

  app.get(
    '/api/v1/admin/role-permissions',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { response: { 200: RolePermissionsResponseSchema } },
    },
    async () => buildResponse(),
  );

  app.patch(
    '/api/v1/admin/role-permissions',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: RolePermissionsPatchSchema,
        response: {
          200: RolePermissionsResponseSchema,
          400: ErrorResponseSchema,
          // Ячейку успел изменить другой администратор — см. conflict().
          409: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      const changes = req.body.changes as Change[];

      // ─── 1. Дубли координат ───────────────────────────────────────────
      // Две записи про одну ячейку означают, что клиент сам не знает, чего
      // хочет: результат зависел бы от порядка в массиве.
      const seen = new Set<string>();
      for (const c of changes) {
        const key = `${c.role}:${c.page}:${c.action}`;
        if (seen.has(key)) {
          throw invalid('duplicate_change', `Ячейка ${key} указана в запросе дважды`);
        }
        seen.add(key);
      }

      // ─── 2. Поячеечные инварианты ─────────────────────────────────────
      for (const c of changes) {
        if (!PAGE_BY_ID[c.page]) {
          throw invalid('unknown_page', `Неизвестная страница ${c.page}`);
        }
        // Неприменимое действие нельзя сохранять даже как false: строка в БД
        // означала бы, что у страницы есть такое измерение.
        if (!isActionApplicable(c.page, c.action)) {
          throw invalid(
            'action_not_applicable',
            `Действие «${c.action}» неприменимо к странице ${c.page}`,
          );
        }
        if (isLockedCell(c.role, c.page, c.action)) {
          throw invalid(
            'locked_cell',
            'Эта галочка нужна мобильному приложению КПП: планшет не показывает ошибку ' +
              'доступа и просто перестанет работать',
          );
        }
        // Границы РАСШИРЕНИЯ. Проверяем именно расширение (дефолт запрещал,
        // просят разрешить): возврат ранее снятого базового права — не
        // расширение и обязан проходить, иначе снятый у monitor'а review-доступ
        // нельзя было бы вернуть. Те же правила продублированы в резолвере:
        // строку можно записать и прямым UPDATE.
        const isExpansion = c.allowed && !DEFAULT_MATRIX[c.role][c.page][c.action];
        if (isExpansion && isNeverGrantable(c.page, c.action)) {
          throw invalid(
            'never_grantable',
            `Право ${c.page}:${c.action} не выдаётся ни одной роли: через него можно ` +
              'получить полномочия администратора и отобрать доступ у остальных',
          );
        }
        if (isExpansion && !canExpand(c.role, c.page, c.action)) {
          throw invalid(
            'write_not_expandable',
            `Роли «${c.role}» можно выдать только «Просмотр»: на путях записи у неё нет ` +
              'ограничения по своим данным, и выданное право открыло бы чужие записи',
          );
        }
      }

      // ─── 3+4. Итоговое состояние строк и запись — в одной транзакции ──
      // Частичное сохранение недопустимо: половина изменений применилась,
      // ответ 400, а состояние UI не соответствует БД.
      //
      // Состояние читаем ЗДЕСЬ ЖЕ, прямым SELECT ... FOR UPDATE, а не из
      // app.permissions.get(): кеш живёт до 30 секунд (а при выключенном
      // enforcement его вообще некому инвалидировать по pub/sub), и каскад с
      // view_required считались бы по устаревшему снимку.
      const roles = [...new Set(changes.map((c) => c.role))];
      await app.db.transaction(async (tx) => {
        const overrides = await readOverrides(tx as DbLike, { roles, lock: true });
        const writes = computeWrites(changes, overrides);

        for (const w of writes) {
          const base = DEFAULT_MATRIX[w.role][w.page];
          const insertValues: Record<string, unknown> = {
            role: w.role,
            pageId: w.page,
            updatedByUserId: req.user!.id,
          };
          // INSERT — полная строка из дефолта с наложенной дельтой. Из false
          // нельзя: первая же правка одной ячейки обнулила бы остальные.
          // Цикл по PAGE_ACTIONS, а не перечисление колонок: забытое действие
          // иначе молча вставлялось бы как «запрещено».
          for (const action of PAGE_ACTIONS) {
            insertValues[COLUMN[action]] = base[action];
          }
          const setValues: Record<string, unknown> = {
            updatedAt: new Date(),
            updatedByUserId: req.user!.id,
          };
          for (const [action, allowed] of Object.entries(w.patch)) {
            const col = COLUMN[action as PageAction];
            insertValues[col] = allowed;
            // UPDATE — ТОЛЬКО колонки из этой дельты. Обновляя все четыре, мы
            // затирали бы правку другого админа, сохранённую секунду назад.
            setValues[col] = allowed;
          }

          await tx
            .insert(rolePagePermissions)
            .values(insertValues as never)
            .onConflictDoUpdate({
              target: [rolePagePermissions.role, rolePagePermissions.pageId],
              set: setValues as never,
            });

          for (const c of w.audit) {
            await tx.insert(authEvents).values({
              userId: req.user!.id,
              event: 'role_permission_changed',
              ip: req.ip,
              userAgent: req.headers['user-agent'] ?? null,
              meta: { role: c.role, page: c.page, action: c.action, allowed: c.allowed },
            });
          }
        }
      });

      // Сначала локальный сброс, затем остальным инстансам: обратный порядок
      // оставляет окно, в котором свой же процесс отвечает по старой матрице.
      await app.permissions.invalidateEverywhere();
      return buildResponse();
    },
  );

  app.delete(
    '/api/v1/admin/role-permissions/:role',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        params: z.object({ role: ManagedRoleSchema }),
        // Клиент может прислать число строк, которое видел: если их стало
        // больше или меньше — роль правил кто-то ещё, и сброс отменяется.
        querystring: z.object({ expectedRows: z.coerce.number().int().min(0).optional() }),
        response: {
          200: RolePermissionsResponseSchema,
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req) => {
      // Сброс — отдельный маршрут, а не режим PATCH: это УДАЛЕНИЕ строк, а не
      // изменение ячеек. Строка = отклонение от дефолта, её отсутствие =
      // «как в коде», поэтому записывать сегодняшние значения нельзя: дефолт
      // застыл бы слепком и перестал следовать за кодом.
      const role = req.params.role;
      const expectedRows = req.query.expectedRows;

      await app.db.transaction(async (tx) => {
        const removed = await tx
          .select({
            pageId: rolePagePermissions.pageId,
            canView: rolePagePermissions.canView,
            canCreate: rolePagePermissions.canCreate,
            canEdit: rolePagePermissions.canEdit,
            canDelete: rolePagePermissions.canDelete,
          })
          .from(rolePagePermissions)
          .where(eq(rolePagePermissions.role, role))
          // FOR UPDATE: между SELECT и DELETE соседний админ не должен успеть
          // добавить строку, которая уедет в сброс без следа в аудите.
          .for('update');

        // Оптимистичная блокировка на уровне РОЛИ. Точность ячейки здесь не
        // нужна: сброс стирает строки целиком, и любое расхождение означает,
        // что человек принимал решение по устаревшему состоянию.
        if (expectedRows !== undefined && removed.length !== expectedRows) {
          throw conflict(
            'stale_role',
            'Права этой роли успел изменить другой администратор — обновите страницу и повторите',
          );
        }

        if (removed.length === 0) return;

        await tx.delete(rolePagePermissions).where(eq(rolePagePermissions.role, role));

        // Аудит с ПРЕЖНИМИ значениями и в той же транзакции: иначе из журнала
        // невозможно восстановить, что именно было сброшено.
        for (const r of removed) {
          await tx.insert(authEvents).values({
            userId: req.user!.id,
            event: 'role_permission_reset',
            ip: req.ip,
            userAgent: req.headers['user-agent'] ?? null,
            meta: {
              role,
              page: r.pageId,
              previous: {
                view: r.canView,
                create: r.canCreate,
                edit: r.canEdit,
                delete: r.canDelete,
              },
            },
          });
        }
      });

      await app.permissions.invalidateEverywhere();
      return buildResponse();
    },
  );
}
