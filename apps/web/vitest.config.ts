import { defineConfig } from 'vitest/config';

// Отдельный конфиг для тестов: НЕ тянем vite.config.ts (там PWA/Sentry/react-
// плагины, ненужные и тяжёлые для юнит-тестов). Node-окружение — тестируем
// чистую логику без DOM. Файлы с DOM/idb добавят jsdom-окружение точечно
// через // @vitest-environment.
export default defineConfig({
  test: {
    environment: 'node',
    // .tsx — render-тесты permission-aware контролов. Они поднимают jsdom
    // сами, директивой `// @vitest-environment jsdom`: держать jsdom общим
    // окружением ради нескольких файлов значило бы замедлить остальные ~160
    // тестов, которые в DOM не нуждаются.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Полифиллы того, чего в jsdom нет (ResizeObserver, matchMedia,
    // createObjectURL), и подавление известного jsdom-шума. В node-окружении
    // файл ничего не делает — см. guard внутри.
    setupFiles: ['./src/test/setup.ts'],
  },
});
