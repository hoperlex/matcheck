/**
 * Текст ошибки вместе с причинами.
 *
 * У drizzle сбой запроса — «Failed query: <SQL> params: …», а ответ Postgres
 * (что именно не так) лежит в `cause`. Печать одного `message` теряет его:
 * так 26.10 первый запуск выгрузки СБИС упал с «Failed query» без объяснения.
 */
export function errorChain(err: unknown, maxDepth = 4): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < maxDepth; depth++) {
    const text = current instanceof Error ? current.message : String(current);
    if (!parts.includes(text)) parts.push(text);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join('\n  причина: ');
}
