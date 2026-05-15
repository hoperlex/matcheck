/**
 * Применение миграций Drizzle к БД.
 * Запуск: pnpm --filter @matcheck/api tsx scripts/migrate.ts
 *
 * Перед запуском убедитесь, что DATABASE_URL указан и БД доступна.
 *
 * Совместим с drizzle.__drizzle_migrations (та же таблица, тот же sha256-hash
 * от содержимого .sql), но применяет каждую миграцию в ОТДЕЛЬНОЙ транзакции,
 * а не все pending в одной (как делает встроенный drizzle migrate()).
 *
 * Причина: некоторые DDL-операции PostgreSQL (например, ALTER TYPE ... ADD
 * VALUE для enum) не могут использоваться в той же транзакции, где значение
 * было добавлено. Если 0015 добавляет 'queued' и 0016 создаёт индекс
 * `WHERE status = 'queued'`, drizzle migrate() обернёт обе миграции в один
 * BEGIN/COMMIT и упадёт с ошибкой 55P04. Per-migration транзакции это решают.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { backfillProviderCredentials } from '../src/db/backfill-provider-credentials.js';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  breakpoints: boolean;
}

interface JournalFile {
  entries: JournalEntry[];
}

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/matcheck';
  console.info('[migrate] connecting to', url.replace(/:[^:@]*@/, ':***@'));
  const sql = postgres(url, { max: 1, prepare: false });

  const migrationsFolder = './src/db/migrations';
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  // 1. Создаём схему drizzle и таблицу учёта миграций — точно как делает
  //    встроенный drizzle migrator, чтобы migrations-status.ts продолжал
  //    работать без изменений.
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
       id SERIAL PRIMARY KEY,
       hash text NOT NULL,
       created_at bigint
     )`,
  );

  // 2. Узнаём, какие миграции уже применены — по хешу.
  const appliedRows = await sql<{ hash: string }[]>`
    SELECT hash FROM "drizzle"."__drizzle_migrations"
  `;
  const appliedHashes = new Set(appliedRows.map((r) => r.hash));

  // 3. Применяем каждую pending миграцию в собственной транзакции.
  let appliedCount = 0;
  for (const entry of entries) {
    const sqlPath = join(migrationsFolder, `${entry.tag}.sql`);
    const content = readFileSync(sqlPath, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');

    if (appliedHashes.has(hash)) {
      console.info(`[migrate] ${entry.tag} — already applied, skipping`);
      continue;
    }

    const statements = content
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    console.info(`[migrate] applying ${entry.tag} (${statements.length} stmt)...`);
    await sql.begin(async (tx) => {
      for (const stmt of statements) {
        await tx.unsafe(stmt);
      }
      await tx`
        INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
        VALUES (${hash}, ${entry.when})
      `;
    });
    appliedCount++;
    console.info(`[migrate] applied ${entry.tag}`);
  }

  console.info(`[migrate] done. applied this run: ${appliedCount}`);

  // Data-миграция: перенос ключей из llm_providers в llm_provider_credentials.
  // Идемпотентна — повторные запуски ничего не делают.
  await backfillProviderCredentials(sql);

  await sql.end();
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
