/**
 * Хеш содержимого приёмки для 1С.
 *
 * Главный тест — классификация: каждое поле ответа стоит ровно в одном из
 * списков (ядро / исключено с причиной). Новое поле без решения роняет тест —
 * иначе 1С начала бы сопоставлять по полю, исправление которого не возвращает
 * приёмку в очередь.
 */
import { describe, expect, it } from 'vitest';
import type { OnecDelivery } from '@matcheck/contracts';
import {
  CORE_PATHS,
  computeContentHash,
  EXCLUDED_PATHS,
  hashCore,
  HASH_VERSION,
} from '../src/domain/onec/content-hash.js';
import { buildDeliveryBody, type RawBundle } from '../src/domain/onec/export-payload.js';
import { DOC_LINKED, fullBundle, item } from './helpers/onec-fixture.js';

const SNAP = '2026-11-11T10:00:00.000000Z';
const hashOf = (bundle: RawBundle, snapshotAt = SNAP) =>
  computeContentHash(buildDeliveryBody(bundle, snapshotAt));

const CLASSIFIED = new Set([...CORE_PATHS, ...Object.keys(EXCLUDED_PATHS)]);

/** Листовые пути ответа; классифицированный контейнер — тоже лист. */
function leafPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (prefix && CLASSIFIED.has(prefix)) {
    out.add(prefix);
    return;
  }
  // null на месте контейнера (документ у группы nodoc) и пустой массив — не
  // поля: их потомков покрывает заполненная часть образца.
  const isContainer = [...CLASSIFIED].some(
    (p) => p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[]`),
  );
  if (value === null && isContainer) return;
  if (Array.isArray(value) && value.length === 0 && isContainer) return;
  if (value === null || typeof value !== 'object') {
    out.add(prefix);
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      out.add(prefix);
      return;
    }
    for (const v of value) leafPaths(v, `${prefix}[]`, out);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

function fullResponse(): OnecDelivery {
  const body = buildDeliveryBody(fullBundle(), SNAP);
  return {
    ...body,
    contentHash: computeContentHash(body),
    hashVersion: HASH_VERSION,
    export: {
      state: 'exported',
      exportedAt: SNAP,
      exportedHash: 'a'.repeat(64),
      queueReason: 'changed',
      lastError: 'нет номенклатуры',
      lastErrorAt: SNAP,
    },
  };
}

describe('классификация полей ответа', () => {
  const leaves = new Set<string>();
  leafPaths(fullResponse(), '', leaves);

  it('каждое поле ответа — в ядре или исключено с причиной', () => {
    const unclassified = [...leaves].filter((p) => !CLASSIFIED.has(p));
    expect(unclassified).toEqual([]);
  });

  it('ни одно поле не стоит в обоих списках', () => {
    const both = CORE_PATHS.filter((p) => p in EXCLUDED_PATHS);
    expect(both).toEqual([]);
  });

  it('в списках нет путей, которых в ответе уже нет', () => {
    const stale = [...CLASSIFIED].filter((p) => !leaves.has(p));
    expect(stale).toEqual([]);
  });
});

describe('инварианты хеша', () => {
  const base = hashOf(fullBundle());

  it('время чтения хеш не меняет', () => {
    expect(hashOf(fullBundle(), '2030-01-01T00:00:00.000000Z')).toBe(base);
  });

  it('перестановка строк — даже с равными номерами и разным НДС — хеш не меняет', () => {
    const a = fullBundle();
    a.items = [
      item({ lineNo: 1, nameRaw: 'Х', vatSum: '1.00' }),
      item({ lineNo: 1, nameRaw: 'Х', vatSum: '2.00' }),
    ];
    const b = fullBundle();
    b.items = [...a.items].reverse();
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it('переименования в справочниках хеш не меняют', () => {
    const b = fullBundle();
    b.header.siteName = 'Новое имя объекта';
    b.header.supplier!.name = 'ПОСТАВЩИК АО';
    b.header.contractor!.name = 'Подрядчик (переименован)';
    b.contracts[0]!.name = 'Другое имя договора';
    b.items[0]!.material!.name = 'Арматура 12 мм';
    b.sharedWith = new Map();
    b.duplicates = new Map();
    expect(hashOf(b)).toBe(base);
  });

  it.each<[string, (b: RawBundle) => void]>([
    ['код объекта ФОТ', (b) => void (b.header.fotSiteId = 43)],
    ['GUID контрагента договора', (b) => void (b.contracts[0]!.counterpartyOnecId = 'x')],
    ['признак документа', (b) => void (b.links[0]!.purpose = 'tolling_act')],
    ['получатель документа', (b) => void (b.links[0]!.ownRecipient = false)],
    ['НДС строки', (b) => void (b.items[0]!.vatSum = '19499.99')],
    ['цена строки', (b) => void (b.items[0]!.price = '65000.0100')],
    ['номер строки', (b) => void (b.items[0]!.lineNo = 7)],
    ['ИНН поставщика документа', (b) => void (b.documents.get(DOC_LINKED)!.supplier.inn = '5000000009')],
    ['отвязка УПД из ЭДО', (b) => void b.edo.pop()],
    ['другая УПД из ЭДО (sha256)', (b) => void (b.edo[0]!.sha256 = 'c'.repeat(64))],
    ['отвязка документа (строки стали nodoc)', (b) => void b.links.splice(0, 1)],
    ['пометка — нет; удаление строки', (b) => void b.items.pop()],
  ])('меняет хеш: %s', (_, mutate) => {
    const b = fullBundle();
    mutate(b);
    expect(hashOf(b)).not.toBe(base);
  });

  it('id привязки ЭДО в ядро не входит (перепривязка той же УПД)', () => {
    const b = fullBundle();
    b.edo[0]!.matchId = 'd0000000-0000-4000-8000-0000000000ff';
    expect(hashOf(b)).toBe(base);
  });

  it('ядро не содержит названий и производных сумм', () => {
    const core = JSON.stringify(hashCore(buildDeliveryBody(fullBundle(), SNAP)));
    expect(core).not.toContain('ЗИЛ, корпус 33');
    expect(core).not.toContain('sumWithVat');
    expect(core).not.toContain('snapshotAt');
  });
});
