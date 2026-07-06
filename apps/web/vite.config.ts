import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' (а не 'autoUpdate'): новый service worker встаёт в
      // waiting и НЕ забирает контроль автоматически. Пользователь видит
      // баннер «Доступна новая версия» → жмёт «Обновить» → клиентский
      // код шлёт SW.postMessage('SKIP_WAITING') и делает reload. Без
      // этого режима автообновление работает «втихую» при следующей
      // навигации, но открытая вкладка-портал может бесконечно сидеть
      // на старом JS-бандле и упрётся в 404 от API после deploy
      // (новые endpoint'ы, удалённые роуты и т.п.).
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'favicon.ico', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'matcheck — приёмка материалов',
        short_name: 'matcheck',
        description: 'Портал автоматизации приёмки материалов',
        theme_color: '#1677ff',
        background_color: '#ffffff',
        display: 'standalone',
        lang: 'ru',
        start_url: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // skipWaiting/clientsClaim в prompt-mode НЕ ставим: иначе новый
        // SW мгновенно активируется и режим теряет смысл. Activation
        // делает useUpdatePrompt при подтверждении пользователем.
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/v1\/sync/,
            handler: 'NetworkFirst',
            options: { cacheName: 'sync', networkTimeoutSeconds: 5 },
          },
          {
            urlPattern: /^\/api\/v1\/photos\/.*\/url/,
            handler: 'NetworkFirst',
            options: { cacheName: 'photo-urls', networkTimeoutSeconds: 5 },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    // Sentry: загрузка source maps на этапе прод-сборки. Полностью ОТКЛЮЧЁН без
    // SENTRY_AUTH_TOKEN (локальные/dev сборки не затрагиваются). Токен — только в
    // окружении сборки (BuildKit secret), НЕ в бандл и НЕ в репозиторий. Плагин
    // идёт последним. filesToDeleteAfterUpload чистит .map из dist после аплоада,
    // чтобы карты не раздавались nginx (в паре с sourcemap:'hidden').
    sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      disable: !process.env.SENTRY_AUTH_TOKEN,
      sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    // 'hidden' — карты генерируются, но НЕ ссылаются из бандла (нет
    // sourceMappingURL). Загружаются в Sentry плагином и удаляются из dist,
    // так что публично (nginx) .map не раздаются. Раньше было true → .map утекали.
    sourcemap: 'hidden',
  },
  worker: {
    format: 'es',
  },
});
