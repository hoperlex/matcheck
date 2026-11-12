import { describe, expect, it } from 'vitest';
import {
  findDroppedOrigins,
  hasNameMatchCandidates,
  matchItemsToDocumentsByName,
  resolveItemOrigins,
  resolveItemOriginsWithStats,
  type DocumentItemForMatch,
  type ExistingItemRow,
  type IncomingItem,
  type ItemOrigin,
} from '../src/domain/operations/item-origin.js';

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';
const ITEM_A1 = 'aaaaaaa1-1111-4111-8111-111111111111';
const ITEM_A2 = 'aaaaaaa2-1111-4111-8111-111111111111';

function existing(over: Partial<ExistingItemRow> & { id: string }): ExistingItemRow {
  return {
    nameRaw: 'Арматура А500С 12мм',
    unit: 'т',
    lineNo: 1,
    sourceDocumentId: DOC_A,
    sourceDocumentItemId: ITEM_A1,
    ...over,
  };
}

function incoming(over: Partial<IncomingItem> = {}): IncomingItem {
  return { nameRaw: 'Арматура А500С 12мм', unit: 'т', lineNo: 1, ...over };
}

describe('resolveItemOrigins', () => {
  it('сохраняет происхождение строки, найденной по id, даже когда клиент его не прислал', () => {
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('игнорирует попытку клиента переписать происхождение существующей строки', () => {
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1', sourceDocumentId: DOC_B, sourceDocumentItemId: null })],
      linkedDocumentIds: [DOC_A, DOC_B],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('сохраняет происхождение отвязанного документа', () => {
    // Документа больше нет в linkedDocumentIds — связь сняли, но откуда
    // приехала строка, мы по-прежнему знаем.
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' })],
      linkedDocumentIds: [],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('новая строка получает присланное происхождение, если документ привязан', () => {
    const [origin] = resolveItemOrigins({
      existing: [],
      incoming: [incoming({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('отбрасывает происхождение из документа, не привязанного к приёмке', () => {
    const [origin] = resolveItemOrigins({
      existing: [],
      incoming: [incoming({ sourceDocumentId: DOC_B })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('строка, внесённая руками, остаётся без происхождения', () => {
    const [origin] = resolveItemOrigins({
      existing: [],
      incoming: [incoming({ nameRaw: 'Ветошь' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('наследует происхождение по названию и номеру строки, когда id потерян', () => {
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: undefined, nameRaw: '  арматура   а500с 12ММ ' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('не угадывает, когда одинаковых строк несколько', () => {
    // Две одинаковые позиции из разных УПД на одном номере строки — ровно тот
    // случай, где сопоставление по названию соврало бы.
    const rows = [
      existing({ id: 'row-1', sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 }),
      existing({ id: 'row-2', sourceDocumentId: DOC_B, sourceDocumentItemId: ITEM_A2 }),
    ];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming(), incoming()],
      linkedDocumentIds: [DOC_A, DOC_B],
    });

    expect(origins).toEqual([
      { sourceDocumentId: null, sourceDocumentItemId: null },
      { sourceDocumentId: null, sourceDocumentItemId: null },
    ]);
  });

  it('не отдаёт одно происхождение двум строкам', () => {
    const rows = [existing({ id: 'row-1' })];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' }), incoming()],
      linkedDocumentIds: [DOC_A],
    });

    expect(origins[0]).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
    expect(origins[1]).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('различает строки по номеру: разные позиции одного названия не путаются', () => {
    const rows = [
      existing({ id: 'row-1', lineNo: 1, sourceDocumentItemId: ITEM_A1 }),
      existing({ id: 'row-2', lineNo: 2, sourceDocumentItemId: ITEM_A2 }),
    ];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ lineNo: 2 }), incoming({ lineNo: 1 })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origins[0]?.sourceDocumentItemId).toBe(ITEM_A2);
    expect(origins[1]?.sourceDocumentItemId).toBe(ITEM_A1);
  });

  it('порядок результата совпадает с порядком входа', () => {
    const rows = [existing({ id: 'row-1', nameRaw: 'Первая' })];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({ nameRaw: 'Другая' }),
        incoming({ id: 'row-1', nameRaw: 'Первая' }),
        incoming({ nameRaw: 'Третья', sourceDocumentId: DOC_A }),
      ],
      linkedDocumentIds: [DOC_A],
    });

    expect(origins).toHaveLength(3);
    expect(origins[0]).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
    expect(origins[1]?.sourceDocumentId).toBe(DOC_A);
    expect(origins[2]).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: null });
  });
});

describe('resolveItemOrigins: ссылка на позицию документа', () => {
  it('переименованная строка с устаревшим id сохраняет привязку', () => {
    // Гонка, ради которой шаг и вводился: карточка открыта до сохранения с
    // планшета (id пересозданы), менеджер исправил опечатку распознавания.
    // Ключ с названием здесь промахивается по определению.
    const rows = [existing({ id: 'row-fresh' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({
          id: 'row-stale',
          nameRaw: 'Арматура А500С 12 мм',
          sourceDocumentItemId: ITEM_A1,
        }),
      ],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('не угадывает, когда одну позицию документа заявили две строки', () => {
    const rows = [existing({ id: 'row-1' })];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({ nameRaw: 'Первая половина', sourceDocumentItemId: ITEM_A1 }),
        incoming({ nameRaw: 'Вторая половина', sourceDocumentItemId: ITEM_A1 }),
      ],
      linkedDocumentIds: [DOC_A],
    });

    // Ни одна не наследует атрибуцию строки из БД: ключ неоднозначен. Шаг 3
    // тоже молчит — сам по себе sourceDocumentItemId заявкой не является,
    // происхождение новой строки задаёт sourceDocumentId.
    expect(origins[0]).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
    expect(origins[1]).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('не угадывает, когда в приёмке две строки с одной позицией документа', () => {
    const rows = [
      existing({ id: 'row-1', lineNo: 1, sourceDocumentItemId: ITEM_A1 }),
      existing({ id: 'row-2', lineNo: 2, sourceDocumentItemId: ITEM_A1 }),
    ];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ nameRaw: 'Переименовали', lineNo: 9, sourceDocumentItemId: ITEM_A1 })],
      linkedDocumentIds: [],
    });

    // Документ не привязан — шаг 3 присланное отбрасывает, и промах шага 1.5
    // виден в чистом виде.
    expect(origin).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('сопоставление по id сильнее ссылки на позицию документа', () => {
    const rows = [
      existing({ id: 'row-1', sourceDocumentItemId: ITEM_A1 }),
      existing({ id: 'row-2', lineNo: 2, sourceDocumentItemId: ITEM_A2 }),
    ];

    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [
        // Клиент прислал живой id одной строки и ссылку на позицию другой.
        incoming({ id: 'row-1', sourceDocumentItemId: ITEM_A2 }),
        incoming({ id: undefined, lineNo: 2, sourceDocumentItemId: ITEM_A2 }),
      ],
      linkedDocumentIds: [DOC_A],
    });

    expect(origins[0]?.sourceDocumentItemId).toBe(ITEM_A1);
    expect(origins[1]?.sourceDocumentItemId).toBe(ITEM_A2);
  });

  it('строка без ссылки на позицию по-прежнему ловится названием и номером', () => {
    const rows = [existing({ id: 'row-1', sourceDocumentItemId: null })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: undefined, sourceDocumentItemId: null })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: null });
  });
});

describe('resolveItemOrigins: строка, у которой привязки не было', () => {
  it('принимает присланное происхождение, когда в БД пусто', () => {
    // Случай приёмки 14289: строку завёл планшет без происхождения, документ к
    // приёмке привязан. Пустое наследство не должно перекрывать шаг 3, иначе
    // привязку такой строке не вернуть уже никогда.
    const rows = [existing({ id: 'row-1', sourceDocumentId: null, sourceDocumentItemId: null })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1', sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('не принимает документ, не привязанный к приёмке', () => {
    const rows = [existing({ id: 'row-1', sourceDocumentId: null, sourceDocumentItemId: null })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1', sourceDocumentId: DOC_B })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('оставляет строку пустой, когда клиент происхождение не прислал', () => {
    const rows = [existing({ id: 'row-1', sourceDocumentId: null, sourceDocumentItemId: null })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: null, sourceDocumentItemId: null });
  });

  it('непустую привязку по-прежнему не даёт переписать', () => {
    // Обратная сторона правки: ослабло только условие «наследство пустое»,
    // защита существующей атрибуции осталась прежней.
    const rows = [existing({ id: 'row-1' })];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1', sourceDocumentId: DOC_B, sourceDocumentItemId: null })],
      linkedDocumentIds: [DOC_A, DOC_B],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });

  it('восстанавливает привязку строке с исправленной единицей измерения', () => {
    // Единица входит в ключ запасного сопоставления, поэтому «шт» против «м³»
    // промахивается мимо шага 2 — выручает присланное происхождение.
    const rows = [
      existing({ id: 'row-1', unit: 'м³', sourceDocumentId: null, sourceDocumentItemId: null }),
    ];

    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({
          id: 'row-1',
          unit: 'шт',
          sourceDocumentId: DOC_A,
          sourceDocumentItemId: ITEM_A1,
        }),
      ],
      linkedDocumentIds: [DOC_A],
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 });
  });
});

describe('findDroppedOrigins', () => {
  it('молчит, пока привязки сохранены', () => {
    const rows = [existing({ id: 'row-1' })];
    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(findDroppedOrigins({ existing: rows, origins })).toEqual([]);
  });

  it('называет позицию документа, привязка к которой исчезла', () => {
    const rows = [existing({ id: 'row-1', nameRaw: 'погворгрнт' })];
    // Клиент прислал переименованную строку без id и без ссылки — все три шага
    // промахиваются, атрибуция теряется.
    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: undefined, nameRaw: 'пог/погрузчик' })],
      linkedDocumentIds: [DOC_A],
    });

    expect(findDroppedOrigins({ existing: rows, origins })).toEqual([
      { sourceDocumentItemId: ITEM_A1, lineNo: 1, nameRaw: 'погворгрнт' },
    ]);
  });
});

/**
 * Шаг 2б: строки планшета, которые не узнаются по id, приходят без
 * происхождения и с «шт» вместо единицы документа. Боевые случаи — приёмки
 * 24687 (единица) и 19525 (сдвиг номеров после удалённой строки).
 */
describe('resolveItemOrigins: шаг 2б — только название (планшет)', () => {
  const EMPTY: ItemOrigin = { sourceDocumentId: null, sourceDocumentItemId: null };
  const sdi = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;

  /** Приёмка из строк документа в «м2», как её сохранил 1 Этап. */
  function stage1Rows(names: string[]): ExistingItemRow[] {
    return names.map((nameRaw, idx) =>
      existing({
        id: `row-${idx + 1}`,
        nameRaw,
        unit: 'м2',
        lineNo: idx + 1,
        sourceDocumentId: DOC_A,
        sourceDocumentItemId: sdi(idx + 1),
      }),
    );
  }

  /** То, что присылает 2 Этап из черновика: чужие id, «шт», без происхождения. */
  function stage2Incoming(names: string[]): IncomingItem[] {
    return names.map((nameRaw, idx) =>
      incoming({ id: `stale-${idx + 1}`, nameRaw, unit: 'шт', lineNo: idx + 1 }),
    );
  }

  it('случай 24687: «шт» вместо «м2» — привязка унаследована по названию', () => {
    const names = ['Стеклопакет 880х1448 - 8 шт.', 'Стеклопакет 780х1348 - 4 шт.'];
    const origins = resolveItemOrigins({
      existing: stage1Rows(names),
      incoming: stage2Incoming(names),
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });

    expect(origins).toEqual([
      { sourceDocumentId: DOC_A, sourceDocumentItemId: sdi(1) },
      { sourceDocumentId: DOC_A, sourceDocumentItemId: sdi(2) },
    ]);
  });

  it('без флага поведение прежнее: те же строки остаются без привязки', () => {
    const names = ['Стеклопакет 880х1448 - 8 шт.', 'Стеклопакет 780х1348 - 4 шт.'];
    const origins = resolveItemOrigins({
      existing: stage1Rows(names),
      incoming: stage2Incoming(names),
      linkedDocumentIds: [DOC_A],
    });

    expect(origins).toEqual([EMPTY, EMPTY]);
  });

  it('случай 19525: удалена строка 4 из 16 — остальные наследуют свои позиции', () => {
    const names = Array.from({ length: 16 }, (_, i) => `Решетка АРН ${i + 1}`);
    const rows = stage1Rows(names).map((r) => ({ ...r, unit: 'шт' }));
    const kept = names.filter((_, i) => i !== 3);

    const withFlag = resolveItemOrigins({
      existing: rows,
      incoming: stage2Incoming(kept),
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });
    const expected = names
      .map((_, i) => ({ sourceDocumentId: DOC_A, sourceDocumentItemId: sdi(i + 1) }))
      .filter((_, i) => i !== 3);
    expect(withFlag).toEqual(expected);
    // Позиция удалённой строки не досталась никому.
    expect(withFlag.map((o) => o.sourceDocumentItemId)).not.toContain(sdi(4));

    // Без флага — как на бою: строки до удалённой целы, после неё отвязаны.
    const withoutFlag = resolveItemOrigins({
      existing: rows,
      incoming: stage2Incoming(kept),
      linkedDocumentIds: [DOC_A],
    });
    expect(withoutFlag.slice(0, 3)).toEqual(expected.slice(0, 3));
    expect(withoutFlag.slice(3)).toEqual(Array(12).fill(EMPTY));
  });

  it('совпавшая полным ключом строка забирает позицию, одноимённая — нет', () => {
    const rows = [existing({ id: 'row-1', nameRaw: 'Альфа', unit: 'т', lineNo: 1 })];
    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({ id: 'stale-1', nameRaw: 'Альфа', unit: 'т', lineNo: 1 }),
        incoming({ id: 'stale-2', nameRaw: 'Альфа', unit: 'шт', lineNo: 2 }),
      ],
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });

    expect(origins).toEqual([{ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A1 }, EMPTY]);
  });

  it('две строки БД с разными названиями и общей позицией — не получает никто, в любом порядке', () => {
    const rows = [
      existing({
        id: 'row-1',
        nameRaw: 'Альфа',
        unit: 'м2',
        lineNo: 1,
        sourceDocumentItemId: ITEM_A1,
      }),
      existing({
        id: 'row-2',
        nameRaw: 'Бета',
        unit: 'м2',
        lineNo: 2,
        sourceDocumentItemId: ITEM_A1,
      }),
    ];
    const a = incoming({ id: 'stale-1', nameRaw: 'Альфа', unit: 'шт', lineNo: 1 });
    const b = incoming({ id: 'stale-2', nameRaw: 'Бета', unit: 'шт', lineNo: 2 });

    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const { origins, nameMatch } = resolveItemOriginsWithStats({
        existing: rows,
        incoming: order,
        linkedDocumentIds: [DOC_A],
        nameOnlyFallback: true,
      });
      expect(origins).toEqual([EMPTY, EMPTY]);
      expect(nameMatch).toEqual({ matched: 0, ambiguous: 2 });
    }
  });

  it('позиция, заявленная другой строкой запроса, не выдаётся', () => {
    // Две строки заявили одну позицию — шаг 1.5 неоднозначен и молчит, но
    // позиция уже «занята» заявками, и слабый шаг её не отдаёт.
    const rows = [existing({ id: 'row-1', nameRaw: 'Альфа', unit: 'м2' })];
    const origins = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({ id: 'stale-1', nameRaw: 'Альфа', unit: 'шт', lineNo: 1 }),
        incoming({ nameRaw: 'Икс', lineNo: 2, sourceDocumentItemId: ITEM_A1 }),
        incoming({ nameRaw: 'Игрек', lineNo: 3, sourceDocumentItemId: ITEM_A1 }),
      ],
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });

    expect(origins[0]).toEqual(EMPTY);
  });

  it('строка с присланным документом идёт шагом 3, а не по названию', () => {
    const rows = [existing({ id: 'row-1', nameRaw: 'Альфа', unit: 'м2' })];
    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [
        incoming({
          id: 'stale-1',
          nameRaw: 'Альфа',
          unit: 'шт',
          sourceDocumentId: DOC_A,
          sourceDocumentItemId: ITEM_A2,
        }),
      ],
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });

    expect(origin).toEqual({ sourceDocumentId: DOC_A, sourceDocumentItemId: ITEM_A2 });
  });

  it('строка БД без происхождения — не кандидат', () => {
    const rows = [
      existing({
        id: 'row-1',
        nameRaw: 'Альфа',
        unit: 'м2',
        sourceDocumentId: null,
        sourceDocumentItemId: null,
      }),
    ];
    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'stale-1', nameRaw: 'Альфа', unit: 'шт' })],
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });

    expect(origin).toEqual(EMPTY);
  });

  it('строку, опознанную по id без происхождения, не «чинит» побочно', () => {
    const rows = [
      existing({
        id: 'row-1',
        nameRaw: 'Альфа',
        sourceDocumentId: null,
        sourceDocumentItemId: null,
      }),
      existing({ id: 'row-2', nameRaw: 'Альфа', unit: 'м2', lineNo: 2 }),
    ];
    const [origin] = resolveItemOrigins({
      existing: rows,
      incoming: [incoming({ id: 'row-1', nameRaw: 'Альфа', unit: 'шт' })],
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });

    expect(origin).toEqual(EMPTY);
  });

  it('одинаковые названия в БД — неоднозначно', () => {
    const rows = [
      existing({
        id: 'row-1',
        nameRaw: 'Альфа',
        unit: 'м2',
        lineNo: 1,
        sourceDocumentItemId: ITEM_A1,
      }),
      existing({
        id: 'row-2',
        nameRaw: 'Альфа',
        unit: 'м2',
        lineNo: 2,
        sourceDocumentItemId: ITEM_A2,
      }),
    ];
    const { origins, nameMatch } = resolveItemOriginsWithStats({
      existing: rows,
      incoming: [incoming({ id: 'stale-1', nameRaw: 'Альфа', unit: 'шт', lineNo: 1 })],
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });

    expect(origins).toEqual([EMPTY]);
    expect(nameMatch).toEqual({ matched: 0, ambiguous: 1 });
  });

  it('результат не зависит от порядка строк', () => {
    const names = Array.from({ length: 6 }, (_, i) => `Позиция ${i + 1}`);
    const rows = stage1Rows(names);
    const forward = stage2Incoming(names);
    const backward = [...forward].reverse();

    const a = resolveItemOrigins({
      existing: rows,
      incoming: forward,
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });
    const b = resolveItemOrigins({
      existing: rows,
      incoming: backward,
      linkedDocumentIds: [DOC_A],
      nameOnlyFallback: true,
    });
    expect([...b].reverse()).toEqual(a);
  });

  it('при выключенном флаге результат совпадает со старым на всех случаях', () => {
    const cases: Parameters<typeof resolveItemOrigins>[0][] = [
      {
        existing: stage1Rows(['Альфа', 'Бета']),
        incoming: stage2Incoming(['Альфа', 'Бета']),
        linkedDocumentIds: [DOC_A],
      },
      {
        existing: [existing({ id: 'row-1', nameRaw: 'Альфа', unit: 'т' })],
        incoming: [
          incoming({ id: 'stale-1', nameRaw: 'Альфа', unit: 'т' }),
          incoming({ id: 'stale-2', nameRaw: 'Альфа', unit: 'шт', lineNo: 2 }),
        ],
        linkedDocumentIds: [DOC_A],
      },
    ];
    for (const c of cases) {
      const legacy = resolveItemOrigins(c);
      const off = resolveItemOrigins({ ...c, nameOnlyFallback: false });
      expect(off).toEqual(legacy);
      expect(resolveItemOriginsWithStats(c).nameMatch).toEqual({ matched: 0, ambiguous: 0 });
    }
  });
});

describe('matchItemsToDocumentsByName (создание операции)', () => {
  const EMPTY: ItemOrigin = { sourceDocumentId: null, sourceDocumentItemId: null };
  const D1 = 'dddddddd-0000-4000-8000-000000000001';
  const D2 = 'dddddddd-0000-4000-8000-000000000002';
  const doc = (id: string, nameRaw: string, sourceDocumentId = DOC_A): DocumentItemForMatch => ({
    id,
    sourceDocumentId,
    nameRaw,
  });

  it('уникальное название — позиция нужного документа', () => {
    const res = matchItemsToDocumentsByName({
      incoming: [{ nameRaw: 'Альфа' }, { nameRaw: 'Бета' }],
      origins: [EMPTY, EMPTY],
      documentItems: [doc(D1, 'Альфа'), doc(D2, 'Бета', DOC_B)],
    });

    expect(res.origins).toEqual([
      { sourceDocumentId: DOC_A, sourceDocumentItemId: D1 },
      { sourceDocumentId: DOC_B, sourceDocumentItemId: D2 },
    ]);
    expect(res.matched).toBe(2);
  });

  it('одно название в двух УПД — неоднозначно', () => {
    const res = matchItemsToDocumentsByName({
      incoming: [{ nameRaw: 'Альфа' }],
      origins: [EMPTY],
      documentItems: [doc(D1, 'Альфа'), doc(D2, 'Альфа', DOC_B)],
    });

    expect(res.origins).toEqual([EMPTY]);
    expect(res.ambiguous).toBe(1);
  });

  it('ручная одноимённая строка рядом со строкой, у которой документ без позиции, — без привязки', () => {
    const res = matchItemsToDocumentsByName({
      incoming: [{ nameRaw: 'Альфа', sourceDocumentId: DOC_A }, { nameRaw: 'Альфа' }],
      origins: [{ sourceDocumentId: DOC_A, sourceDocumentItemId: null }, EMPTY],
      documentItems: [doc(D1, 'Альфа')],
    });

    expect(res.origins).toEqual([{ sourceDocumentId: DOC_A, sourceDocumentItemId: null }, EMPTY]);
    expect(res.matched).toBe(0);
  });

  it('позиция, уже выданная другой строке, второй раз не выдаётся', () => {
    const res = matchItemsToDocumentsByName({
      incoming: [
        { nameRaw: 'Другое', sourceDocumentId: DOC_A, sourceDocumentItemId: D1 },
        { nameRaw: 'Альфа' },
      ],
      origins: [{ sourceDocumentId: DOC_A, sourceDocumentItemId: D1 }, EMPTY],
      documentItems: [doc(D1, 'Альфа')],
    });

    expect(res.origins[1]).toEqual(EMPTY);
  });

  it('присланный непривязанный документ не «исправляем»', () => {
    const res = matchItemsToDocumentsByName({
      incoming: [{ nameRaw: 'Альфа', sourceDocumentId: DOC_B }],
      origins: [EMPTY],
      documentItems: [doc(D1, 'Альфа')],
    });

    expect(res.origins).toEqual([EMPTY]);
  });

  it('название без пары в документе — ручная строка, не неоднозначность', () => {
    const res = matchItemsToDocumentsByName({
      incoming: [{ nameRaw: 'Своё' }],
      origins: [EMPTY],
      documentItems: [doc(D1, 'Альфа')],
    });

    expect(res).toEqual({ origins: [EMPTY], matched: 0, ambiguous: 0 });
  });

  it('hasNameMatchCandidates: только строки без документа и без заявки на него', () => {
    expect(
      hasNameMatchCandidates({
        incoming: [{ sourceDocumentId: DOC_A }],
        origins: [{ sourceDocumentId: DOC_A, sourceDocumentItemId: null }],
      }),
    ).toBe(false);
    expect(
      hasNameMatchCandidates({ incoming: [{ sourceDocumentId: null }], origins: [EMPTY] }),
    ).toBe(true);
  });
});
