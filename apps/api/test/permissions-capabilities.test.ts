/**
 * Возможности маршрутов (capabilities) и политика расширения.
 *
 * Ячейка матрицы не равна одной возможности: за парой «страница × действие»
 * стоят маршруты с РАЗНЫМИ allow-list. Здесь проверяется, что сервер считает
 * фактический доступ, а не пересказывает матрицу, и что расширение прав не
 * открывает лишнего.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MATRIX, MANAGED_ROLES, canExpand, type ManagedRole } from '@matcheck/contracts';
import { capabilitiesFor, declaredCapabilities } from '../src/lib/permissions/capabilities.js';
import { ROUTE_PERMISSIONS, routeKey } from '../src/lib/permissions/route-map.js';
import type { OverrideMap } from '../src/lib/permissions/matrix.js';
import { overrideKey } from '../src/lib/permissions/matrix.js';
import { collectRoutes, isSyntheticMethod, type RouteRow } from './helpers/route-inventory.js';
import type { RouteRolesMap } from '../src/lib/permissions/route-roles.js';

let cache: RouteRow[] | undefined;
async function routes(): Promise<RouteRow[]> {
  cache ??= await collectRoutes();
  return cache.filter((r) => !isSyntheticMethod(r.method));
}

/**
 * Инвентарь allow-list для тестов. Собран независимым способом (подмена
 * декоратора в route-inventory), поэтому служит перекрёстной проверкой к
 * рантайм-сборке через onRoute.
 */
async function roleMap(): Promise<RouteRolesMap> {
  const map = new Map<string, ManagedRole[]>();
  for (const r of await routes()) {
    if (r.roles.length === 0) continue;
    map.set(routeKey(r.method, r.url), r.roles as ManagedRole[]);
  }
  return map as RouteRolesMap;
}

const EMPTY: OverrideMap = new Map();

/** Overrides с одной выданной ячейкой — поверх дефолта роли. */
function granted(role: ManagedRole, page: string, action: string): OverrideMap {
  const base = DEFAULT_MATRIX[role][page as never];
  return new Map([[overrideKey(role, page as never), { ...base, [action]: true }]]) as OverrideMap;
}

describe('capabilities: фактический доступ, а не пересказ матрицы', () => {
  it('каждое имя объявлено хотя бы одним маршрутом', () => {
    expect(declaredCapabilities().length).toBeGreaterThan(0);
  });

  it('инспектор создаёт ссылку, но не отзывает её и не читает переписку', async () => {
    // Ровно тот случай, ради которого share разбит на три возможности: одна
    // общая оставила бы инспектору кнопку «Отозвать», отвечающую 403.
    const caps = capabilitiesFor(EMPTY, 'inspector_kpp', await roleMap());
    expect(caps).toContain('operations.share.manage');
    expect(caps).not.toContain('operations.share.revoke');
    expect(caps).not.toContain('operations.share.messages');
  });

  it('инспектору закрыты флаги и привязка УПД, хотя ячейка edit у него есть', async () => {
    // Проверяем именно расхождение ячейки и маршрута: can('edit') = true,
    // а кнопки рисовать нельзя.
    expect(DEFAULT_MATRIX.inspector_kpp['operations.deliveries'].edit).toBe(true);
    const caps = capabilitiesFor(EMPTY, 'inspector_kpp', await roleMap());
    expect(caps).not.toContain('operations.edit.flags');
    expect(caps).not.toContain('operations.edit.link_source');
    expect(caps).not.toContain('operations.edit.supplier_directory');
  });

  it('менеджер получает правку, но не удаление навсегда', async () => {
    const caps = capabilitiesFor(EMPTY, 'manager', await roleMap());
    expect(caps).toContain('operations.edit.flags');
    expect(caps).toContain('operations.share.revoke');
    expect(caps).not.toContain('operations.delete.bulk_hard');
  });

  it('монитору по умолчанию не доступно ничего из write-возможностей', async () => {
    const caps = capabilitiesFor(EMPTY, 'monitor', await roleMap());
    expect(caps).not.toContain('operations.edit.flags');
    expect(caps).not.toContain('operations.share.manage');
  });
});

describe('политика расширения: выданное право открывает ровно то, что задумано', () => {
  it('политика записана в реестре явно — это контракт, а не деталь', () => {
    const meta = (key: string) => ROUTE_PERMISSIONS.get(key);

    expect(meta('PATCH /api/v1/deliveries/:id/flags')?.expandableBy).toEqual(['monitor']);
    expect(meta('POST /api/v1/deliveries/:id/link-source')?.expandableBy).toEqual(['monitor']);
    expect(meta('POST /api/v1/deliveries/bulk-mark-deletion')?.expandableBy).toEqual(['monitor']);

    // Ссылки-шаринги и удаление навсегда не открывает никакое расширение.
    expect(meta('POST /api/v1/deliveries/:id/share-link')?.expandableBy).toEqual([]);
    expect(meta('POST /api/v1/deliveries/bulk-hard-delete')?.expandableBy).toEqual([]);
  });

  it('выданное монитору «Удалять» НЕ открывает удаление навсегда', async () => {
    // Иначе расширение дало бы монитору больше, чем есть у менеджера:
    // bulk-hard-delete admin-only. Проверка держится и сейчас, и после того,
    // как write-расширение станет доступно монитору.
    const caps = capabilitiesFor(
      granted('monitor', 'operations.deliveries', 'delete'),
      'monitor',
      await roleMap(),
    );
    expect(caps).not.toContain('operations.delete.bulk_hard');
  });

  it('ЦЕЛЬ ЗАДАЧИ: выданный монитору edit открывает флаги и привязку УПД', async () => {
    // До разделения review и edit это было невыразимо: право монитора совпадало
    // с дефолтом, расширением не считалось, и authorize отказывал всегда.
    const caps = capabilitiesFor(
      granted('monitor', 'operations.deliveries', 'edit'),
      'monitor',
      await roleMap(),
    );
    expect(caps).toContain('operations.edit.flags');
    expect(caps).toContain('operations.edit.link_source');
  });

  it('выданный монитору edit НЕ открывает ссылки-шаринги', async () => {
    // expandableBy: [] — share живёт своей возможностью, а не частью правки.
    const caps = capabilitiesFor(
      granted('monitor', 'operations.deliveries', 'edit'),
      'monitor',
      await roleMap(),
    );
    expect(caps).not.toContain('operations.share.manage');
    expect(caps).not.toContain('operations.share.revoke');
  });

  it('подрядчику запись не выдаётся ни на одной странице', async () => {
    // WRITE_BLOCKED_ROLES: у него есть ограничение видимости, но пути записи
    // принадлежность не сверяют — выданное право означало бы правку чужого.
    for (const page of ['operations.deliveries', 'references.sites', 'documents.mail'] as const) {
      for (const action of ['create', 'edit', 'delete'] as const) {
        expect(
          canExpand('contractor', page, action),
          `${page}:${action} не должен выдаваться подрядчику`,
        ).toBe(false);
      }
    }
    // Просмотр — можно: чтение и так ограничено скоупом роли.
    expect(canExpand('contractor', 'references.sites', 'view')).toBe(true);
  });
});

describe('инварианты реестра', () => {
  it('capability не вешается на маршрут, у которого роли проверяются в хендлере', async () => {
    // У таких маршрутов (DELETE /deliveries/:id) снаружи allow-list не виден:
    // capability молча означала бы «разрешено всем, у кого ячейка», что неверно.
    // Снять запрет можно будет, когда inline-проверки переедут на
    // assertPermission (шаг 6 плана).
    const withRoles = await roleMap();
    const offenders: string[] = [];
    for (const [key, rule] of ROUTE_PERMISSIONS) {
      if (!rule.capability) continue;
      if (rule.kind === 'in-handler' || !withRoles.has(key)) offenders.push(key);
    }
    expect(offenders).toEqual([]);
  });

  it('расхождение «базовое право есть, а маршрут закрыт» требует ЯВНОЙ политики', async () => {
    // Тест не диктует значение expandableBy — он не даёт забыть решение.
    // Забытый случай означал бы, что выданное право либо молча не работает,
    // либо молча открывает лишнее.
    const withRoles = await roleMap();
    const undecided: string[] = [];

    for (const [key, rule] of ROUTE_PERMISSIONS) {
      if (rule.kind !== 'static') continue;
      const allowed = withRoles.get(key);
      if (!allowed || allowed.length === 0) continue;
      if (rule.expandableBy !== undefined) continue;

      for (const role of MANAGED_ROLES) {
        const hasBase = DEFAULT_MATRIX[role][rule.page][rule.action];
        if (hasBase && !allowed.includes(role)) {
          undecided.push(`${key} × ${role}`);
        }
      }
    }

    expect(undecided).toEqual([]);
  });
});
