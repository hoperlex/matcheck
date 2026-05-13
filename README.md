# matcheck

Портал автоматизации приёмки материалов.

- **Backend (`apps/api`):** Fastify 5 + TypeScript + Drizzle ORM + PostgreSQL + Redis
- **Frontend (`apps/web`):** React 18 + Vite 6 + Ant Design 5 + TanStack Query + Zustand + PWA (offline-first IndexedDB sync)
- **Shared (`packages/contracts`):** общие zod-схемы для DTO между BE и FE
- **Infra (`infra/`):** Caddy + Docker Compose, `docker-compose.dev.yml` для локального Postgres+Redis

Архитектурный план: [`C:/Users/Usr/.claude/plans/cryptic-crafting-simon.md`](../.claude/plans/cryptic-crafting-simon.md).

## Требования

- Node.js ≥ 22 (см. `.nvmrc`)
- pnpm ≥ 9
- Docker (для локального Postgres+Redis или прод-деплоя)

## Локальный запуск

```bash
# 1. Зависимости
pnpm install

# 2. Локальные Postgres + Redis (Docker)
docker compose -f infra/docker-compose.dev.yml up -d

# 3. Создать .env для API
cp apps/api/.env.example apps/api/.env
# отредактировать значения (DATABASE_URL, REDIS_URL, ключи)

# 4. Сгенерировать и применить миграции
pnpm --filter @matcheck/api db:generate
pnpm --filter @matcheck/api db:migrate
# или для разработки можно сразу:
# pnpm --filter @matcheck/api db:push

# 5. Запустить dev-серверы api (3001) + web (5173)
pnpm dev
```

Открыть [http://localhost:5173](http://localhost:5173). Регистрация → сначала через UI, потом активация пользователю в БД:

```sql
UPDATE users SET is_active = true, role = 'admin' WHERE email = 'you@example.com';
```

## Скрипты

```bash
pnpm typecheck                            # tsc --noEmit во всех пакетах
pnpm lint                                 # ESLint
pnpm format                               # Prettier --write
pnpm build                                # сборка apps/api + apps/web
pnpm --filter @matcheck/api dev           # только API
pnpm --filter @matcheck/web dev           # только web
pnpm --filter @matcheck/api db:generate   # drizzle-kit generate
pnpm --filter @matcheck/api db:migrate    # применить миграции
pnpm --filter @matcheck/api db:push       # быстрый sync схемы (dev)
```

## Структура

```
matcheck/
├── apps/
│   ├── api/                # Fastify backend
│   │   ├── src/
│   │   │   ├── db/         # Drizzle schema + client
│   │   │   ├── domain/     # auth, edo, mail, llm, storage, jobs
│   │   │   ├── plugins/    # db, redis, security, auth (RBAC)
│   │   │   ├── routes/     # auth, deliveries, source-documents, photos, sync, events, admin/*
│   │   │   ├── lib/        # env, logger, fastify (zod type provider)
│   │   │   ├── scripts/    # migrate.ts
│   │   │   ├── server.ts, index.ts
│   │   ├── Dockerfile
│   │   ├── drizzle.config.ts
│   │   └── .env.example
│   └── web/                # React PWA
│       ├── src/
│       │   ├── app/        # router, providers, layout (Mobile/Tablet/Desktop)
│       │   ├── pages/      # auth, dashboard, inbox, deliveries, kpp, references, admin, settings
│       │   ├── shared/ui/  # ProtectedRoute, ResponsiveTable
│       │   ├── services/   # api, sync, deliveries, photoPipeline, invalidation, conflictResolver
│       │   ├── lib/        # IndexedDB (idb), usePwaInstall
│       │   ├── stores/     # zustand auth
│       │   └── workers/    # imageCompress (Web Worker)
│       ├── Dockerfile, nginx.conf
│       └── vite.config.ts
├── packages/
│   └── contracts/          # zod-схемы DTO (auth, deliveries, source-documents, ...)
├── infra/
│   ├── docker-compose.yml          # prod: caddy + api + web + redis
│   ├── docker-compose.dev.yml      # dev: postgres + redis
│   └── caddy/Caddyfile             # TLS + HSTS + CSP + reverse proxy
├── pnpm-workspace.yaml, tsconfig.base.json, eslint.config.js, .prettierrc.json
```

## Деплой в production

1. **VPS с Docker** + домен, направленный на VPS.
2. Клонировать репо, создать `infra/api.env` с боевыми переменными:

   ```env
   NODE_ENV=production
   PORT=3001
   DATABASE_URL=postgres://USER:PASS@yc-pg-host:6432/matcheck?sslmode=verify-full
   REDIS_URL=redis://redis:6379
   CORS_ORIGIN=https://matcheck.example.com
   COOKIE_SECURE=true
   COOKIE_DOMAIN=matcheck.example.com

   # Шифрование sensitive полей (см. SECURITY DEBT в плане)
   APP_FIELD_ENCRYPTION_KEYS={"v1":"<base64-32B>"}
   APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION=v1

   # JWT keys (EdDSA Ed25519) — сгенерировать через openssl
   JWT_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----..."
   JWT_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----..."

   # S3 cloud.ru
   S3_ENDPOINT=https://s3.cloud.ru
   S3_BUCKET=matcheck-photos
   S3_REGION=ru-central-1
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   ```

3. `chmod 600 infra/api.env`
4. `export CADDY_DOMAIN=matcheck.example.com CADDY_ACME_EMAIL=ops@example.com`
5. `docker compose -f infra/docker-compose.yml up -d --build`
6. Применить миграции в Yandex Managed PostgreSQL:
   ```bash
   docker compose exec api node -e "require('./scripts/migrate.js')"
   ```
   (или запустить миграции с локальной машины с прокинутым DATABASE_URL).

## Известные ограничения / SECURITY DEBT

1. **Шифрование credentials хранит ключ в `.env`** (без KEK/Lockbox). Достаточно для MVP, но при росте проекта нужно перейти на envelope-encryption с KEK в Yandex Lockbox. Подробнее см. план.
2. **Diadoc adapter** — каркас под актуальный API. Перед prod-использованием уточнить эндпоинты и доработать парсинг ответа `GetDocumentsByMessageId`.
3. **Дев JWT keys генерируются эфемерно** при отсутствии в env. В production обязательно прописать `JWT_PRIVATE_KEY_PEM` / `JWT_PUBLIC_KEY_PEM` (иначе старт упадёт).
4. **PWA-иконки** — пока только SVG. Для полноценной установки на iOS нужно добавить PNG 192/512/512-maskable в `apps/web/public/`.
5. **Distributed tracing / Sentry** не подключены — есть только pino-логи.
