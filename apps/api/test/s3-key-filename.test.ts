import { describe, it, expect } from 'vitest';
import { buildS3Key } from '../src/domain/storage/s3.path.js';
import { buildMailAttachmentKey } from '../src/domain/mail/ingest-message.js';

/**
 * Имя файла в S3-ключе: что снимаем и, главное, чего НЕ трогаем.
 *
 * Инцидент 11.09: поставщик грузил `6+6565.pdf` и получал «Хранилище временно
 * недоступно». Плюс доезжал до ключа, а aws4fetch перед подписью превращал его
 * в пробел — подпись считалась для одного пути, запрос уходил на другой, S3
 * отвечал 403. Из 4278 файлов с известным размером не легли ровно 4, и все
 * четыре были с `+` в имени.
 *
 * Поэтому проверяем не «в ключе нет плюса», а точный результат преобразования:
 * правило, которое заодно срезает расширение или половину имени, тоже дало бы
 * ключ без плюса — и было бы не менее сломанным.
 */
describe('S3-ключ: имя файла', () => {
  const base = {
    site: { code: 'PUB' },
    counterparty: null,
    entityType: 'source-documents' as const,
    entityId: 'b1',
  };

  const keyFor = (filename: string): string => buildS3Key({ ...base, filename });
  /** Последний сегмент ключа — то самое имя файла. */
  const nameIn = (filename: string): string => keyFor(filename).split('/').pop()!;

  describe('символы, ломающие подпись запроса, заменяются на _', () => {
    it('плюс — файл из инцидента', () => {
      expect(nameIn('doc-1-6+6565.pdf')).toBe('doc-1-6_6565.pdf');
    });

    it('процент — decodeURIComponent развернул бы %XX в другой символ', () => {
      expect(nameIn('doc-1-скидка%20.pdf')).toBe('doc-1-скидка_20.pdf');
    });

    it('вопрос — иначе хвост имени уехал бы в query, а ключ обрезался', () => {
      expect(nameIn('doc-1-акт?.pdf')).toBe('doc-1-акт_.pdf');
    });

    it('решётка — то же самое, но через fragment', () => {
      expect(nameIn('doc-1-счёт#7.pdf')).toBe('doc-1-счёт_7.pdf');
    });

    it('несколько опасных символов в одном имени', () => {
      expect(nameIn('doc-1-a+b%c?d#e.pdf')).toBe('doc-1-a_b_c_d_e.pdf');
    });
  });

  describe('всё остальное остаётся как было', () => {
    // Защита от регресса: эти имена грузятся годами, и ключ для них меняться
    // не должен — иначе новые файлы лягут не туда, где их ищут по привычке.
    const untouched = [
      'doc-1-УПД 1312 ТН.pdf',
      'doc-2-УПД (статус 1) № 28 от 4 августа 2026 г.pdf',
      'doc-3-Снимок экрана 2026-09-11 084254.png',
      'doc-4-CC_EuroMix_Эмали_Акрил_ПУ.pdf',
      'doc-5-Су-10 03.08.pdf',
    ];
    for (const filename of untouched) {
      it(filename, () => {
        expect(nameIn(filename)).toBe(filename);
      });
    }
  });

  it('ключ целиком: меняется только имя файла, не путь', () => {
    expect(keyFor('doc-1-6+6565.pdf')).toBe('pub/unknown/source-documents/b1/doc-1-6_6565.pdf');
  });
});

/**
 * Почтовый вход строит ключ мимо buildS3Key, поэтому правило проверяется
 * отдельно: вложение «счёт + акт.pdf» иначе не легло бы в бакет вовсе.
 */
describe('S3-ключ вложения письма', () => {
  const box = { accountId: 'acc-1', uidValidity: 7, uid: 42 };

  it('плюс в имени вложения снимается', () => {
    expect(buildMailAttachmentKey(box, 0, 'счёт + акт.pdf')).toBe(
      'mail/acc-1/7/42/att-1-счёт _ акт.pdf',
    );
  });

  it('обычное имя не трогаем', () => {
    expect(buildMailAttachmentKey(box, 1, 'УПД № 1312.pdf')).toBe(
      'mail/acc-1/7/42/att-2-УПД № 1312.pdf',
    );
  });

  it('имени нет — прежняя заглушка', () => {
    expect(buildMailAttachmentKey(box, 2, null)).toBe('mail/acc-1/7/42/att-3-attachment-3.bin');
  });
});
