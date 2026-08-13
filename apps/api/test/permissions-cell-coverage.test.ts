/**
 * Честность ячейки: управляет ли галочка доступом целиком или только вкладкой.
 *
 * Одни и те же GET кормят и страницу справочника, и комбобоксы формы приёмки, и
 * мобильный `/sync`, поэтому они помечены `always`. Снятый «Просмотр» убирает
 * раздел из меню, но данные по API остаются — и администратор должен видеть это
 * до того, как понадеется на галочку.
 */
import { describe, expect, it } from 'vitest';
import { computeCellCoverage } from '../src/lib/permissions/cell-coverage.js';

const coverage = computeCellCoverage();

describe('покрытие ячеек матрицы', () => {
  it('чтение справочника управляет только вкладкой', () => {
    // Ни одного маршрута под матрицей: закрыть данные галочкой нельзя.
    expect(coverage['references.sites:view']).toBe('portal-only');
    expect(coverage['references.units:view']).toBe('portal-only');
    expect(coverage['references.mol:view']).toBe('portal-only');
  });

  it('ГЛАВНОЕ: просмотр документов помечен как неполный, а не как полный', () => {
    // Ровно тот случай, на котором ломался прежний признак «нет ни одного
    // не-always маршрута»: у ячейки есть static-маршрут import-result, и она
    // выглядела бы полностью закрытой, хотя основные GET документов — always.
    expect(coverage['documents.list:view']).toBe('partial');
  });

  it('запись в справочники закрывается галочкой полностью', () => {
    expect(coverage['references.sites:create']).toBe('full');
    expect(coverage['references.sites:edit']).toBe('full');
  });

  it('операции и отметка проверки — под матрицей целиком', () => {
    expect(coverage['operations.deliveries:create']).toBe('full');
    expect(coverage['operations.deliveries:review']).toBe('full');
    expect(coverage['operations.shipments:delete']).toBe('full');
  });

  it('неприменимые действия в покрытие не попадают', () => {
    // «Удалять» у Статистики не существует — значка быть не должно.
    expect(coverage['stats:delete']).toBeUndefined();
    expect(coverage['stats:view']).toBe('full');
  });
});
