import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
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
          // TODO: добавить PNG-иконки 192/512/512-maskable для полной поддержки PWA-install.
          // Пока используется SVG-фавикон — работает в Chrome/Edge, но iOS требует PNG.
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
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
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
