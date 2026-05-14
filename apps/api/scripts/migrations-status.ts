/**
 * Read-only отчёт о применённых миграциях Drizzle.
 * Запуск: pnpm --filter @matcheck/api tsx scripts/migrations-status.ts
 *
 * Не пишет в БД. Подключается через DATABASE_URL, читает drizzle.__drizzle_migrations
 * и сопоставляет записи с тегами из src/db/migrations/meta/_journal.json по порядку
 * (drizzle применяет миграции в порядке idx журнала и пишет в таблицу с тем же порядком id).
 *
 * Используется в DEPLOY.md до и после scripts/migrate.ts: разница между двумя выводами
 * показывает, какие миграции применились этим деплоем.
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

interface JournalFile {
  entries: JournalEntry[];
}

interface MigrationRow {
  id: number;
  hash: string;
  created_at: string;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrations] DATABASE_URL is not set');
    process.exit(1);
  }
  console.info('[migrations] connecting to', url.replace(/:[^:@]*@/, ':***@'));

  const journalPath = './src/db/migrations/meta/_journal.json';
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalFile;
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  const sql = postgres(url, { max: 1, prepare: false });
  let rows: MigrationRow[] = [];
  try {
    rows = await sql<MigrationRow[]>`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY id
    `;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '42P01') {
      console.info('[migrations] table drizzle.__drizzle_migrations does not exist yet (empty DB)');
    } else {
      await sql.end();
      throw err;
    }
  }

  const idCol = 'id'.padEnd(4);
  const tagCol = 'tag'.padEnd(36);
  const tsCol = 'applied_at';
  console.info(`${idCol}  ${tagCol}  ${tsCol}`);
  console.info(`${'-'.repeat(4)}  ${'-'.repeat(36)}  ${'-'.repeat(24)}`);
  for (const row of rows) {
    const tag = entries[row.id - 1]?.tag ?? '?';
    const appliedAt = new Date(Number(row.created_at)).toISOString();
    console.info(`${String(row.id).padEnd(4)}  ${tag.padEnd(36)}  ${appliedAt}`);
  }

  const appliedCount = rows.length;
  const journalCount = entries.length;
  const pendingCount = Math.max(0, journalCount - appliedCount);
  console.info(
    `[migrations] applied: ${appliedCount} / journal: ${journalCount} / pending: ${pendingCount}`,
  );
  if (pendingCount > 0) {
    const pendingTags = entries.slice(appliedCount).map((e) => e.tag).join(', ');
    console.info(`[migrations] pending tags: ${pendingTags}`);
  }

  await sql.end();
}

main().catch((err) => {
  console.error('[migrations] failed', err);
  process.exit(1);
});
