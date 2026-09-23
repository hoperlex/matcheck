/**
 * Что администратор видит после «Проверить доступ».
 *
 * Повод для теста боевой: подключение к Диадоку наконец авторизовалось, но
 * список ящиков пришёл пустым — и экран сказал «Прав недостаточно». Это
 * отправляет настраивать права там, где на самом деле нужно добавить учётную
 * запись сотрудником организации. Разные неполадки обязаны называться по-разному.
 */
import { describe, it, expect } from 'vitest';
import type { EdoCheckResult } from '@matcheck/contracts';
import { describeAccessCheck } from './edo-access-check';

const box = { boxId: 'box-1', title: 'ООО «СУ-10»', inn: '7736255508', kpp: '774550001' };

function result(over: Partial<EdoCheckResult['employee']>, boxes = [box]): EdoCheckResult {
  return {
    employee: {
      isBlocked: false,
      documentAccessLevel: 'AllDocuments',
      hasRequiredAccess: true,
      ...over,
    },
    boxes,
  };
}

describe('итог проверки доступа', () => {
  it('пустой список ящиков называется своим именем, а не нехваткой прав', () => {
    // Уровень доступа здесь и не спрашивали: спрашивать его не у чего.
    const verdict = describeAccessCheck(
      result({ documentAccessLevel: null, hasRequiredAccess: false }, []),
    );
    expect(verdict.kind).toBe('no_boxes');
    expect(verdict.title).not.toMatch(/прав недостаточно/i);
    expect(verdict.description).toMatch(/сотрудником/i);
  });

  it('при наличии ящика ограниченный доступ остаётся ограниченным доступом', () => {
    const verdict = describeAccessCheck(
      result({ documentAccessLevel: 'DepartmentDocuments', hasRequiredAccess: false }),
    );
    expect(verdict.kind).toBe('limited_access');
    expect(verdict.description).toMatch(/AllDocuments/);
  });

  it('блокировка важнее всего остального', () => {
    // Иначе заблокированная учётная запись без ящиков получила бы совет
    // «добавьте сотрудником», который ничего не изменит.
    const verdict = describeAccessCheck(
      result({ isBlocked: true, documentAccessLevel: null, hasRequiredAccess: false }, []),
    );
    expect(verdict.kind).toBe('blocked');
  });

  it('полный доступ к ящику — это успех', () => {
    expect(describeAccessCheck(result({})).kind).toBe('ok');
  });
});
