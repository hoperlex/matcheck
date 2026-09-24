/**
 * Период осмотра ящика.
 *
 * Повод боевой: подключение завели 22 сентября, и отсечка по умолчанию равна
 * этой дате. Осмотр с ней показал бы почти пустоту, хотя вопрос стоит ровно
 * обратный — что вообще лежит в ящике и каких версий там документы.
 */
import { describe, it, expect } from 'vitest';
import { inventorySince, INVENTORY_PERIODS } from './edo-inventory-period';

const NOW = new Date('2026-09-24T12:00:00.000Z');

describe('период осмотра', () => {
  it('«с момента подключения» не передаёт дату — её знает сервер', () => {
    // Важно вернуть именно undefined: пустая строка или null ушли бы в тело
    // запроса и сервер счёл бы их заданным периодом.
    expect(inventorySince('connected', NOW)).toBeUndefined();
  });

  it('отсчёт идёт назад от текущего момента', () => {
    expect(inventorySince('d30', NOW)).toBe('2026-08-25T12:00:00.000Z');
    expect(inventorySince('d90', NOW)).toBe('2026-06-26T12:00:00.000Z');
    expect(inventorySince('d365', NOW)).toBe('2025-09-24T12:00:00.000Z');
  });

  it('у каждого варианта списка есть рабочее значение', () => {
    // Защита от рассинхрона: вариант, добавленный в список для интерфейса, но
    // забытый в вычислении, молча превратился бы в «с подключения».
    for (const p of INVENTORY_PERIODS) {
      const since = inventorySince(p.value, NOW);
      if (p.value === 'connected') expect(since).toBeUndefined();
      else expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});
