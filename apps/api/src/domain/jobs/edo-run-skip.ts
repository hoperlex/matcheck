/**
 * Работа под лизом учётки ЭДО не запускалась: учётка занята, нет ящика или
 * самой учётки. Отдельный модуль без зависимостей — его проверяют скрипты и
 * тесты, которым не нужен весь раннер.
 */
export type EdoRunSkip = { skipped: 'lease_taken' | 'no_box' | 'not_found' };

const RUN_SKIPS: ReadonlySet<unknown> = new Set(['lease_taken', 'no_box', 'not_found']);

/**
 * Проверять по значению, а не по наличию поля: у результата самой работы может
 * быть своё поле `skipped` (у описи договоров это счётчики пропущенных
 * документов), и проверка «поле есть» принимала такую опись за отказ.
 */
export function isRunnerSkipped(value: unknown): value is EdoRunSkip {
  return Boolean(value) && typeof value === 'object' && RUN_SKIPS.has((value as { skipped?: unknown }).skipped);
}
