/**
 * Keyset-пагинация /sync: токен и граница страницы по машине.
 *
 * Что было сломано. Клиент, получив полную страницу, двигал курсор на серверный
 * `cursor` (момент начала выборки) и шёл дальше с ним. Но страница
 * отсортирована по `updated_at DESC`, и всё, что старше последней отданной
 * строки, оказывалось старше нового курсора — во вторую страницу такие записи не
 * попадали никогда. Хвост дельты исчезал.
 *
 * Здесь проверяется чистая логика: кодирование позиции и обрезка страницы по
 * границе машины. Поведение самого роута (снимок, порядок, продолжение) —
 * в интеграционном наборе.
 */
import { describe, expect, it } from 'vitest';
import {
  decodePageToken,
  encodePageToken,
  trimPageToGroupBoundary,
} from '../src/domain/sourceDocuments/sync-page-token.js';

describe('токен страницы', () => {
  it('переживает кодирование и разбор', () => {
    const token = {
      snapshot: '2026-08-15T10:00:00.000Z',
      updatedAt: '2026-08-15T09:59:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
    };
    expect(decodePageToken(encodePageToken(token))).toEqual(token);
  });

  it('непрозрачен: в открытом виде позиции не видно', () => {
    const raw = encodePageToken({
      snapshot: '2026-08-15T10:00:00.000Z',
      updatedAt: '2026-08-15T09:59:00.000Z',
      id: '11111111-1111-1111-1111-111111111111',
    });
    expect(raw).not.toContain('2026-08-15');
    expect(raw).not.toContain('1111');
  });

  it('мусор не роняет запрос, а начинает листание сначала', () => {
    // Токен мог остаться от прошлой версии сервера или повредиться при записи.
    // Ошибка запроса тут была бы хуже: планшет не смог бы синхронизироваться
    // вовсе, пока кто-то не почистит его хранилище.
    expect(decodePageToken('не-base64')).toBeNull();
    expect(decodePageToken(Buffer.from('{}', 'utf8').toString('base64url'))).toBeNull();
    expect(decodePageToken(undefined)).toBeNull();
    expect(
      decodePageToken(
        Buffer.from(JSON.stringify({ snapshot: 'вчера', updatedAt: 'x', id: 'y' })).toString(
          'base64url',
        ),
      ),
    ).toBeNull();
  });
});

describe('граница страницы не режет машину', () => {
  const row = (id: string, groupId: string | null) => ({ id, groupId });

  it('страница короче лимита отдаётся целиком', () => {
    const rows = [row('a', null), row('b', null)];
    expect(trimPageToGroupBoundary(rows, 5)).toEqual({ page: rows, hasMore: false });
  });

  it('одиночные документы режутся ровно по лимиту', () => {
    const rows = [row('a', null), row('b', null), row('c', null)];
    const { page, hasMore } = trimPageToGroupBoundary(rows, 2);
    expect(page.map((r) => r.id)).toEqual(['a', 'b']);
    expect(hasMore).toBe(true);
  });

  it('машина, попавшая на границу, целиком переносится на следующую страницу', () => {
    // Половина машины на планшете — это неполный состав материалов и вечное
    // «состав изменился» на форме.
    const rows = [row('a', null), row('b', 'g1'), row('c', 'g1')];
    const { page, hasMore } = trimPageToGroupBoundary(rows, 2);
    expect(page.map((r) => r.id)).toEqual(['a']);
    expect(hasMore).toBe(true);
  });

  it('машина, целиком уместившаяся до границы, не переносится', () => {
    const rows = [row('a', 'g1'), row('b', 'g1'), row('c', null)];
    const { page, hasMore } = trimPageToGroupBoundary(rows, 2);
    expect(page.map((r) => r.id)).toEqual(['a', 'b']);
    expect(hasMore).toBe(true);
  });

  it('страница из одной машины отдаётся как есть: резать нечего', () => {
    // Целостность важнее ровного размера страницы. Возможно только при машине
    // больше страницы, чего в реальных пачках не бывает.
    const rows = [row('a', 'g1'), row('b', 'g1'), row('c', 'g1')];
    const { page, hasMore } = trimPageToGroupBoundary(rows, 2);
    expect(page.map((r) => r.id)).toEqual(['a', 'b']);
    expect(hasMore).toBe(true);
  });

  it('соседние машины разделяются по своей границе', () => {
    const rows = [row('a', 'g1'), row('b', 'g1'), row('c', 'g2'), row('d', 'g2')];
    const { page } = trimPageToGroupBoundary(rows, 3);
    expect(page.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
