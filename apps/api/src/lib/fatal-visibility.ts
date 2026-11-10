import * as Sentry from '@sentry/node';
import { logger } from './logger.js';

/**
 * Последнее слово падающего процесса.
 *
 * Node и без нас завершает процесс на `uncaughtException` и (с 15-й версии) на
 * `unhandledRejection` — но делает это молча, если работает под pino с
 * отключённым логированием запросов. 20–21.08 из-за этого 854 рестарта API
 * прошли мимо Sentry и мимо алертов: в docker logs стек был, а в системе
 * наблюдаемости — ничего. Причину искали по внешним симптомам почти сутки.
 *
 * Обработчики НЕ меняют поведение процесса: как падал, так и падает с кодом 1.
 * Меняется единственное — теперь падение оставляет след: строку в логе с
 * `event: 'fatal'` и событие в Sentry.
 *
 * Ставить как можно раньше — до создания серверов, соединений и очередей.
 */
export function installFatalHandlers(component: 'api' | 'worker' | 'mail-worker'): void {
  /**
   * Сбой read-only базы ФОТ (лимит Odyssey / сеть) не должен ронять процесс API целиком.
   * Работало на бою с 05.11 (образ собран из незакоммиченной копии), в git перенесено
   * 10.11 без изменения кода.
   */
  const isFotSoftUnhandled = (err: unknown): boolean => {
    const anyErr = err as { code?: string; message?: string } | null;
    const code = anyErr?.code ?? '';
    const msg = anyErr?.message ?? String(err);
    if (msg.includes('FOT_Prod.mcp_readonly')) return true;
    if (msg.includes('too many active clients for user') && msg.includes('odyssey')) return true;
    if (msg.includes('warmUpFotMolCache') || msg.includes('FOT_DATABASE_URL')) return true;
    // postgres-js при обрыве соединения отдаёт ECONNRESET/53300 отдельным rejection
    if (code === '53300') return true;
    if ((code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') && msg.includes('TLSWrap')) {
      return component === 'api';
    }
    return false;
  };

  const bail = (kind: 'uncaughtException' | 'unhandledRejection') => {
    return (err: unknown): void => {
      if (kind === 'unhandledRejection' && isFotSoftUnhandled(err)) {
        logger.warn({ err, event: 'soft-unhandled', kind, component }, `${component}: swallowed FOT soft rejection`);
        return;
      }

      // Лог первым: если Sentry не сконфигурирован или недоступен, строка в
      // stdout остаётся единственным свидетельством.
      logger.error({ err, event: 'fatal', kind, component }, `${component}: ${kind}`);
      try {
        Sentry.captureException(err);
      } catch {
        // Sentry не должен мешать завершению: его собственный сбой здесь
        // означал бы потерю и лога, и кода выхода.
      }
      // Дать буферу Sentry уйти, но не дольше двух секунд — иначе падающий
      // процесс завис бы вместо рестарта. Страховочный таймер на случай, если
      // close() не разрешится вовсе.
      const hardExit = setTimeout(() => process.exit(1), 2500);
      hardExit.unref();
      void Sentry.close(2000)
        .catch(() => undefined)
        .then(() => process.exit(1));
    };
  };

  process.on('uncaughtException', bail('uncaughtException'));
  process.on('unhandledRejection', bail('unhandledRejection'));
}
