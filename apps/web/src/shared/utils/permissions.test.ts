// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { DEFAULT_MATRIX, PAGE_CATALOG, type MePermissionsResponse } from '@matcheck/contracts';
import {
  buildPermissionSet,
  can,
  canView,
  canViewGroup,
  defaultPermissions,
} from './permissions';

const payload = (over: Partial<MePermissionsResponse> = {}): MePermissionsResponse =>
  ({
    userId: 'u1',
    role: 'manager',
    enforced: true,
    pages: {},
    ...over,
  }) as MePermissionsResponse;

describe('права: фолбэк на дефолты', () => {
  it('дефолт роли — это DEFAULT_MATRIX из контрактов, а не отдельный слепок', () => {
    // Два независимых списка неизбежно разъехались бы, и веб начал бы прятать
    // кнопки, которые API разрешает.
    expect(defaultPermissions('manager').pages).toEqual(DEFAULT_MATRIX.manager);
    expect(defaultPermissions('contractor').pages).toEqual(DEFAULT_MATRIX.contractor);
  });

  it('admin вне матрицы: все действия разрешены', () => {
    const admin = defaultPermissions('admin');
    for (const page of PAGE_CATALOG) {
      expect(admin.pages[page.id]).toEqual({
        view: true,
        create: true,
        edit: true,
        delete: true,
        review: true,
      });
    }
  });

  it('КРИТИЧНО: perms === null не означает «нет прав»', () => {
    // Права могли не приехать: 404 на старом API, 5xx, обрыв, таймаут. Ни один
    // из этих случаев не должен оставить человека перед пустым меню.
    expect(can(null, 'references.sites', 'view', 'manager')).toBe(true);
    expect(can(null, 'references.sites', 'delete', 'manager')).toBe(false); // как в дефолте
    // Роли тоже не знаем — не запрещаем ничего: сервер проверит сам.
    expect(can(null, 'admin.users', 'edit')).toBe(true);
  });

  it('неприменимое действие всегда false', () => {
    // У «Статистики» есть только просмотр — рисовать кнопку удаления нельзя
    // даже админу.
    expect(can(defaultPermissions('admin'), 'stats', 'delete')).toBe(false);
    expect(can(defaultPermissions('manager'), 'stats', 'view')).toBe(true);
  });
});

describe('права: разбор ответа сервера', () => {
  it('берёт значения из ответа', () => {
    const perms = buildPermissionSet(
      payload({
        pages: {
          'references.sites': { view: true, create: false, edit: false, delete: false },
        },
      } as Partial<MePermissionsResponse>),
    );
    expect(perms.pages['references.sites']).toEqual({
      view: true,
      create: false,
      edit: false,
      delete: false,
    });
    expect(perms.enforced).toBe(true);
  });

  it('страница, которой в ответе нет, берётся из дефолта роли', () => {
    // Раздельный выкат: веб знает страницу, о которой API ещё не в курсе.
    // «Нет ключа» значит «сервер не рассказал», а не «запрещено».
    const perms = buildPermissionSet(payload());
    expect(perms.pages['references.sites']).toEqual(DEFAULT_MATRIX.manager['references.sites']);
    expect(perms.pages['operations.deliveries']).toEqual(
      DEFAULT_MATRIX.manager['operations.deliveries'],
    );
  });

  it('в наборе ровно страницы каталога', () => {
    const perms = buildPermissionSet(payload());
    expect(Object.keys(perms.pages).sort()).toEqual(PAGE_CATALOG.map((p) => p.id).sort());
  });
});

describe('права: раздел виден, если видна хоть одна его страница', () => {
  it('закрыли одну страницу справочников — раздел остался', () => {
    const perms = buildPermissionSet(
      payload({
        pages: {
          'references.sites': { view: false, create: false, edit: false, delete: false },
        },
      } as Partial<MePermissionsResponse>),
    );
    expect(canView(perms, 'references.sites')).toBe(false);
    expect(canViewGroup(perms, 'references')).toBe(true);
  });

  it('закрыли все страницы раздела — раздел исчез', () => {
    const pages = Object.fromEntries(
      PAGE_CATALOG.filter((p) => p.group === 'references').map((p) => [
        p.id,
        { view: false, create: false, edit: false, delete: false },
      ]),
    );
    const perms = buildPermissionSet(payload({ pages } as Partial<MePermissionsResponse>));
    expect(canViewGroup(perms, 'references')).toBe(false);
    // Соседний раздел не задет.
    expect(canViewGroup(perms, 'operations')).toBe(true);
  });
});
