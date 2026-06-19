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
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /repo/packages/contracts/node_modules ./packages/contracts/node_modules
COPY . .
RUN pnpm --filter @matcheck/contracts typecheck \
 && pnpm --filter @matcheck/api typecheck

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# tini — корректный init для PID 1.
# poppler-utils — даёт `pdftoppm`, который domain/edo/upd-vision.parser.ts
# вызывает через child_process для конвертации PDF-сканов УПД в PNG перед
# отправкой в OpenRouter Vision (OpenRouter не принимает application/pdf
# напрямую). Без этого пакета сканированные PDF из 1С будут падать с
# `parse_failed` reason='pdf_render_error'. На Alpine пакет занимает ~6 МБ.
# libreoffice — нужен для Excel→PDF→PNG fallback: старые .xls и нестандартные
# .xlsx из 1С/ERP рендерим в картинку и отправляем в Vision, если структурный
# Excel-парсер не смог извлечь позиции. font-noto нужен для корректного
# отображения кириллицы при headless-конвертации.
RUN apk add --no-cache tini poppler-utils libreoffice font-noto && corepack enable && corepack prepare pnpm@9.12.0 --activate
# Сохраняем pnpm-структуру монорепо, чтобы workspace-symlinks (@matcheck/contracts) и
# .pnpm-symlinks (fastify, drizzle и пр.) корректно резолвились в runtime.
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/tsconfig.base.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/packages/contracts ./packages/contracts
# tsx запускает TypeScript-источники напрямую: tsc-сборка не делается, потому что
# @matcheck/contracts имеет main: ./src/index.ts (без отдельного dist).
WORKDIR /app/apps/api
USER node
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
