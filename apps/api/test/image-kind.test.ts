/**
 * Опознание картинок по имени файла.
 *
 * Тест закрепляет цену ошибки: не опознанная картинка уходит в PDF-путь, там
 * её пробует открыть pdftoppm, и документ получает parse_failed. Именно так
 * 21.08 потерялись восемь документов с расширением .jfif.
 */
import { describe, expect, it } from 'vitest';
import { imageMimeOfKey } from '../src/lib/image-kind.js';

describe('imageMimeOfKey', () => {
  it('.jfif — это JPEG, а не «неизвестный файл»', () => {
    // Так изображения сохраняют Outlook и Windows; поставщики шлют их регулярно.
    expect(imageMimeOfKey('uploads/88ef893a.jfif')).toBe('image/jpeg');
    expect(imageMimeOfKey('IMG_0431.JFIF')).toBe('image/jpeg');
    expect(imageMimeOfKey('scan.jfi')).toBe('image/jpeg');
  });

  it('привычные форматы не сломались', () => {
    expect(imageMimeOfKey('a.jpg')).toBe('image/jpeg');
    expect(imageMimeOfKey('a.jpeg')).toBe('image/jpeg');
    expect(imageMimeOfKey('a.png')).toBe('image/png');
    expect(imageMimeOfKey('a.webp')).toBe('image/webp');
  });

  it('форматы с телефонов тоже опознаются', () => {
    expect(imageMimeOfKey('photo.heic')).toBe('image/heic');
    expect(imageMimeOfKey('photo.HEIF')).toBe('image/heif'.replace('heif', 'heic'));
    expect(imageMimeOfKey('photo.avif')).toBe('image/avif');
  });

  it('документы картинками не считаются', () => {
    expect(imageMimeOfKey('упд.pdf')).toBeNull();
    expect(imageMimeOfKey('накладная.xlsx')).toBeNull();
    expect(imageMimeOfKey('файл-без-расширения')).toBeNull();
    // Расширение читается с конца: «photo.png.pdf» — это PDF.
    expect(imageMimeOfKey('photo.png.pdf')).toBeNull();
  });
});
