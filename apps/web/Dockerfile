# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
# Копируем только входы портала, а не весь репозиторий: тогда коммит в API не
# меняет ни один слой этого образа. На этом же держится правило ревизии в
# scripts/build-env.sh («WEB_REV — последний коммит вне apps/api»), поэтому из
# apps/api сюда ничего копировать нельзя (кроме package.json в deps-стадии).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
# Sentry (опционально). VITE_SENTRY_DSN/RELEASE попадают в бандл (публичные).
# SENTRY_ORG/PROJECT — для загрузки source maps. SENTRY_AUTH_TOKEN — СЕКРЕТ, только
# через BuildKit secret mount (в образ и слои НЕ попадает). Без токена
# @sentry/vite-plugin отключается (disable:true) — сборка идентична прежней.
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_RELEASE=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_SENTRY_RELEASE=$VITE_SENTRY_RELEASE \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_PROJECT=$SENTRY_PROJECT
# Отпечаток сборочных настроек Sentry (DSN, org, project, release и «токен есть
# или нет» — без самого токена), его считает scripts/build-env.sh. Секрет в
# ключ кэша не входит, поэтому без этого аргумента сборка без токена осталась
# бы в кэше и после его появления: карты так и не загрузились бы.
ARG MATCHECK_WEB_CFG=""
RUN --mount=type=secret,id=sentry_auth_token \
    export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)"; \
    pnpm --filter @matcheck/contracts typecheck \
 && pnpm --filter @matcheck/web build

FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
# По меткам deploy.sh видит, из какой ревизии и с какими настройками собран
# запущенный контейнер, и не пересобирает портал, если ни то ни другое не
# изменилось. Пустые значения сборку не роняют — просто вызовут пересборку на
# следующем деплое.
ARG MATCHECK_REV=""
ARG MATCHECK_WEB_CFG=""
LABEL org.opencontainers.image.revision=$MATCHECK_REV \
      matcheck.build-config=$MATCHECK_WEB_CFG
EXPOSE 80
