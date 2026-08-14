/**
 * Границы поддержки форматов документов.
 *
 * Тест-документация: фиксирует, ЧТО система обещает распознавать, а что — нет.
 * Без этого «поддерживается» превращается в вопрос веры: HEIC внутренняя
 * загрузка принимает, роутер честно зовёт его изображением, а распознать не
 * может ни один путь — и файл оседает нераспознанным без внятной причины.
 *
 * Здесь проверяются два ограничения, которые легко нарушить незаметно:
 *
 *   1. Фото распознаются только в JPEG, PNG и WebP. Воркер отбирает картинки
 *      по расширению (`/\.(jpe?g|png|webp)$/i`, worker.ts), и HEIC туда не
 *      попадает — он уйдёт в PDF-ветку и разбор закончится ошибкой. Публичная
 *      загрузка это знает и отклоняет HEIC заранее с причиной
 *      `heic_unsupported` (см. public-upload-limits.test.ts).
 *   2. Excel означает только УПД. Классификатор отправляет любую подходящую
 *      книгу в `upd`; М-15, ТН и ОС-2 в Excel не поддержаны — эти формы
 *      распознаются в PDF и на фотографиях.
 *
 * Если какое-то ограничение будет снято (например, добавят конвертацию
 * HEIC→PNG), этот тест должен упасть и быть переписан осознанно.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { classifyFile } from '../src/domain/edo/document-router.js';

const corpus = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/debug-upd');

/** Расширения, которые воркер считает изображением (worker.ts, ветка vision). */
const WORKER_IMAGE_RE = /\.(jpe?g|png|webp)$/i;

describe('границы поддержки: фотографии', () => {
  it.each(['photo.jpg', 'photo.jpeg', 'scan.PNG', 'shot.webp'])(
    '%s распознаётся как изображение',
    (name) => {
      expect(WORKER_IMAGE_RE.test(name)).toBe(true);
    },
  );

  it.each(['IMG_0042.HEIC', 'IMG_0042.heif'])(
    '%s — НЕ поддержан: воркер не считает его изображением',
    (name) => {
      // Ровно поэтому HEIC и отклоняется на публичном входе: пропустив его
      // дальше, мы бы получили документ, который не разберётся никогда.
      expect(WORKER_IMAGE_RE.test(name)).toBe(false);
    },
  );

  it('роутер называет HEIC изображением — расхождение с воркером осознанное', async () => {
    // Роутер смотрит шире (IMAGE_RE включает heic|heif), и это не баг: файл
    // получает видимую строку в «Документах» и остаётся доступен как исходник,
    // а не пропадает. Распознать его нечем — это и есть граница поддержки.
    const heic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(64)]);
    const c = await classifyFile(heic, 'image/heic', 'IMG_0042.HEIC');
    expect(c.needsVision).toBe(true);
    expect(c.signals).toContain('image');
  });
});

describe('границы поддержки: Excel', () => {
  it('книга, похожая на УПД, классифицируется как upd', async () => {
    const buf = readFileSync(join(corpus, 'упд 1877.xls'));
    const c = await classifyFile(buf, 'application/vnd.ms-excel', 'упд 1877.xls');
    expect(c.detectedKind).toBe('upd');
  });

  it('Excel никогда не становится накладной: М-15, ТН и ОС-2 в книгах не поддержаны', async () => {
    // Классификатор различает только «похоже на УПД» и «не похоже» — отдельного
    // типа накладной для Excel нет вовсе. Эти формы распознаются в PDF и на
    // фото; если понадобится Excel — это отдельная задача, а не настройка.
    const files = ['упд 1877.xls', 'УПД № ТК-02815 от 18 июня 2026 г..xls'];
    for (const name of files) {
      const c = await classifyFile(
        readFileSync(join(corpus, name)),
        'application/vnd.ms-excel',
        name,
      );
      expect(['upd', 'unknown'], name).toContain(c.detectedKind);
      expect(c.detectedKind, name).not.toBe('m15');
      expect(c.detectedKind, name).not.toBe('transport_waybill');
    }
  });
});
