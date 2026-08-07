import { describe, it, expect } from 'vitest';
import {
  contentHashOf,
  fileHashOf,
  idempotencyKeyOf,
  processingModesHashOf,
} from '../src/domain/sourceDocuments/bundle-key.js';

/**
 * Раскладка файлов по зонам формы входит в идентичность пакета — но только
 * когда во второй зоне что-то есть. Иначе перестали бы узнаваться ВСЕ ранее
 * загруженные пакеты, и повтор старого комплекта плодил бы дубли.
 */
describe('bundle-key: режимы обработки в ключе идемпотентности', () => {
  const scope = {
    siteId: 'site-1',
    direction: 'inbound',
    contractorId: null,
    recipientMolId: null,
    expectedDate: '2026-08-07',
    contentHash: contentHashOf([fileHashOf(Buffer.from('upd'))]),
  };

  it('пачка целиком из auto даёт прежний ключ v1', () => {
    const modesHash = processingModesHashOf([{ fileHash: 'aaa', processingMode: 'auto' }]);
    expect(modesHash).toBeNull();
    expect(idempotencyKeyOf({ ...scope, modesHash })).toBe(idempotencyKeyOf(scope));
    expect(idempotencyKeyOf(scope).startsWith('v1|manual|')).toBe(true);
  });

  it('появление store_only меняет ключ — тот же файл в другой зоне это другой пакет', () => {
    const asAuto = processingModesHashOf([{ fileHash: 'aaa', processingMode: 'auto' }]);
    const asStore = processingModesHashOf([{ fileHash: 'aaa', processingMode: 'store_only' }]);
    expect(asStore).not.toBeNull();

    const keyAuto = idempotencyKeyOf({ ...scope, modesHash: asAuto });
    const keyStore = idempotencyKeyOf({ ...scope, modesHash: asStore });
    expect(keyStore).not.toBe(keyAuto);
    expect(keyStore.startsWith('v2|manual|')).toBe(true);
  });

  it('порядок файлов на ключ не влияет', () => {
    const a = processingModesHashOf([
      { fileHash: 'aaa', processingMode: 'auto' },
      { fileHash: 'bbb', processingMode: 'store_only' },
    ]);
    const b = processingModesHashOf([
      { fileHash: 'bbb', processingMode: 'store_only' },
      { fileHash: 'aaa', processingMode: 'auto' },
    ]);
    expect(a).toBe(b);
  });
});
