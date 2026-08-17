/**
 * Сопоставление файлов повторной отправки с недозагруженными строками реестра.
 *
 * Это ядро дозагрузки: если сопоставить неправильно, объект ляжет под чужим
 * ключом, и в поставке останется дырка при внешне успешном ответе. Проверок
 * ровно три, и каждая закрывает свой способ ошибиться:
 *
 *   * ХЕШ ВПЕРЁД ИМЕНИ. Поставщики шлют IMG_0431.jpg пачками, и одинаковые
 *     имена в одной отправке — норма;
 *   * ОДИНАКОВЫЕ ФАЙЛЫ НЕ СХЛОПЫВАЮТСЯ. Два байт-в-байт одинаковых файла — это
 *     две строки реестра, и каждая должна получить свой объект;
 *   * ЗАПАСНОЙ ПУТЬ по имени и позиции — для строк, принятых до появления хеша.
 */
import { describe, expect, it } from 'vitest';
import { matchFilesToMissingRows } from '../src/domain/sourceDocuments/ingest-bundle.js';
import type { RegistryRow } from '../src/domain/sourceDocuments/bundle-import-registry.js';

const sha = (s: string) => s.padEnd(64, '0');

function file(filename: string, fileHash: string) {
  return {
    filename,
    mimeType: 'application/pdf',
    buffer: Buffer.from(filename),
    fileHash,
    processingMode: 'auto' as const,
  };
}

function row(opts: {
  id: string;
  filename: string;
  order: number;
  sha?: string | null;
}): RegistryRow {
  return {
    id: opts.id,
    bundleId: 'b',
    s3Key: null,
    filename: opts.filename,
    mimeType: 'application/pdf',
    sizeBytes: 10,
    contentSha256: opts.sha === undefined ? sha(opts.filename) : opts.sha,
    uploadGeneration: 0,
    inputOrder: opts.order,
    status: 'failed',
    processingMode: 'auto',
    detectedKind: null,
    confidence: null,
    parserUsed: null,
    createdDocumentIds: [],
    reason: null,
    effectiveStatus: 'failed',
    subBundleId: null,
    stubDocumentId: null,
    resolvedAt: null,
    createdAt: new Date(),
  };
}

describe('matchFilesToMissingRows', () => {
  it('сопоставляет по содержимому, а не по имени', () => {
    // Имена перепутаны местами: если сопоставлять по ним, каждый файл ляжет
    // под чужой строкой и в поставке останутся не те документы.
    const rows = [
      row({ id: 'r1', filename: 'a.pdf', order: 0, sha: sha('X') }),
      row({ id: 'r2', filename: 'b.pdf', order: 1, sha: sha('Y') }),
    ];
    const matched = matchFilesToMissingRows(
      [file('b.pdf', sha('Y')), file('a.pdf', sha('X'))],
      rows,
    );

    expect(matched).toHaveLength(2);
    expect(matched.find((m) => m.row.id === 'r1')?.file.fileHash).toBe(sha('X'));
    expect(matched.find((m) => m.row.id === 'r2')?.file.fileHash).toBe(sha('Y'));
  });

  it('два одинаковых файла занимают две разные строки', () => {
    const rows = [
      row({ id: 'r1', filename: 'dup.pdf', order: 0, sha: sha('SAME') }),
      row({ id: 'r2', filename: 'dup.pdf', order: 1, sha: sha('SAME') }),
    ];
    const matched = matchFilesToMissingRows(
      [file('dup.pdf', sha('SAME')), file('dup.pdf', sha('SAME'))],
      rows,
    );

    // Схлопывание оставило бы одну строку недозагруженной навсегда.
    expect(matched.map((m) => m.row.id).sort()).toEqual(['r1', 'r2']);
  });

  it('строку без хеша находит по имени и позиции в пачке', () => {
    const rows = [row({ id: 'legacy', filename: 'old.pdf', order: 0, sha: null })];
    const matched = matchFilesToMissingRows([file('old.pdf', sha('Z'))], rows);

    expect(matched).toHaveLength(1);
    expect(matched[0]!.row.id).toBe('legacy');
  });

  it('чужая отправка не сопоставляется ни с чем', () => {
    const rows = [row({ id: 'r1', filename: 'a.pdf', order: 0, sha: sha('X') })];
    // Другое содержимое, другое имя, другая позиция — это просто другой
    // комплект. Трогать реестр нельзя: перезапишем чужую строку.
    const matched = matchFilesToMissingRows([file('other.pdf', sha('NOPE'))], rows);

    expect(matched).toHaveLength(0);
  });

  it('лишние файлы отправки не мешают найти нужный', () => {
    const rows = [row({ id: 'r1', filename: 'b.pdf', order: 1, sha: sha('B') })];
    // Поставщик прислал комплект целиком — как и просили. Дозагрузить надо
    // ровно один файл, остальные уже лежат в бакете.
    const matched = matchFilesToMissingRows(
      [file('a.pdf', sha('A')), file('b.pdf', sha('B')), file('c.pdf', sha('C'))],
      rows,
    );

    expect(matched).toHaveLength(1);
    expect(matched[0]!.file.fileHash).toBe(sha('B'));
  });
});
