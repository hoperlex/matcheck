/**
 * Машинные учётки внешних систем (docs/fin_auth.md §2; канал 1С —
 * docs/ONEC_API.md).
 *
 *   list
 *   create --client-id onec --name "1С бухгалтерия" \
 *          --scopes onec.deliveries:read,onec.deliveries:ack \
 *          [--cidr 10.0.0.0/8,203.0.113.5] --secret-out /srv/matcheck/secrets/onec-client.secret
 *   rotate-secret --client-id onec --secret-out <файл>
 *          новый секрет, поколение +1: все выданные токены перестают действовать сразу
 *   revoke --client-id onec      отзыв: токены и выдача перестают работать сразу
 *   set-cidr --client-id onec --cidr <список>|none
 *
 * Секрет пишется ТОЛЬКО в файл (права 600, файла не должно существовать) и
 * никогда в stdout — правило маскировки секретов (CLAUDE.md §3). В выводе —
 * длина и sha256-префикс, чтобы сверить, что файл тот.
 *
 * Запуск на бою:
 *   docker compose -f infra/docker-compose.prod.yml run --rm --no-deps -T \
 *     -v /srv/matcheck/secrets:/secrets matcheck-api \
 *     node_modules/.bin/tsx scripts/service-accounts.ts create … --secret-out /secrets/onec-client.secret
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { eq, sql as drSql } from 'drizzle-orm';
import { db, sql } from '../src/db/client.js';
import { serviceAccounts } from '../src/db/schema.js';
import {
  generateClientSecret,
  hashClientSecret,
  KNOWN_SCOPES,
  parseCidr,
} from '../src/domain/auth/service-accounts.js';
import { errorChain } from '../src/lib/error-chain.js';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'client-id': { type: 'string' },
    name: { type: 'string' },
    scopes: { type: 'string' },
    cidr: { type: 'string' },
    'secret-out': { type: 'string' },
  },
});

function fail(message: string): never {
  throw new Error(message);
}

function parseScopes(raw: string | undefined): string[] {
  const scopes = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (scopes.length === 0) fail('--scopes: хотя бы одно право');
  const unknown = scopes.filter((s) => !(KNOWN_SCOPES as readonly string[]).includes(s));
  if (unknown.length > 0) fail(`--scopes: неизвестные права ${unknown.join(', ')} (есть: ${KNOWN_SCOPES.join(', ')})`);
  return [...new Set(scopes)];
}

function parseCidrs(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '' || raw.trim() === 'none') return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  // Тот же разбор, что на запросах: битая запись там означала бы отказ всем.
  const bad = list.filter((c) => parseCidr(c) === null);
  if (bad.length > 0) fail(`--cidr: не сеть ${bad.map((c) => `«${c}»`).join(', ')}`);
  return list;
}

/** Секрет — в новый файл 600; в вывод — только длина и отпечаток. */
function writeSecret(path: string | undefined, secret: string): string {
  if (!path) fail('--secret-out: файл для секрета обязателен (в stdout секрет не выводится)');
  writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  return `секрет записан в ${path} (длина ${secret.length}, sha256 ${hashClientSecret(secret).slice(0, 12)}…)`;
}

function clientId(): string {
  const id = args['client-id']?.trim();
  if (!id || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) fail('--client-id: латиница в нижнем регистре, цифры, _ и -');
  return id;
}

async function main(): Promise<number> {
  const command = positionals[0];
  switch (command) {
    case 'list': {
      const rows = await db
        .select({
          clientId: serviceAccounts.clientId,
          name: serviceAccounts.name,
          scopes: serviceAccounts.scopes,
          cidrs: serviceAccounts.allowedCidrs,
          active: serviceAccounts.isActive,
          gen: serviceAccounts.secretGeneration,
          lastTokenAt: serviceAccounts.lastTokenAt,
        })
        .from(serviceAccounts)
        .orderBy(serviceAccounts.clientId);
      for (const r of rows) {
        console.info(
          `${r.clientId}\t${r.active ? 'активна' : 'ОТОЗВАНА'}\tпоколение ${r.gen}\t${r.scopes.join(',')}\t` +
            `сети: ${r.cidrs?.join(',') ?? 'любые'}\tпоследний токен: ${r.lastTokenAt?.toISOString() ?? '—'}\t${r.name}`,
        );
      }
      if (rows.length === 0) console.info('учёток нет');
      return 0;
    }
    case 'create': {
      const id = clientId();
      const name = args.name?.trim() || fail('--name обязателен');
      const scopes = parseScopes(args.scopes);
      const cidrs = parseCidrs(args.cidr);
      const secret = generateClientSecret();
      // Сначала файл (wx — не перезаписывать чужой), потом строка: при сбое
      // записи строки остаётся лишний файл, а не учётка без известного секрета.
      const note = writeSecret(args['secret-out'], secret);
      await db.insert(serviceAccounts).values({
        clientId: id,
        name,
        scopes,
        allowedCidrs: cidrs,
        secretHash: hashClientSecret(secret),
      });
      console.info(`учётка ${id} создана: права ${scopes.join(',')}, сети ${cidrs?.join(',') ?? 'любые'}`);
      console.info(note);
      return 0;
    }
    case 'rotate-secret': {
      const id = clientId();
      const secret = generateClientSecret();
      const note = writeSecret(args['secret-out'], secret);
      const updated = await db
        .update(serviceAccounts)
        .set({
          secretHash: hashClientSecret(secret),
          secretGeneration: drSql`${serviceAccounts.secretGeneration} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(serviceAccounts.clientId, id))
        .returning({ gen: serviceAccounts.secretGeneration });
      if (updated.length === 0) fail(`учётки ${id} нет (файл с секретом создан зря — удалите его)`);
      console.info(`учётка ${id}: секрет заменён, поколение ${updated[0]!.gen}; выданные токены больше не действуют`);
      console.info(note);
      return 0;
    }
    case 'revoke': {
      const id = clientId();
      const updated = await db
        .update(serviceAccounts)
        .set({ isActive: false, revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(serviceAccounts.clientId, id))
        .returning({ id: serviceAccounts.id });
      if (updated.length === 0) fail(`учётки ${id} нет`);
      console.info(`учётка ${id} отозвана: токены и выдача перестали работать`);
      return 0;
    }
    case 'set-cidr': {
      const id = clientId();
      const cidrs = parseCidrs(args.cidr);
      const updated = await db
        .update(serviceAccounts)
        .set({ allowedCidrs: cidrs, updatedAt: new Date() })
        .where(eq(serviceAccounts.clientId, id))
        .returning({ id: serviceAccounts.id });
      if (updated.length === 0) fail(`учётки ${id} нет`);
      console.info(`учётка ${id}: сети ${cidrs?.join(',') ?? 'любые'}`);
      return 0;
    }
    default:
      console.error('команды: list | create | rotate-secret | revoke | set-cidr (см. шапку файла)');
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(errorChain(err));
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
