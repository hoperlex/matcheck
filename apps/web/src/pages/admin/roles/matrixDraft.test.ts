// @vitest-environment node
/**
 * Правила черновика матрицы обязаны совпадать с серверными: расхождение
 * даёт либо «отскок» галочки после ответа, либо 400 на клик, который UI
 * показал допустимым.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MATRIX,
  LOCKED_CELLS,
  PAGE_CATALOG,
  type ManagedRole,
  type PageId,
} from '@matcheck/contracts';
import {
  applyCell,
  applyGroup,
  cellState,
  cloneMatrix,
  diffMatrix,
  groupState,
  roleHasChanges,
  type CatalogEntry,
  type Matrix,
} from './matrixDraft';

// Каталог с сервера имеет ту же форму, что PAGE_CATALOG, но hidden всегда задан.
const catalog: CatalogEntry[] = PAGE_CATALOG.map((p) => ({
  id: p.id,
  group: p.group,
  label: p.label,
  actions: p.actions,
  hidden: p.hidden ?? false,
  base: p.base as CatalogEntry['base'],
}));

const byId = (id: PageId): CatalogEntry => catalog.find((c) => c.id === id)!;
const locked = new Set(LOCKED_CELLS);
const fresh = (): Matrix => cloneMatrix(DEFAULT_MATRIX as Matrix);

describe('состояние ячейки', () => {
  it('заблокированная ячейка мобильного КПП', () => {
    expect(cellState(byId('operations.deliveries'), 'inspector_kpp', 'create', locked)).toBe(
      'locked',
    );
  });

  it('неприменимое действие', () => {
    expect(cellState(byId('stats'), 'manager', 'delete', locked)).toBe('not-applicable');
  });

  it('право, которого нет в базе, — матрица только сужает', () => {
    // Удаление в справочниках есть только у admin, а он вне матрицы.
    expect(cellState(byId('references.sites'), 'manager', 'delete', locked)).toBe('not-in-base');
  });

  it('обычная ячейка', () => {
    expect(cellState(byId('references.sites'), 'manager', 'edit', locked)).toBe('editable');
  });
});

describe('каскад просмотра', () => {
  it('снятие просмотра гасит остальные действия', () => {
    const next = applyCell(fresh(), byId('references.sites'), 'manager', 'view', false, locked);
    expect(next.manager['references.sites']).toMatchObject({
      view: false,
      create: false,
      edit: false,
    });
  });

  it('включение действия поднимает просмотр', () => {
    let m = applyCell(fresh(), byId('references.sites'), 'manager', 'view', false, locked);
    m = applyCell(m, byId('references.sites'), 'manager', 'edit', true, locked);
    expect(m.manager['references.sites']).toMatchObject({ view: true, edit: true });
  });

  it('заблокированную ячейку изменить нельзя', () => {
    const before = fresh();
    const after = applyCell(
      before,
      byId('operations.deliveries'),
      'inspector_kpp',
      'create',
      false,
      locked,
    );
    expect(after).toBe(before);
    expect(diffMatrix(fresh(), after)).toEqual([]);
  });

  it('ячейку вне базы включить нельзя', () => {
    const before = fresh();
    const after = applyCell(before, byId('references.sites'), 'manager', 'delete', true, locked);
    expect(after).toBe(before);
  });

  it('каскад не трогает заблокированные ячейки', () => {
    // У inspector_kpp все 4 действия Операций locked: снятие просмотра ничего
    // не должно погасить — иначе UI обещал бы то, чего API не примет.
    const before = fresh();
    const after = applyCell(
      before,
      byId('operations.deliveries'),
      'inspector_kpp',
      'view',
      false,
      locked,
    );
    expect(after).toBe(before);
  });

  it('черновик иммутабелен: исходная матрица не меняется', () => {
    const before = fresh();
    const snapshot = JSON.stringify(before);
    applyCell(before, byId('references.sites'), 'manager', 'edit', false, locked);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('групповые операции', () => {
  const refs = catalog.filter((c) => c.group === 'references');

  it('снятие просмотра по разделу гасит весь раздел', () => {
    const next = applyGroup(fresh(), refs, 'manager', 'view', false, locked);
    for (const entry of refs) {
      expect(next.manager[entry.id]!.view).toBe(false);
    }
    expect(groupState(next, refs, 'manager', 'view', locked)).toMatchObject({
      checked: false,
      indeterminate: false,
    });
  });

  it('частичное состояние показывается как indeterminate', () => {
    const next = applyCell(fresh(), byId('references.sites'), 'manager', 'view', false, locked);
    expect(groupState(next, refs, 'manager', 'view', locked)).toMatchObject({
      checked: false,
      indeterminate: true,
    });
  });

  it('раздел, где действие никому не применимо, отключён', () => {
    const stats = catalog.filter((c) => c.group === 'stats');
    expect(groupState(fresh(), stats, 'manager', 'delete', locked)).toMatchObject({
      disabled: true,
    });
  });
});

describe('дельта для сохранения', () => {
  it('без правок дельта пустая', () => {
    expect(diffMatrix(fresh(), fresh())).toEqual([]);
  });

  it('дельта содержит и производные изменения каскада', () => {
    const draft = applyCell(fresh(), byId('references.units'), 'manager', 'view', false, locked);
    const changes = diffMatrix(fresh(), draft);
    // Просмотр + погашенные create/edit; delete у справочников и так был false.
    expect(changes.map((c) => c.action).sort()).toEqual(['create', 'edit', 'view']);
    expect(changes.every((c) => c.allowed === false)).toBe(true);
    expect(changes.every((c) => c.role === 'manager')).toBe(true);
  });

  it('правки одной роли не отмечают соседнюю', () => {
    const draft = applyCell(fresh(), byId('references.sites'), 'manager', 'edit', false, locked);
    expect(roleHasChanges(fresh(), draft, 'manager')).toBe(true);
    for (const role of ['contractor', 'monitor', 'inspector_kpp'] as ManagedRole[]) {
      expect(roleHasChanges(fresh(), draft, role)).toBe(false);
    }
  });

  it('возврат галочки на место убирает её из дельты', () => {
    let draft = applyCell(fresh(), byId('references.sites'), 'manager', 'edit', false, locked);
    draft = applyCell(draft, byId('references.sites'), 'manager', 'edit', true, locked);
    expect(diffMatrix(fresh(), draft)).toEqual([]);
  });
});
