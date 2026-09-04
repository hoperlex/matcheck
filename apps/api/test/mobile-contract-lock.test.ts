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
  DeliverySchema,
  OperationSourceDocumentSchema,
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

describe('сводка сверки документа не ломает контракт с мобильным приложением', () => {
  /**
   * Мобильный клиент `sourceDocuments` вообще не объявляет и разбирает JSON с
   * ignoreUnknownKeys, а через /sync это поле не уходит. Здесь закрепляется то,
   * на чём держится безопасность добавления: сводка ОПЦИОНАЛЬНА на всех уровнях.
   *
   * Оговорка: TypeScript-тест не может доказать поведение Kotlin-клиента —
   * это проверяется отдельно, на самом приложении.
   */
  const documentBase = {
    id: '00000000-0000-0000-0000-0000000000d1',
    kind: 'upd' as const,
    status: 'parsed' as const,
    docNumber: '1282',
    docDate: '2026-09-01',
    expectedDate: null,
    totalSum: '185909.16',
    vatSum: '33524.60',
    linked: true,
  };

  it('поле validation объявлено в схеме документа операции', () => {
    expect(Object.keys(OperationSourceDocumentSchema.shape)).toContain('validation');
  });

  it('документ БЕЗ сводки разбирается — иначе сломались бы все здоровые', () => {
    const parsed = OperationSourceDocumentSchema.parse(documentBase);
    expect('validation' in parsed).toBe(false);
  });

  it('пустые массивы в сводке — законное состояние', () => {
    // Так выглядит устаревший снимок: текст есть, подсветки нет.
    const parsed = OperationSourceDocumentSchema.parse({
      ...documentBase,
      validation: {
        hasMismatch: true,
        failedChecks: [],
        warnings: [],
        problemItemIds: [],
      },
    });
    expect(parsed.validation?.problemItemIds).toEqual([]);
  });

  it('sourceDocuments у приёмки остаётся необязательным: инвариант /sync', () => {
    // /sync снимок этого поля не собирает вовсе. Сделай его обязательным — и
    // офлайн-снимок перестанет проходить схему, а карточка на планшете упадёт
    // не на новом поле, а на его отсутствии.
    expect(DeliverySchema.shape.sourceDocuments.isOptional()).toBe(true);
  });
});
