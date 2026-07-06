// Read-only доступ к Postgres MatCheck для диагностики.
//
// Защита — многослойная (см. план, часть A):
//   1) сам пользователь БД имеет только SELECT (гранты на уровне СУБД);
//   2) роль помечена default_transaction_read_only=on;
//   3) каждый запрос здесь выполняется внутри `BEGIN ... SET TRANSACTION READ ONLY` и
//      всегда откатывается (ROLLBACK) — писать физически нельзя;
//   4) поверх — вторичный regex-guard как UX-подсказка (единственный SELECT/WITH,
//      авто-LIMIT, отказ на `SELECT *` без WHERE/LIMIT).
//
// Строка подключения приходит ТОЛЬКО из env MATCHECK_DB_RO_URL (не из argv).
// Доверие к Yandex CA — через NODE_EXTRA_CA_CERTS (postgres-js не читает sslrootcert из URL).

import postgres from 'postgres';

const DEFAULT_LIMIT = 500;

/**
 * Открыть пул к БД. Пул маленький — это диагностический инструмент, не сервис.
 * TLS verify-full обеспечивается связкой sslmode в URL + NODE_EXTRA_CA_CERTS (Yandex CA).
 */
export function openDb(url) {
  if (!url) {
    throw new Error('MATCHECK_DB_RO_URL не задан в окружении');
  }
  return postgres(url, {
    max: 2,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    // rejectUnauthorized:true — цепочку проверяет Node по NODE_EXTRA_CA_CERTS.
    ssl: { rejectUnauthorized: true },
    // Никаких NOTICE в stderr, чтобы не зашумлять stdio-транспорт.
    onnotice: () => {},
  });
}

/**
 * Проверить и при необходимости дополнить запрос (guardrails).
 * Бросает Error с понятным текстом при нарушении. Возвращает безопасный SQL.
 */
export function guardQuery(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Пустой запрос');
  }
  // Убрать построчные комментарии (-- ...) и /* */ для анализа, но выполнять будем
  // исходный текст (комментарии безвредны). Для проверок используем нормализованную копию.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();

  // Разрешаем ровно один стейтмент: убираем единственную завершающую `;`,
  // после чего `;` внутри быть не должно (защита от multi-statement).
  const withoutTrailingSemicolon = stripped.replace(/;\s*$/, '');
  if (withoutTrailingSemicolon.includes(';')) {
    throw new Error('Разрешён только один SELECT-стейтмент (multi-statement запрещён)');
  }

  // Должен начинаться с SELECT или WITH.
  if (!/^\s*(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw new Error('Разрешены только запросы, начинающиеся с SELECT или WITH');
  }

  const hasWhere = /\bwhere\b/i.test(withoutTrailingSemicolon);
  const hasLimit = /\blimit\b/i.test(withoutTrailingSemicolon);
  const isSelectStar = /select\s+\*/i.test(withoutTrailingSemicolon);

  // Явный «дамп всего»: SELECT * без WHERE и без LIMIT — отказ.
  if (isSelectStar && !hasWhere && !hasLimit) {
    throw new Error('`SELECT *` без WHERE и LIMIT запрещён — добавь WHERE или LIMIT');
  }

  // Авто-LIMIT: если лимита нет — ограничиваем выдачу.
  const safe = hasLimit
    ? withoutTrailingSemicolon
    : `${withoutTrailingSemicolon}\nLIMIT ${DEFAULT_LIMIT}`;

  return safe;
}

/**
 * Выполнить read-only запрос в read-only транзакции и откатить её.
 * Возвращает { rows, rowCount, columns, limited }.
 */
export async function runReadOnlyQuery(sql, raw) {
  const safe = guardQuery(raw);
  const limited = safe !== raw.replace(/;\s*$/, '').trim();

  // sql.begin гарантирует транзакцию; SET TRANSACTION READ ONLY первым стейтментом.
  // Явный throw в конце откатывает транзакцию (нам нужен только результат SELECT).
  let rows;
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe('SET TRANSACTION READ ONLY');
      rows = await tx.unsafe(safe);
      // Принудительный откат: ничего не коммитим (для SELECT это безразлично, но
      // делает намерение явным и исключает любые сайд-эффекты).
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }

  const arr = Array.isArray(rows) ? rows : [];
  const columns = arr.length > 0 ? Object.keys(arr[0]) : [];
  return { rows: arr, rowCount: arr.length, columns, limited, effectiveSql: safe };
}

class RollbackSignal extends Error {
  constructor() {
    super('rollback');
    this.name = 'RollbackSignal';
  }
}
