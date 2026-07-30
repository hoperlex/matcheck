// Обход почтовых ящиков: тонкая обвязка над `pollMailAccount`.
//
// Вынесено из процесса mail-worker намеренно — там побочные эффекты при
// импорте (BullMQ, таймеры, сигналы), и покрыть логику тестами было бы нельзя.

import { eq } from 'drizzle-orm';
import { mailAccounts } from '../../db/schema.js';
import { listPollableAccounts } from '../mail/poll-lease.js';
import { pollMailAccount, type PollDeps, type PollOptions, type PollResult } from './mail-poll.js';

export type RunnerLog = {
  info?: (o: unknown, m?: string) => void;
  warn?: (o: unknown, m?: string) => void;
  error?: (o: unknown, m?: string) => void;
};

export type RunnerDeps = PollDeps & {
  log?: RunnerLog;
  /** Сообщить об ошибке наружу (Sentry). */
  onError?: (err: unknown, accountId: string) => void;
};

/** Опрос одного ящика по идентификатору — используется ручным запуском. */
export async function pollAccountById(
  deps: RunnerDeps,
  accountId: string,
  options: PollOptions,
): Promise<PollResult | null> {
  const [account] = await deps.db
    .select()
    .from(mailAccounts)
    .where(eq(mailAccounts.id, accountId));
  if (!account) {
    deps.log?.warn?.({ accountId }, 'ящик не найден');
    return null;
  }
  return pollMailAccount(deps, account, options);
}

export type SweepSummary = {
  accounts: number;
  polled: number;
  skipped: number;
  errors: number;
};

/**
 * Проход по всем ящикам с включённым опросом.
 *
 * Ошибка одного ящика не останавливает обход остальных: недоступный сервер
 * одного подрядчика не должен блокировать приём документов по другим.
 */
export async function pollAllAccounts(
  deps: RunnerDeps,
  options: PollOptions,
): Promise<SweepSummary> {
  const accounts = await listPollableAccounts(deps.db);
  const summary: SweepSummary = { accounts: accounts.length, polled: 0, skipped: 0, errors: 0 };

  for (const account of accounts) {
    try {
      const result = await pollMailAccount(deps, account, options);
      if (result.skipped) {
        summary.skipped += 1;
        deps.log?.info?.({ accountId: account.id, reason: result.skipped }, 'опрос пропущен');
        continue;
      }
      summary.polled += 1;
      deps.log?.info?.(
        {
          accountId: account.id,
          fetched: result.fetched,
          stored: result.stored,
          duplicates: result.duplicates,
          failed: result.failed,
          watermark: result.watermarkAfter,
          uidValidityReset: result.uidValidityReset,
        },
        'опрос ящика завершён',
      );
    } catch (err) {
      summary.errors += 1;
      deps.log?.error?.({ err, accountId: account.id }, 'опрос ящика упал');
      deps.onError?.(err, account.id);
    }
  }

  return summary;
}
