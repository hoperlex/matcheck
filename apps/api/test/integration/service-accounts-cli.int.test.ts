/**
 * Командная строка ключей (scripts/service-accounts.ts) после перехода на общие
 * функции домена: умеет всё, что умела (--client-id, --cidr), и сохраняет
 * порядок «секрет → новый файл → база». Файл записать не удалось — база не
 * тронута, старый секрет работает.
 *
 * Скрипт запускается настоящим процессом против тестовой базы.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashClientSecret } from '../../src/domain/auth/service-accounts.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const suite = TEST_DATABASE_URL ? describe : describe.skip;

const RUN = randomUUID().slice(0, 8);
const CLIENT = `cli-${RUN}`;

function cli(...args: string[]) {
  return spawnSync('npx', ['tsx', 'scripts/service-accounts.ts', ...args], {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'error' },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

suite('командная строка ключей (реальный PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  let dir: string;

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, { max: 2 });
    dir = mkdtempSync(join(tmpdir(), 'sa-cli-'));
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    if (!sql) return;
    await sql`DELETE FROM auth_events WHERE meta->>'clientId' = ${CLIENT}`;
    await sql`DELETE FROM service_accounts WHERE client_id = ${CLIENT}`;
    await sql.end({ timeout: 5 });
  });

  const account = async () =>
    (await sql<{ secret_hash: string; secret_generation: number; allowed_cidrs: string[] | null; scopes: string[] }[]>`
      SELECT secret_hash, secret_generation, allowed_cidrs, scopes FROM service_accounts WHERE client_id = ${CLIENT}`)[0];

  it('create с --client-id и --cidr сохраняет оба; секрет — только в файле 600', async () => {
    const out = join(dir, 'create.secret');
    const res = cli(
      'create', '--client-id', CLIENT, '--name', 'Командная строка',
      '--scopes', 'onec.deliveries:read,onec.deliveries:ack',
      '--cidr', '10.0.0.0/8,203.0.113.5', '--secret-out', out,
    );
    expect(res.status, res.stderr).toBe(0);
    const secret = readFileSync(out, 'utf8').trim();
    expect(res.stdout).not.toContain(secret);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const row = await account();
    expect(row).toMatchObject({
      allowed_cidrs: ['10.0.0.0/8', '203.0.113.5'],
      scopes: ['onec.deliveries:read', 'onec.deliveries:ack'],
      secret_hash: hashClientSecret(secret),
    });
  });

  it('файл секрета записать не удалось — база не тронута, старый секрет на месте', async () => {
    const before = await account();
    // Без учётки из прошлого шага проверка была бы пустой: оба значения undefined.
    expect(before?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    const busy = join(dir, 'busy.secret');
    writeFileSync(busy, 'чужой файл\n');
    const res = cli('rotate-secret', '--client-id', CLIENT, '--secret-out', busy);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('EEXIST');
    expect(readFileSync(busy, 'utf8')).toBe('чужой файл\n');
    const after = await account();
    expect(after?.secret_hash).toBe(before?.secret_hash);
    expect(after?.secret_generation).toBe(before?.secret_generation);
  });

  it('create с занятым client_id не создаёт файл', async () => {
    const out = join(dir, 'dup.secret');
    const res = cli('create', '--client-id', CLIENT, '--name', 'дубль', '--scopes', 'onec.deliveries:read', '--secret-out', out);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('уже занят');
    expect(() => statSync(out)).toThrow();
  });
});
