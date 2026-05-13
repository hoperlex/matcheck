/**
 * Применение миграций Drizzle к БД.
 * Запуск: pnpm --filter @matcheck/api tsx scripts/migrate.ts
 *
 * Перед запуском убедитесь, что DATABASE_URL указан и БД доступна.
 * Перед первым деплоем создайте миграции:
 *   pnpm --filter @matcheck/api drizzle-kit generate
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/matcheck';
  console.info('[migrate] connecting to', url.replace(/:[^:@]*@/, ':***@'));
  const sql = postgres(url, { max: 1, prepare: false });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  console.info('[migrate] done');
  await sql.end();
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
