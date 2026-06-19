import { describe, it, expect } from 'vitest';
import {
  isDeliveryDowngrade,
  isShipmentDowngrade,
} from '../src/domain/operations/status-guard.js';

/**
 * Регрессионные тесты на серверную защиту от downgrade статуса.
 *
 * Главный сценарий, который защищаем:
 *   Мобильное приложение прошло 1 этап → запись стала filled (delivery)
 *   или shipped (shipment). Менеджер открыл на веб-портале, что-то
 *   правит, сервер собирает payload из stale IndexedDB-snapshot со
 *   статусом not_filled, шлёт upsert. Без guard'а — сервер охотно
 *   уронил бы статус обратно, мобильный Stage 2 потерял бы запись.
 *
 * Дополнительно проверяем, что **апгрейды** работают как раньше
 * (тоже регрессия — нельзя случайно сломать not_filled → filled).
 */

describe('isDeliveryDowngrade — defense-in-depth для жизненного статуса', () => {
  // ───── Главный новый guard ─────────────────────────────────────────
  it('filled → not_filled — БЛОКИРУЕТСЯ (главный фикс)', () => {
    expect(isDeliveryDowngrade('filled', 'not_filled')).toBe(true);
  });

  // ───── Существующий confirmed_mol guard — не сломать ──────────────
  it('confirmed_mol → not_filled — блокируется (исторический guard)', () => {
    expect(isDeliveryDowngrade('confirmed_mol', 'not_filled')).toBe(true);
  });

  it('confirmed_mol → filled — блокируется (исторический guard)', () => {
    expect(isDeliveryDowngrade('confirmed_mol', 'filled')).toBe(true);
  });

  // ───── Апгрейды разрешены ──────────────────────────────────────────
  it('not_filled → filled — РАЗРЕШЁН (привязали УПД, материалы появились)', () => {
    expect(isDeliveryDowngrade('not_filled', 'filled')).toBe(false);
  });

  it('not_filled → confirmed_mol — РАЗРЕШЁН (мобила сразу финализирует)', () => {
    expect(isDeliveryDowngrade('not_filled', 'confirmed_mol')).toBe(false);
  });

  it('filled → confirmed_mol — РАЗРЕШЁН (МОЛ подтвердил)', () => {
    expect(isDeliveryDowngrade('filled', 'confirmed_mol')).toBe(false);
  });

  // ───── Тождественные «переходы» (повторное Сохранить) ──────────────
  it('not_filled → not_filled — разрешён (повторное Save без материалов)', () => {
    expect(isDeliveryDowngrade('not_filled', 'not_filled')).toBe(false);
  });

  it('filled → filled — разрешён (повторное Save оформленной)', () => {
    expect(isDeliveryDowngrade('filled', 'filled')).toBe(false);
  });

  it('confirmed_mol → confirmed_mol — разрешён', () => {
    expect(isDeliveryDowngrade('confirmed_mol', 'confirmed_mol')).toBe(false);
  });

  // ───── Граничные случаи ────────────────────────────────────────────
  it('пустой existing-статус — не блокируем (новая запись)', () => {
    expect(isDeliveryDowngrade('', 'not_filled')).toBe(false);
    expect(isDeliveryDowngrade('', 'filled')).toBe(false);
  });

  it('неизвестный статус → известный — не блокируем', () => {
    expect(isDeliveryDowngrade('weird_status', 'filled')).toBe(false);
  });
});

describe('isShipmentDowngrade — симметрично delivery, статус shipped', () => {
  it('shipped → not_filled — БЛОКИРУЕТСЯ (главный фикс для отгрузки)', () => {
    expect(isShipmentDowngrade('shipped', 'not_filled')).toBe(true);
  });

  it('confirmed_mol → not_filled — блокируется', () => {
    expect(isShipmentDowngrade('confirmed_mol', 'not_filled')).toBe(true);
  });

  it('confirmed_mol → shipped — блокируется', () => {
    expect(isShipmentDowngrade('confirmed_mol', 'shipped')).toBe(true);
  });

  it('not_filled → shipped — РАЗРЕШЁН (1 этап завершён)', () => {
    expect(isShipmentDowngrade('not_filled', 'shipped')).toBe(false);
  });

  it('shipped → confirmed_mol — РАЗРЕШЁН (МОЛ подтвердил)', () => {
    expect(isShipmentDowngrade('shipped', 'confirmed_mol')).toBe(false);
  });

  it('shipped → shipped — разрешён', () => {
    expect(isShipmentDowngrade('shipped', 'shipped')).toBe(false);
  });

  it('delivery-статус "filled" в shipment-guard — не блокирует', () => {
    // Защита здесь только от shipped→not_filled. Слово filled у
    // shipment в pipeline не появится, но если случайно прилетит —
    // не должно ломать поведение.
    expect(isShipmentDowngrade('filled', 'not_filled')).toBe(false);
  });
});

describe('Контракт: оба guard — pure-функции, без побочных эффектов', () => {
  it('многократный вызов с теми же аргументами даёт тот же результат', () => {
    for (let i = 0; i < 5; i++) {
      expect(isDeliveryDowngrade('filled', 'not_filled')).toBe(true);
      expect(isShipmentDowngrade('shipped', 'not_filled')).toBe(true);
    }
  });
});
