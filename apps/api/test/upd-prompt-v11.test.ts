import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'db',
  'migrations',
);
const sql = readFileSync(join(migrationsDir, '0109_upd_prompt_v11_pricing.sql'), 'utf8');

describe('0109_upd_prompt_v11_pricing', () => {
  it('дословно расширяет v10 полем с тремя однозначными исходами', () => {
    expect(sql).toMatch(/FROM "prompts"\s+WHERE "doc_kind" = 'upd' AND "name" = 'default v10'/i);
    expect(sql).toContain("'default v11'");
    expect(sql).toContain('поле pricing:');
    expect(sql).toContain('"printed"');
    expect(sql).toContain('"absent"');
    expect(sql).toContain('"unclear"');
    expect(sql).toMatch(/position\(v10\.content in v11\.content\) = 1/);
  });

  it('не активирует новую версию', () => {
    const insert = sql.slice(sql.indexOf('INSERT INTO'), sql.indexOf('FROM "prompts"'));
    expect(insert).toMatch(/\bfalse\b/);
    expect(sql).toMatch(/is_active = true/);
  });

  it('зарегистрирован и имеет безопасный down', () => {
    const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries).toContainEqual(
      expect.objectContaining({ idx: 109, tag: '0109_upd_prompt_v11_pricing' }),
    );
    const down = readFileSync(join(migrationsDir, '0109_down.sql'), 'utf8');
    expect(down).toMatch(/"is_active" = false/);
    expect(down).toMatch(/NOT EXISTS \(SELECT 1 FROM "llm_calls"/i);
  });
});
