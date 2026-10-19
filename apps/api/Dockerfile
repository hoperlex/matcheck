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
# Копируем только входы API, а не весь репозиторий.
#
# Тогда коммит в портал не меняет ни один слой этого образа, и сборка API на
# нём целиком берётся из кэша. На этом же держится правило ревизии в
# scripts/build-env.sh: «API_REV — последний коммит вне apps/web». Поэтому из
# apps/web сюда ничего копировать нельзя (кроме package.json в deps-стадии —
# он нужен install'у workspace, а зависимости и так фиксирует lockfile).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages/contracts ./packages/contracts
COPY apps/api ./apps/api
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
# tesseract-ocr + tesseract-ocr-data-osd — даёт `tesseract --psm 0` (OSD,
# Orientation & Script Detection). domain/edo/upd-page-prefilter.ts вызывает
# его для определения угла физически-повёрнутых УПД-страниц перед Vision
# (см. detectRotationOsd). data-osd — модель ориентации (osd.traineddata),
# без неё `--psm 0` падает. На Alpine это два отдельных пакета из community.
# ВАЖНО: имена пакетов alpine-специфичны (на Debian/Ubuntu — tesseract-ocr-osd);
# подтвердить доступность при первом `docker build`.
# libwebp-tools (`dwebp`) и libheif-tools (`heif-convert`) — декодеры картинок,
# которых не умеет jimp. Он падает на них с «Mime type image/webp does not
# support decoding», и в сборке машины это роняло ВЕСЬ комплект: одна
# фотография в webp разворачивала пакет обратно в «файл = документ». Формат
# приходит с телефонов и мессенджеров сам собой, поэтому это не экзотика.
# Вызов — domain/edo/page-render.ts, imageToPng.
#
# Эту строку НЕ ПРАВИТЬ. Слой весит больше гигабайта и на промахе кэша
# ставится с Alpine CDN около часа. Его ключ — базовый образ плюс текст
# команды, так что любая правка здесь (даже порядка пакетов), `--no-cache`,
# `--pull` или `docker pull node:22-alpine` означают этот час. Новый пакет —
# отдельным `RUN apk add` ниже.
RUN apk add --no-cache tini poppler-utils libreoffice font-noto tesseract-ocr tesseract-ocr-data-osd libwebp-tools libheif-tools && corepack enable && corepack prepare pnpm@9.12.0 --activate
# Сохраняем pnpm-структуру монорепо, чтобы workspace-symlinks (@matcheck/contracts) и
# .pnpm-symlinks (fastify, drizzle и пр.) корректно резолвились в runtime.
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /repo/tsconfig.base.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api ./apps/api
COPY --from=build /repo/packages/contracts ./packages/contracts
# Отпечаток кода, вшитый в образ.
#
# Зачем. Скрипты сверки промптов (scripts/upd-prompt-ab.ts) пишут в отчёт
# ревизию, на которой он снят, и отказываются сводить части, снятые на разном
# коде. В образе `.git` нет, поэтому `git rev-parse` там возвращает null, и все
# прод-отчёты выглядели одинаково «неизвестными», то есть совместимыми между
# собой. Фиксируем ревизию здесь, файлом.
#
# Значение даёт scripts/build-env.sh: последний коммит, менявший что-либо вне
# apps/web. Содержимое всех входов этого образа в нём совпадает с HEAD, поэтому
# отпечаток честный — и не меняется от коммитов в портал, так что этот слой не
# ломает кэш. Тот же скрипт не начинает сборку на грязном дереве: образ с
# незакоммиченными правками, помеченный SHA чистого коммита, хуже отсутствия
# отпечатка.
#
# Метка с тем же значением нужна deploy.sh: по ней он видит, на какой ревизии
# запущен контейнер, и не собирает API, если она не изменилась.
#
# Слой стоит последним и обязан оставаться ПОСЛЕ apk add: ARG выше попал бы в
# ключ кэша слоя с LibreOffice.
ARG BUILD_SHA
LABEL org.opencontainers.image.revision=$BUILD_SHA
RUN if ! printf '%s' "$BUILD_SHA" | grep -qxE '[0-9a-f]{40}'; then \
      echo 'СБОРКА ОСТАНОВЛЕНА: не передан BUILD_SHA (40 hex) — собирайте через scripts/deploy.sh' >&2; \
      echo 'или вручную после `. scripts/build-env.sh` (см. docs/DEPLOY.md).' >&2; \
      exit 1; \
    fi \
 && printf '%s\n' "$BUILD_SHA" > /app/BUILD_SHA
# tsx запускает TypeScript-источники напрямую: tsc-сборка не делается, потому что
# @matcheck/contracts имеет main: ./src/index.ts (без отдельного dist).
WORKDIR /app/apps/api
USER node
EXPOSE 3001
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/index.ts"]
