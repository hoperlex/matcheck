import { defineConfig } from 'vitest/config';

// Отдельный конфиг для тестов: НЕ тянем vite.config.ts (там PWA/Sentry/react-
// плагины, ненужные и тяжёлые для юнит-тестов). Node-окружение — тестируем
// чистую логику без DOM. Файлы с DOM/idb добавят jsdom-окружение точечно
// через // @vitest-environment.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
