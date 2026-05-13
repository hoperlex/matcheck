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
 && pnpm --filter @matcheck/api typecheck \
 && pnpm --filter @matcheck/api build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini && corepack enable && corepack prepare pnpm@9.12.0 --activate
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./node_modules-api
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/contracts ./packages/contracts
COPY apps/api/package.json ./package.json
USER node
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/apps/api/src/index.js"]
