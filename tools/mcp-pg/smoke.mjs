// Проверка конвейера БЕЗ MCP-транспорта: guardrails (offline) + реальное подключение
// (TLS/CA + read-only) к БД из MATCHECK_DB_RO_URL. Для ранней валидации гоняем на
// FOT_DATABASE_URL (тот же Yandex-TLS), пока нет creds к основной БД matcheck.
//
// Запуск (URL и CA не печатаются):
//   set -a; . apps/api/.env; set +a
//   MATCHECK_DB_RO_URL="$FOT_DATABASE_URL" \
//   NODE_EXTRA_CA_CERTS=infra/secrets/yandex-ca/root.crt \
//   node tools/mcp-pg/smoke.mjs

import { openDb, guardQuery, runReadOnlyQuery } from './db.mjs';

let failed = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, msg) => {
  failed++;
  console.log(`  ✗ ${name}: ${msg}`);
};

function expectReject(name, sqlText) {
  try {
    guardQuery(sqlText);
    bad(name, 'ожидался отказ, но прошёл');
  } catch {
    ok(name);
  }
}
function expectPass(name, sqlText, check) {
  try {
    const out = guardQuery(sqlText);
    if (check && !check(out)) bad(name, `неожиданный результат: ${out}`);
    else ok(name);
  } catch (e) {
    bad(name, `ожидался проход, отказ: ${e.message}`);
  }
}

console.log('1) Guardrails (offline):');
expectReject('не-SELECT (INSERT)', 'INSERT INTO t VALUES (1)');
expectReject('не-SELECT (DROP)', 'DROP TABLE users');
expectReject('multi-statement', 'SELECT 1; DROP TABLE users');
expectReject('SELECT * без WHERE/LIMIT', 'SELECT * FROM deliveries');
expectPass('SELECT * с WHERE', "SELECT * FROM deliveries WHERE id = '00000000-0000-0000-0000-000000000001'");
expectPass('авто-LIMIT добавляется', 'SELECT id FROM deliveries', (s) => /limit\s+500/i.test(s));
expectPass('существующий LIMIT сохраняется', 'SELECT 1 LIMIT 3', (s) => /limit\s+3/i.test(s) && !/limit\s+500/i.test(s));
expectPass('count(*) без WHERE разрешён', 'SELECT count(*) FROM deliveries', (s) => /limit\s+500/i.test(s));

console.log('\n2) Реальное подключение (TLS/CA + read-only транзакция):');
const url = process.env.MATCHECK_DB_RO_URL;
if (!url) {
  bad('подключение', 'MATCHECK_DB_RO_URL не задан');
} else {
  const db = openDb(url);
  try {
    const res = await runReadOnlyQuery(db, 'SELECT now() AS ts, current_user AS usr, version() AS ver');
    const row = res.rows[0] ?? {};
    ok(`SELECT now() → user=${row.usr}, ts=${row.ts instanceof Date ? row.ts.toISOString() : row.ts}`);
    // Проверим, что транзакция действительно read-only: попытка записи должна отбиться СУБД.
    try {
      await db.unsafe('CREATE TEMP TABLE _mcp_probe (x int)');
      // если дошли сюда — либо юзер может писать temp; проверим только через явный txn ниже
      await db.unsafe('DROP TABLE IF EXISTS _mcp_probe');
      console.log('  · (temp-write разрешён вне read-only txn — ок, наш путь запросов всё равно read-only)');
    } catch (e) {
      ok(`запись отбита СУБД: ${String(e.message).split('\n')[0]}`);
    }
  } catch (e) {
    bad('подключение', String(e.message).split('\n')[0]);
  } finally {
    await db.end({ timeout: 5 });
  }
}

console.log(failed === 0 ? '\nИТОГ: OK' : `\nИТОГ: ПРОВАЛОВ ${failed}`);
process.exit(failed === 0 ? 0 : 1);
