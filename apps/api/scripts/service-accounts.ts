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
import { db, sql } from '../src/db/client.js';
import { authEvents, serviceAccounts } from '../src/db/schema.js';
import {
  createServiceAccount,
  findServiceAccountByClientId,
  generateClientSecret,
  hashClientSecret,
  revokeServiceAccount,
  rotateServiceAccountSecret,
  serviceAccountStatus,
  ServiceAccountError,
  updateServiceAccount,
  validateCidrs,
  validateScopes,
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
  return validateScopes((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

function parseCidrs(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '' || raw.trim() === 'none') return null;
  // Тот же разбор, что на запросах: битая запись там означала бы отказ всем.
  return validateCidrs(raw.split(','));
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

async function existing(id: string) {
  const row = await findServiceAccountByClientId(db, id);
  if (!row) fail(`учётки ${id} нет`);
  return row;
}

/** Журнал — тот же, что у вкладки «API-доступ»; userId нет, источник — командная строка. */
async function audit(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], event: string, meta: Record<string, unknown>) {
  await tx.insert(authEvents).values({ userId: null, event, meta: { ...meta, source: 'cli' } });
}

async function main(): Promise<number> {
  const command = positionals[0];
  switch (command) {
    case 'list': {
      const rows = await db.select().from(serviceAccounts).orderBy(serviceAccounts.clientId);
      for (const r of rows) {
        const last = [r.lastUsedAt, r.lastTokenAt].filter((d): d is Date => d !== null);
        const lastAt = last.length ? new Date(Math.max(...last.map((d) => d.getTime()))).toISOString() : '—';
        console.info(
          `${r.clientId}\t${serviceAccountStatus(r)}\tпоколение ${r.secretGeneration}\t${r.scopes.join(',')}\t` +
            `сети: ${r.allowedCidrs?.join(',') ?? 'любые'}\tдо: ${r.expiresAt?.toISOString() ?? 'бессрочно'}\t` +
            `последний запрос: ${lastAt}\t${r.name}`,
        );
      }
      if (rows.length === 0) console.info('учёток нет');
      return 0;
    }
    case 'create': {
      // Все проверки — до записи файла: ошибка в аргументах не оставляет файл.
      const id = clientId();
      const name = args.name?.trim() || fail('--name обязателен');
      const scopes = parseScopes(args.scopes);
      const cidrs = parseCidrs(args.cidr);
      if (await findServiceAccountByClientId(db, id)) fail(`client_id «${id}» уже занят`);
      const secret = generateClientSecret();
      // Сначала файл (wx — не перезаписывать чужой), потом строка: сбой записи
      // файла не трогает базу; сбой базы оставляет лишний файл, а не учётку без
      // известного секрета.
      const note = writeSecret(args['secret-out'], secret);
      await db.transaction(async (tx) => {
        const row = await createServiceAccount(tx, { clientId: id, name, scopes, allowedCidrs: cidrs, secret });
        await audit(tx, 'service_account_created', { clientId: row.clientId, name, scopes, allowedCidrs: cidrs });
      });
      console.info(`учётка ${id} создана: права ${scopes.join(',')}, сети ${cidrs?.join(',') ?? 'любые'}`);
      console.info(note);
      return 0;
    }
    case 'rotate-secret': {
      const row = await existing(clientId());
      const secret = generateClientSecret();
      // Тот же порядок: файл не записался — база не тронута, старый секрет работает.
      const note = writeSecret(args['secret-out'], secret);
      const updated = await db.transaction(async (tx) => {
        const r = await rotateServiceAccountSecret(tx, row.id, { secret });
        await audit(tx, 'service_account_secret_rotated', { clientId: r.clientId, generation: r.secretGeneration });
        return r;
      });
      console.info(`учётка ${updated.clientId}: секрет заменён, поколение ${updated.secretGeneration}; выданные токены больше не действуют`);
      console.info(note);
      return 0;
    }
    case 'revoke': {
      const row = await existing(clientId());
      const { changed } = await db.transaction(async (tx) => {
        const res = await revokeServiceAccount(tx, row.id);
        if (res.changed) await audit(tx, 'service_account_revoked', { clientId: row.clientId });
        return res;
      });
      console.info(changed ? `учётка ${row.clientId} отозвана: токены и выдача перестали работать` : `учётка ${row.clientId} уже была отозвана`);
      return 0;
    }
    case 'set-cidr': {
      const row = await existing(clientId());
      const cidrs = parseCidrs(args.cidr);
      await db.transaction(async (tx) => {
        const res = await updateServiceAccount(tx, row.id, { allowedCidrs: cidrs });
        if (res.changed.length > 0) {
          await audit(tx, 'service_account_updated', { clientId: row.clientId, changed: res.changed, allowedCidrs: cidrs });
        }
      });
      console.info(`учётка ${row.clientId}: сети ${cidrs?.join(',') ?? 'любые'}`);
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
    console.error(err instanceof ServiceAccountError ? err.message : errorChain(err));
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
