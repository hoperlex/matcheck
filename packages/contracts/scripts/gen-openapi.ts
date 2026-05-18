/**
 * Генерирует packages/contracts/openapi.json из Zod-схем.
 *
 * Запуск:  pnpm --filter @matcheck/contracts gen:openapi
 *
 * Артефакт коммитится в репо и проверяется в CI (contracts-drift workflow).
 * Из него коллега-разработчик Android-клиента генерирует Kotlin-клиент:
 *   openapi-generator-cli generate -i openapi.json -g kotlin \
 *     -o ./generated --additional-properties=library=jvm-retrofit2,\
 *        serializationLibrary=kotlinx_serialization,dateLibrary=java8
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from '../src/openapi/registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outPath = resolve(__dirname, '..', 'openapi.json');

const generator = new OpenApiGeneratorV31(registry.definitions);

const document = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'matcheck Mobile API',
    version: '1.0.0',
    description:
      'API для внешних клиентов matcheck (мобильные приложения, интеграции).\n\n' +
      'Базовый URL: `https://matcheck.fvds.ru/api/v1/`.\n\n' +
      'Auth: Bearer JWT (Ed25519). Для мобильных клиентов используется заголовок ' +
      '`X-Client-Type: mobile` — в этом случае refresh-token возвращается в теле ' +
      'ответа `/auth/login` и `/auth/refresh`, cookies не устанавливаются.\n\n' +
      'Подробная документация: см. `docs/MOBILE_API.md` в репозитории.',
    contact: {
      name: 'matcheck',
      url: 'https://matcheck.fvds.ru',
    },
  },
  servers: [
    { url: 'https://matcheck.fvds.ru', description: 'Production' },
    { url: 'http://localhost:3001', description: 'Local dev' },
  ],
  tags: [
    { name: 'Auth', description: 'Аутентификация и управление сессией' },
    { name: 'Sync', description: 'Дельта-синхронизация и real-time-уведомления' },
    { name: 'Deliveries', description: 'Приёмки материалов' },
    { name: 'Shipments', description: 'Отгрузки материалов' },
    { name: 'SourceDocuments', description: 'Входящие документы (УПД)' },
    { name: 'Photos', description: 'Загрузка и доступ к фото' },
    { name: 'References', description: 'Справочники (контрагенты, материалы, статусы)' },
  ],
});

writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n', 'utf8');

const componentCount = Object.keys(document.components?.schemas ?? {}).length;
const pathCount = Object.keys(document.paths ?? {}).length;

// eslint-disable-next-line no-console
console.log(
  `✓ ${outPath}\n  schemas: ${componentCount}, paths: ${pathCount}`,
);
