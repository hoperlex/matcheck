import { and, eq } from 'drizzle-orm';
import { statuses } from '../../db/schema.js';

/**
 * Возвращает id статуса в таблице statuses по сущности и коду.
 * Кешировать не нужно — таблица маленькая, запросы редкие, всегда внутри роута.
 */
export async function resolveStatusId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: any,
  entityType: string,
  code: string,
): Promise<string> {
  const [s] = await app.db
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.entityType, entityType), eq(statuses.code, code)))
    .limit(1);
  if (!s) throw new Error(`Unknown status: ${entityType}/${code}`);
  return s.id;
}
