import type { FastifyRequest } from 'fastify';
import type { PageAction, PageId } from '@matcheck/contracts';
import { isAllowed } from './matrix.js';
import { PermissionError } from './error.js';

/**
 * Проверка права внутри хендлера — для маршрутов класса `in-handler`, где
 * страница или действие неизвестны до обращения к БД:
 *   • POST /deliveries|/shipments — upsert, create или edit решается
 *     наличием строки (наличие input.id не годится: офлайн-запись с планшета
 *     приходит с готовым UUID);
 *   • /photos/* — вид операции виден только после findPhoto().
 *
 * ВАЖНО про порядок вызова в /photos/*: assertPermission ставится ПОСЛЕ
 * существующих проверок видимости конкретной строки (siteId инспектора,
 * photoVisibleToContractor) и ДО работы с S3. Эти проверки намеренно
 * отвечают 404, чтобы не раскрывать существование чужого фото; поставив
 * права первыми, мы превратили бы 404 в 403 и слили бы сам факт наличия
 * записи.
 *
 * Бросает PermissionError (403 permission_denied) — его подхватывает общий
 * error-handler.
 */
export async function assertPermission(
  req: FastifyRequest,
  page: PageId,
  action: PageAction,
): Promise<void> {
  const app = req.server;
  // Плагин прав может быть не зарегистрирован — так собирают Fastify
  // интеграционные тесты отдельных роутов. Отсутствие декоратора равносильно
  // выключенному enforcement; падать с 500 из-за необъявленной зависимости
  // нельзя (на 5xx мобильный MutationProcessor уходит в Backoff, и очередь
  // мутаций на планшете встаёт намертво). Что боевой сервер плагин
  // действительно регистрирует — проверяет отдельный тест.
  if (!app.permissions?.enforced) return;

  const user = req.user;
  // Публичный роут: req.user не заполняется, матрице нечего проверять.
  if (!user) return;
  if (user.role === 'admin') return;

  const overrides = await app.permissions.get();
  if (isAllowed(overrides, user.role, page, action)) return;

  await app.logUnauthorized(req, 403, `permission_denied:${page}:${action}`, user.id);
  throw new PermissionError(page, action);
}
