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
  const bail = (kind: 'uncaughtException' | 'unhandledRejection') => {
    return (err: unknown): void => {
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
