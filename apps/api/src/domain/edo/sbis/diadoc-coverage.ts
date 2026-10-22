/**
 * Полнота реестра Диадока за интервал — для вывода «не найдено в Диадоке».
 *
 * Отсутствие УПД в реестре что-то значит, только если реестр за этот интервал
 * собран полностью. По журналу автовыгрузки (миграция 0132) это проверяемо:
 *   - курсор автопрохода начинается не позже начала интервала;
 *   - полный проход ленты (`scope = 'all'`) дочитан после конца интервала;
 *   - за интервал нет УПД, выгрузка которых упала (и таких без даты — тоже:
 *     про них нельзя сказать, что они не из интервала).
 * Проверяется каждая активная учётка Диадока с ящиком: УПД могла прийти в любой.
 */

export type DiadocCoverageRow = {
  accountId: string;
  accountName: string;
  /** Учитываются только учётки Диадока: реестр выгрузки пока строится только по ним. */
  provider: string;
  /** `edo_export_cursors.since`; null — автопрохода не было. */
  cursorSince: Date | null;
  /** Последний `feed_completed_at` прохода `scope = 'all'`. */
  lastFullPassAt: Date | null;
  failedInInterval: number;
  failedUndated: number;
};

export type DiadocCoverage = {
  covered: boolean;
  /** Причины, по которым реестр не считается полным, — для отчёта. */
  reasons: string[];
  accounts: { accountId: string; accountName: string; covered: boolean; reasons: string[] }[];
};

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

export function assessDiadocCoverage(
  allRows: readonly DiadocCoverageRow[],
  interval: { since: Date; until: Date },
): DiadocCoverage {
  const rows = allRows.filter((row) => row.provider === 'diadoc');
  if (rows.length === 0) {
    return {
      covered: false,
      reasons: ['нет активных учёток Диадока с выбранным ящиком'],
      accounts: [],
    };
  }
  const accounts = rows.map((row) => {
    const reasons: string[] = [];
    if (!row.cursorSince) {
      reasons.push('автовыгрузка не запускалась (нет курсора)');
    } else if (row.cursorSince.getTime() > interval.since.getTime()) {
      reasons.push(
        `автовыгрузка начинается с ${stamp(row.cursorSince)} UTC — позже начала интервала ${stamp(interval.since)} UTC`,
      );
    }
    if (!row.lastFullPassAt) {
      reasons.push('нет ни одного полного прохода ленты');
    } else if (row.lastFullPassAt.getTime() < interval.until.getTime()) {
      reasons.push(
        `последний полный проход ленты ${stamp(row.lastFullPassAt)} UTC — раньше конца интервала ${stamp(interval.until)} UTC`,
      );
    }
    if (row.failedInInterval > 0) reasons.push(`${row.failedInInterval} УПД с ошибкой выгрузки за интервал`);
    if (row.failedUndated > 0) reasons.push(`${row.failedUndated} УПД с ошибкой выгрузки без даты получения`);
    return { accountId: row.accountId, accountName: row.accountName, covered: reasons.length === 0, reasons };
  });
  return {
    covered: accounts.every((a) => a.covered),
    reasons: accounts.flatMap((a) => a.reasons.map((r) => `${a.accountName}: ${r}`)),
    accounts,
  };
}
