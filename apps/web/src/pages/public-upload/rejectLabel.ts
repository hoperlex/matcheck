/**
 * Человеческий текст отказа для поставщика.
 *
 * Живёт отдельным модулем, а не внутри формы: коды приходят с сервера
 * (PublicRejectReasonSchema), и на каждый обязан быть внятный текст с
 * подсказкой, что делать. Дефолтное «не принят» — признак того, что код
 * добавили на сервере и забыли здесь; ровно это и проверяет тест.
 */
export function rejectLabel(reason: string): string {
  switch (reason) {
    case 'unsupported_type':
      return 'неподдерживаемый формат (нужны PDF, фото или .xlsx)';
    case 'empty':
      return 'пустой файл';
    case 'too_large':
      return 'файл больше 10 МБ';
    case 'signature_image':
      return 'слишком маленькое изображение — документ на нём не прочитать';
    case 'heic_unsupported':
      return 'формат HEIC не поддерживается — включите в камере «Наиболее совместимый» или пришлите JPEG';
    case 'archive_suspicious':
      return 'файл не удалось прочитать';
    default:
      return 'не принят';
  }
}
