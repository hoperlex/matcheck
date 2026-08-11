// @vitest-environment node
/**
 * Инвариант выката: пока матрица никого не сузила, меню обязано остаться
 * ровно прежним.
 *
 * Это единственная автоматическая гарантия того, что переход навигации с
 * ролей на права ничего не сломал в день релиза. Дефолт матрицы
 * (PAGE_CATALOG[].base) и списки ролей в navItems.ts описывают одно и то же
 * разными словами; если они разъедутся, человек не увидит привычный пункт
 * меню — молча, без ошибки.
 */
import { describe, it, expect } from 'vitest';
import { MANAGED_ROLES, PAGE_CATALOG, type UserRole } from '@matcheck/contracts';
import { can, canView, defaultPermissions } from '../../shared/utils/permissions';
import { filterByPermissions, filterByRole, homePath, navItems } from './navItems';

const ALL_ROLES: UserRole[] = ['admin', ...MANAGED_ROLES];

describe('меню по правам == меню по ролям (до сужения)', () => {
  for (const role of ALL_ROLES) {
    it(`роль ${role}: тот же набор пунктов`, () => {
      const byRole = filterByRole(role).map((n) => n.key);
      const byPerms = filterByPermissions(defaultPermissions(role), role).map((n) => n.key);
      expect(byPerms).toEqual(byRole);
    });
  }

  it('права не загрузились — меню как у роли, а не пустое', () => {
    // Сеть отвалилась/404 на старом API: человек должен продолжить работать.
    for (const role of ALL_ROLES) {
      expect(filterByPermissions(null, role).map((n) => n.key)).toEqual(
        filterByRole(role).map((n) => n.key),
      );
    }
  });

  it('у каждого пункта есть группа матрицы', () => {
    // Пункт без группы был бы виден всегда — тихая дыра в enforcement.
    for (const item of navItems) {
      expect(item.group).toBeTruthy();
    }
  });
});

describe('нулевой UI-diff: расширение не меняет интерфейс без строки в матрице', () => {
  // Матрица научилась расширять права, и главный риск теперь — что интерфейс
  // «поедет» сам собой, до того как администратор что-то выдал. Дефолты обязаны
  // давать ровно сегодняшнюю картину: и меню, и доступ к каждой странице.
  it('доступ к страницам при дефолтах совпадает с базовым набором роли', () => {
    for (const role of ALL_ROLES) {
      const perms = defaultPermissions(role);
      for (const page of PAGE_CATALOG) {
        for (const action of page.actions) {
          const expected =
            role === 'admin' ? true : (page.base[action]?.includes(role as never) ?? false);
          expect(
            can(perms, page.id, action),
            `${role}: ${page.id}:${action}`,
          ).toBe(expected);
        }
      }
    }
  });

  it('вкладки админки при дефолтах видны только админу', () => {
    // Раздел «Администрирование» теперь можно выдать любой роли — но только
    // явной строкой, а не фактом появления кода.
    for (const page of PAGE_CATALOG.filter((p) => p.group === 'admin')) {
      for (const role of MANAGED_ROLES) {
        expect(canView(defaultPermissions(role), page.id), `${role}: ${page.id}`).toBe(false);
      }
      expect(canView(defaultPermissions('admin'), page.id)).toBe(true);
    }
  });
});

describe('homePath', () => {
  it('ведёт на первый доступный раздел роли', () => {
    for (const role of ALL_ROLES) {
      expect(homePath(defaultPermissions(role), role)).toBe(filterByRole(role)[0]?.path);
    }
  });

  it('без единого доступного раздела возвращает null, а не корень', () => {
    // Иначе редирект «на корень» замкнулся бы сам на себя: корень ведёт на
    // первый доступный раздел, а доступных нет.
    const perms = defaultPermissions('manager');
    for (const page of Object.keys(perms.pages) as (keyof typeof perms.pages)[]) {
      perms.pages[page] = { view: false, create: false, edit: false, delete: false };
    }
    expect(homePath(perms, 'manager')).toBeNull();
  });

  it('закрытие всех страниц не портит общий дефолт (набор — копия)', () => {
    // Мутация возвращённого набора не должна утекать в DEFAULT_MATRIX: иначе
    // одна страница испортила бы права всему приложению.
    const perms = defaultPermissions('manager');
    perms.pages['references.sites'] = { view: false, create: false, edit: false, delete: false };
    expect(defaultPermissions('manager').pages['references.sites'].view).toBe(true);
  });
});
