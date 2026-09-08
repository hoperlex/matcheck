/**
 * Поллинг не должен стирать то, что человек печатает.
 */
import { describe, expect, it } from 'vitest';
import { shouldReplaceItems } from './itemsHydration';

describe('shouldReplaceItems', () => {
  it('первая гидратация заполняет форму всегда', () => {
    expect(
      shouldReplaceItems({
        isFirstHydration: true,
        hasNewServerSnapshot: false,
        hasUnsavedItemEdits: true,
      }),
    ).toBe(true);
  });

  it('без нового снимка форму не трогаем', () => {
    expect(
      shouldReplaceItems({
        isFirstHydration: false,
        hasNewServerSnapshot: false,
        hasUnsavedItemEdits: false,
      }),
    ).toBe(false);
  });

  it('новый снимок при несохранённой правке НЕ затирает позиции', () => {
    // Ровно сценарий приёмки 13932: закрытая приёмка, поллинг раз в 5 секунд,
    // менеджер печатает исправленное название.
    expect(
      shouldReplaceItems({
        isFirstHydration: false,
        hasNewServerSnapshot: true,
        hasUnsavedItemEdits: true,
      }),
    ).toBe(false);
  });

  it('после подтверждения сервером гидратация снова разрешена', () => {
    // Флаг снимается только по server_acked: после локальной постановки в
    // очередь серверный снимок ещё старый и вернул бы прежний текст.
    expect(
      shouldReplaceItems({
        isFirstHydration: false,
        hasNewServerSnapshot: true,
        hasUnsavedItemEdits: false,
      }),
    ).toBe(true);
  });
});
