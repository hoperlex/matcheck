/**
 * Case-insensitive substring match.
 * Пустая/null needle → true (фильтр не активен).
 */
export function matchText(
  haystack: string | null | undefined,
  needle: string | null | undefined,
): boolean {
  const n = (needle ?? '').trim().toLowerCase();
  if (!n) return true;
  const h = (haystack ?? '').toLowerCase();
  return h.includes(n);
}
