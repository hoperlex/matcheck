import { describe, expect, it } from 'vitest';
import { isPendingRow, pendingAsRow, pendingStateOf } from './pendingRow';

/**
 * Принятый файл как строка списка документов.
 *
 * Главное свойство: строка должна выглядеть ровно как уже существующий вид
 * «документ в очереди» — статус `queued` и имя файла в originalFilename. Тогда
 * таблица рисует её штатными средствами, без единой новой колонки: тег «в
 * очереди» и имя файла курсивом в колонке «№» уже реализованы.
 *
 * Второе свойство: id с префиксом `registry:` — по нему строка файла отличается
 * от строки появившегося по нему документа, иначе React переиспользовал бы
 * DOM-узел с чужим состоянием.
 */
const file = {
  key: 'registry:11111111-1111-1111-1111-111111111111',
  itemId: '11111111-1111-1111-1111-111111111111',
  bundleId: '22222222-2222-2222-2222-222222222222',
  portalGroupId: '33333333-3333-3333-3333-333333333333',
  filename: 'IMG_0431.jpg',
  mimeType: 'image/jpeg',
  sizeBytes: 1024,
  siteName: 'ЖК МАРК',
  expectedDate: '2026-08-17',
  createdAt: '2026-08-17T09:00:00.000Z',
  state: 'awaiting_processing' as const,
};

describe('принятый файл строкой списка', () => {
  it('выглядит как документ в очереди: статус и имя файла', () => {
    const row = pendingAsRow(file);

    // Именно эта пара заставляет таблицу нарисовать привычный вид без правок:
    // синий тег «в очереди» и имя файла курсивом вместо номера.
    expect(row.status).toBe('queued');
    expect(row.originalFilename).toBe('IMG_0431.jpg');
    // Реквизитов у файла нет — колонки отдадут «—».
    expect(row.docNumber).toBeNull();
    expect(row.docDate).toBeNull();
    expect(row.totalSum).toBeNull();
  });

  it('несёт объект, дату поставки и метку машины', () => {
    const row = pendingAsRow(file);

    expect(row.siteName).toBe('ЖК МАРК');
    expect(row.expectedDate).toBe('2026-08-17');
    // По этой метке файл встанет в один кластер с документами своей поставки.
    expect(row.portalGroupId).toBe(file.portalGroupId);
  });

  it('отличима от документа по ключу', () => {
    const row = pendingAsRow(file);

    expect(row.id).toBe(file.key);
    expect(isPendingRow(row)).toBe(true);
    // Настоящий документ — обычный UUID.
    expect(isPendingRow({ id: '44444444-4444-4444-4444-444444444444' })).toBe(false);
  });

  it('различает «ждёт разбора» и «не загружен»', () => {
    const waiting = pendingAsRow(file);
    const lost = pendingAsRow({ ...file, key: 'registry:lost', state: 'not_stored' });

    expect(pendingStateOf(waiting)).toBe('awaiting_processing');
    // У «не загружен» свой красный тег: ждать нечего, нужна повторная отправка.
    expect(pendingStateOf(lost)).toBe('not_stored');
    // У обычного документа состояния нет вовсе.
    expect(pendingStateOf({ id: '44444444-4444-4444-4444-444444444444' })).toBeNull();
  });
});
