/**
 * Парсит CSV-параметр URL в массив id, например
 *   ?contractor=uuid1,uuid2,uuid3 → ['uuid1','uuid2','uuid3']
 * Пустые/отсутствующие значения дают пустой массив.
 */
export function parseCsvIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Обратная операция: массив id → CSV-строка, либо null если массив пуст.
 * Используется при записи в URLSearchParams: null означает «удалить параметр».
 */
export function toCsvIds(ids: string[] | null | undefined): string | null {
  if (!ids || ids.length === 0) return null;
  return ids.join(',');
}
