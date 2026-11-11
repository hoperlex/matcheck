/**
 * Тест-замок на промпт «upd / torg12 v2» (миграция 0145).
 *
 * Главное утверждение: в таблицу попадает ровно тот текст, что прошёл сверку с
 * бумагой 11.11 (13 из 13). Черновик живёт в scripts/prompts/torg12-v2.txt и
 * сверялся оттуда (`upd-prompt-ab --new-file`); правка файла без новой сверки
 * и новой миграции должна ронять этот тест, а не тихо разъезжаться с базой.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { promptFromFile } from '../scripts/prompt-ab-lib.js';
import { loadEnv } from '../src/lib/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'src', 'db', 'migrations');
const sql = readFileSync(join(migrationsDir, '0145_upd_prompt_torg12_v2.sql'), 'utf8');
const down = readFileSync(join(migrationsDir, '0145_down.sql'), 'utf8');
const draft = promptFromFile(
  readFileSync(join(here, '..', 'scripts', 'prompts', 'torg12-v2.txt'), 'utf8'),
  'torg12-v2.txt',
);

/** sha256 текста из отчёта сверки с бумагой 11.11 (a-rockwool-torg12-v2.json). */
const VERIFIED_SHA256 = '0aeea00c58169f96cc23868ebcd8e651d89331699381059571caeb84856bd02b';

/** Текст между долларовыми кавычками INSERT. */
const inserted = sql.slice(
  sql.indexOf('$torg12$') + '$torg12$'.length,
  sql.lastIndexOf('$torg12$'),
);

describe('0145_upd_prompt_torg12_v2', () => {
  it('вставляет побайтно тот же текст, что лежит в черновике', () => {
    expect(inserted).toBe(draft.content);
  });

  it('текст — тот, что прошёл сверку с бумагой', () => {
    expect(createHash('sha256').update(inserted, 'utf8').digest('hex')).toBe(VERIFIED_SHA256);
    // Та же сумма проверяется в самой миграции — при расхождении она падает.
    expect(sql).toContain(`'${VERIFIED_SHA256}'`);
  });

  it('промпт заводится неактивным и под своим именем', () => {
    expect(sql).toMatch(/VALUES \('upd', 'torg12 v2', \$torg12\$/);
    expect(sql).toMatch(/\$torg12\$, false\);/);
    expect(sql).not.toMatch(/is_active"?\s*=\s*true/i);
  });

  it('откат удаляет только неактивный и ни разу не использованный промпт', () => {
    expect(down).toContain(`p."name" = 'torg12 v2'`);
    expect(down).toContain(`p."is_active" = false`);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/);
  });

  it('имя версии по умолчанию в env — эта версия', () => {
    expect(loadEnv().TORG12_PROMPT_NAME).toBe('torg12 v2');
  });
});
