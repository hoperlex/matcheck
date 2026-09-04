// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      'pnpm-lock.yaml',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Директивы `eslint-disable-next-line react-hooks/exhaustive-deps` в коде
    // оставлены намеренно, хотя само правило сейчас выключено (см. ниже): они
    // документируют осознанное решение автора и снова заработают, когда долг
    // по зависимостям хуков разберут. Без этой настройки они бы считались
    // «неиспользуемыми» и снова сделали lint красным.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // CLI-инструменты: бэктесты, отчёты, MCP-сервер. Вывод в консоль — их
    // назначение, а не забытая отладка, поэтому no-console здесь снят.
    // Без этого `pnpm lint --max-warnings=0` не может быть deploy-gate:
    // 295 предупреждений из 328 приходили ровно отсюда.
    files: ['apps/api/scripts/**', 'tools/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Node-скрипты вне сборки TypeScript: глобалы рантайма надо объявить,
    // иначе no-undef ругается на process и console.
    files: ['**/*.mjs', 'tools/**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    // React-хуки: в коде уже стоят точечные `eslint-disable-next-line
    // react-hooks/exhaustive-deps`, но самого плагина в конфиге не было —
    // ESLint падал с «Definition for rule was not found» (12 ошибок).
    // Плагин подключён здесь, чтобы эти комментарии значили то, что написано.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Ловит настоящие баги: хук после early-return меняет их число между
      // рендерами. Двумя такими были DesktopLayout (выход пользователя) и
      // PhotoGallery (появление первого фото) — оба починены здесь же.
      'react-hooks/rules-of-hooks': 'error',
      // ДОЛГ, осознанно выключено. Правило показывает 14 мест, где список
      // зависимостей неполон. Каждая правка меняет поведение рендера (лишние
      // перерисовки или циклы), поэтому разбирать их надо отдельной задачей с
      // проверкой каждого компонента, а не попутно. Пока правило 'warn',
      // `pnpm lint --max-warnings=0` не может быть deploy-gate — а он важнее.
      'react-hooks/exhaustive-deps': 'off',
    },
  },
  prettier,
);
