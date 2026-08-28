import { describe, it, expect } from 'vitest';
import {
  idempotencyKeyOf,
  replaceScopeInIdempotencyKey,
} from '../src/domain/sourceDocuments/bundle-key.js';
import { isBundleScopeUniqueViolation } from '../src/domain/sourceDocuments/site-transfer.js';

/**
 * Чистая часть переноса объекта — без БД.
 *
 * Главное, что здесь защищается: ключ пакета правится ПОДМЕНОЙ компонента, а не
 * пересборкой. Формат v2 несёт хеш раскладки файлов по зонам формы, которого в
 * source_bundles нет вовсе, — собери мы ключ заново из колонок, он молча стал бы
 * ключом v1, и повторная загрузка той же пачки перестала бы узнаваться.
 */

const SITE_A = '11111111-1111-1111-1111-111111111111';
const SITE_B = '22222222-2222-2222-2222-222222222222';

describe('replaceScopeInIdempotencyKey', () => {
  it('меняет объект в ключе v1, не трогая остальные компоненты', () => {
    const key = idempotencyKeyOf({
      siteId: SITE_A,
      direction: 'inbound',
      contractorId: null,
      recipientMolId: null,
      expectedDate: '2026-08-25',
      contentHash: 'abc123',
    });
    const moved = replaceScopeInIdempotencyKey(key, { siteId: SITE_B });
    expect(moved).toBe(
      idempotencyKeyOf({
        siteId: SITE_B,
        direction: 'inbound',
        contractorId: null,
        recipientMolId: null,
        expectedDate: '2026-08-25',
        contentHash: 'abc123',
      }),
    );
  });

  it('сохраняет версию v2 вместе с хешем раскладки по зонам', () => {
    const key = idempotencyKeyOf({
      siteId: SITE_A,
      direction: 'inbound',
      expectedDate: null,
      contentHash: 'abc123',
      modesHash: 'modes-hash',
    });
    expect(key.startsWith('v2|manual|')).toBe(true);
    const moved = replaceScopeInIdempotencyKey(key, { siteId: SITE_B })!;
    expect(moved.startsWith('v2|manual|')).toBe(true);
    expect(moved.endsWith('|modes-hash')).toBe(true);
    expect(moved.split('|')[2]).toBe(SITE_B);
  });

  it('пустой объект в ключе — законное значение, а не пропуск компонента', () => {
    const key = idempotencyKeyOf({
      siteId: SITE_A,
      direction: 'inbound',
      expectedDate: null,
      contentHash: 'abc123',
    });
    const moved = replaceScopeInIdempotencyKey(key, { siteId: null })!;
    expect(moved.split('|')).toHaveLength(key.split('|').length);
    expect(moved.split('|')[2]).toBe('');
  });

  it('меняет дату поставки, не трогая объект', () => {
    const key = idempotencyKeyOf({
      siteId: SITE_A,
      direction: 'inbound',
      expectedDate: '2026-08-25',
      contentHash: 'abc123',
    });
    const moved = replaceScopeInIdempotencyKey(key, { expectedDate: '2026-08-26' })!;
    expect(moved).toBe(
      idempotencyKeyOf({
        siteId: SITE_A,
        direction: 'inbound',
        expectedDate: '2026-08-26',
        contentHash: 'abc123',
      }),
    );
  });

  it('объект и дата в одном пересчёте дают ключ, который построил бы приём', () => {
    // Менеджер меняет и объект, и дату одним сохранением. Два независимых
    // пересчёта второй раз читали бы уже переписанную строку, поэтому компоненты
    // подменяются за один проход.
    const key = idempotencyKeyOf({
      siteId: SITE_A,
      direction: 'inbound',
      expectedDate: '2026-08-25',
      contentHash: 'abc123',
      modesHash: 'modes-hash',
    });
    const moved = replaceScopeInIdempotencyKey(key, {
      siteId: SITE_B,
      expectedDate: '2026-08-26',
    })!;
    expect(moved).toBe(
      idempotencyKeyOf({
        siteId: SITE_B,
        direction: 'inbound',
        expectedDate: '2026-08-26',
        contentHash: 'abc123',
        modesHash: 'modes-hash',
      }),
    );
  });

  it('снятая дата — пустой компонент, а не выпавший', () => {
    const key = idempotencyKeyOf({
      siteId: SITE_A,
      direction: 'inbound',
      expectedDate: '2026-08-25',
      contentHash: 'abc123',
    });
    const moved = replaceScopeInIdempotencyKey(key, { expectedDate: null })!;
    expect(moved.split('|')).toHaveLength(key.split('|').length);
    expect(moved.split('|')[6]).toBe('');
  });

  it('непереданный компонент остаётся прежним', () => {
    const key = idempotencyKeyOf({
      siteId: SITE_A,
      direction: 'inbound',
      expectedDate: '2026-08-25',
      contentHash: 'abc123',
    });
    expect(replaceScopeInIdempotencyKey(key, {})).toBe(key);
    expect(replaceScopeInIdempotencyKey(key, { siteId: SITE_B })!.split('|')[6]).toBe('2026-08-25');
  });

  it('ключ чужого формата не «чинится» — возвращается null', () => {
    // Иначе перенос собрал бы строку, которую не построит ни один канал приёма,
    // и повторная загрузка того же комплекта завела бы второй пакет.
    expect(replaceScopeInIdempotencyKey('legacy-key', { siteId: SITE_B })).toBeNull();
    expect(replaceScopeInIdempotencyKey('v1|manual|site|inbound', { siteId: SITE_B })).toBeNull();
  });
});

describe('isBundleScopeUniqueViolation', () => {
  it('узнаёт оба ограничения пакета: и хеш, и канонический ключ', () => {
    expect(
      isBundleScopeUniqueViolation({
        code: '23505',
        constraint: 'source_bundles_bundle_hash_unique',
      }),
    ).toBe(true);
    expect(
      isBundleScopeUniqueViolation({
        code: '23505',
        constraint: 'source_bundles_idempotency_key_unique',
      }),
    ).toBe(true);
  });

  it('видит ошибку и внутри обёртки drizzle', () => {
    // Драйверную ошибку заворачивает DrizzleQueryError — на верхнем объекте ни
    // кода, ни имени ограничения нет.
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: { code: '23505', constraint: 'source_bundles_idempotency_key_unique' },
    });
    expect(isBundleScopeUniqueViolation(wrapped)).toBe(true);
  });

  it('чужие нарушения уникальности не перехватывает', () => {
    expect(
      isBundleScopeUniqueViolation({ code: '23505', constraint: 'counterparties_inn_unique' }),
    ).toBe(false);
    expect(isBundleScopeUniqueViolation({ code: '23503' })).toBe(false);
    expect(isBundleScopeUniqueViolation(new Error('boom'))).toBe(false);
  });
});
