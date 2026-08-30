/**
 * Замок на финансовые поля контракта с мобильным приложением.
 *
 * Что защищаем. Инспектор их не редактирует, но приложение ОБЯЗАНО вернуть
 * `price`/`vatRate`/`vatSum` в upsert на финализации обоих этапов: позиции при
 * сохранении не обновляются, а перезаписываются целиком — `DELETE` всех строк
 * операции и следом `INSERT` присланных (routes/deliveries.ts). Значения
 * берутся как `i.price ?? null`, то есть «поле не прислали» и «прислали null»
 * уравнены. Исчезнет поле из контракта — клиент пришлёт `null`, сервер запишет
 * `null`, и финансы на портале пропадут молча: колонки nullable, схема такое
 * значение принимает, CHECK не мешает.
 *
 * Почему тест, а не запись в документе. Правило «не удалять финансовые поля»
 * жило только в своде договорённостей, а `DeliveryItemSchema` и
 * `ShipmentItemSchema` не были упомянуты ни в одном тесте: удаление поля не
 * роняло ничего. Свод можно забыть прочитать, упавший тест — нет.
 *
 * Проверяется набор ключей схемы, а не текст файла: переименование или перенос
 * поля в другой файл замок не обманет.
 */
import { describe, it, expect } from 'vitest';
import {
  DeliveryItemSchema,
  DeliveryUpsertItemSchema,
  ShipmentItemSchema,
  ShipmentUpsertItemSchema,
} from '@matcheck/contracts';

/** Три поля, потеря любого из которых обнуляет деньги в операции. */
const FINANCIAL_FIELDS = ['price', 'vatRate', 'vatSum'] as const;

/**
 * Обе стороны обмена: то, что сервер ОТДАЁТ клиенту, и то, что он от клиента
 * ПРИНИМАЕТ. Достаточно потерять поле на любой из сторон — в ответе клиенту
 * нечего будет вернуть, во входной схеме присланное молча отбросится.
 */
const CONTRACT_SIDES = [
  { name: 'приёмка: ответ сервера', schema: DeliveryItemSchema },
  { name: 'приёмка: входной upsert', schema: DeliveryUpsertItemSchema },
  { name: 'отгрузка: ответ сервера', schema: ShipmentItemSchema },
  { name: 'отгрузка: входной upsert', schema: ShipmentUpsertItemSchema },
] as const;

describe('финансовые поля живут в контракте с мобильным приложением', () => {
  for (const side of CONTRACT_SIDES) {
    for (const field of FINANCIAL_FIELDS) {
      it(`${side.name}: поле ${field} на месте`, () => {
        expect(Object.keys(side.schema.shape)).toContain(field);
      });
    }
  }

  it('поля есть на ОБЕИХ сторонах обмена одновременно', () => {
    // Отдельная проверка поверх поштучных: она называет инвариант целиком.
    // Поле, оставшееся только в ответе, но пропавшее из upsert, — это тихая
    // потеря на следующей же финализации.
    for (const field of FINANCIAL_FIELDS) {
      const present = CONTRACT_SIDES.filter((s) => field in s.schema.shape).map((s) => s.name);
      expect(present).toHaveLength(CONTRACT_SIDES.length);
    }
  });

  it('входные схемы принимают финансы и не теряют их при разборе', () => {
    // Наличие ключа мало: поле, у которого разбор выбрасывает значение,
    // ведёт себя ровно как отсутствующее.
    const item = {
      nameRaw: 'Кабель ВВГнг 3х2.5',
      qtyPlanned: '100',
      qtyActual: '100',
      unit: 'м',
      lineNo: 1,
      price: '82.5',
      vatRate: '22',
      vatSum: '1815',
    };

    const delivery = DeliveryUpsertItemSchema.parse(item);
    expect(delivery.price).toBe('82.5');
    expect(delivery.vatRate).toBe('22');
    expect(delivery.vatSum).toBe('1815');

    const shipment = ShipmentUpsertItemSchema.parse(item);
    expect(shipment.price).toBe('82.5');
    expect(shipment.vatRate).toBe('22');
    expect(shipment.vatSum).toBe('1815');
  });
});
