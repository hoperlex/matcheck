/**
 * Инвариант проводки: боевой сервер обязан регистрировать плагин прав.
 *
 * assertPermission намеренно терпит отсутствие декоратора `permissions` —
 * иначе любой Fastify, собранный без плагина (так делают интеграционные
 * тесты отдельных роутов), падал бы с 500 на upsert. Расплата за эту
 * терпимость: если плагин выпадет из server.ts, enforcement отключится
 * МОЛЧА — сервер продолжит работать, просто перестанет что-либо запрещать.
 *
 * Тест закрывает ровно эту дыру и делает её ошибкой сборки, а не сюрпризом
 * на бою.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_TS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.ts');

describe('проводка плагина прав', () => {
  it('server.ts импортирует и регистрирует permissionsPlugin', async () => {
    const src = await readFile(SERVER_TS, 'utf8');
    expect(src).toMatch(/import\s+permissionsPlugin\s+from\s+'\.\/plugins\/permissions\.js'/);
    expect(src).toMatch(/await app\.register\(permissionsPlugin\)/);
  });

  it('плагин прав регистрируется ПОСЛЕ authPlugin', async () => {
    const src = await readFile(SERVER_TS, 'utf8');
    const auth = src.indexOf('await app.register(authPlugin)');
    const perms = src.indexOf('await app.register(permissionsPlugin)');
    expect(auth).toBeGreaterThan(-1);
    expect(perms).toBeGreaterThan(-1);
    // Плагину нужен req.user, который заполняет onRequest-хук authPlugin.
    expect(perms).toBeGreaterThan(auth);
  });

  it('плагин прав регистрируется ДО роутов', async () => {
    const src = await readFile(SERVER_TS, 'utf8');
    const perms = src.indexOf('await app.register(permissionsPlugin)');
    const firstRoute = src.indexOf('await app.register(healthRoutes)');
    expect(firstRoute).toBeGreaterThan(perms);
  });

  it('read-only-гард живёт в плагине, а не отдельным хуком в server.ts', async () => {
    // Пока гард был здесь, он отбивал мутации монитора РАНЬШЕ матрицы, и
    // выданное право не работало никогда. Возврат хардкода в server.ts вернул
    // бы ту же дыру молча — поэтому проверяем, что его тут нет.
    const src = await readFile(SERVER_TS, 'utf8');
    expect(src).not.toMatch(/MONITOR_WRITE_ROUTES/);
    expect(src).not.toMatch(/Read-only role/);
  });
});
