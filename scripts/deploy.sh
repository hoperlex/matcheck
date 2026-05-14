#!/usr/bin/env bash
# scripts/deploy.sh — одношаговый деплой matcheck в проде.
#
# Использование (на mosgate, под пользователем matcheck):
#   cd /srv/matcheck/app
#   ./scripts/deploy.sh
#
# Делает:
#   1. git pull
#   2. docker compose build matcheck-api matcheck-web
#   3. migrations-status.ts  (read-only, точка отсчёта)
#   4. migrate.ts            (применяет pending-миграции)
#   5. migrations-status.ts  (контрольный замер)
#   6. docker compose up -d --force-recreate matcheck-api matcheck-web
#
# Печатает в конце таблицу-сводку: коммит, статус сборки, сколько миграций
# применено (X из Y) и список их тегов, статус контейнеров.
#
# НЕ делает (остаётся ручным):
#   - снэпшот PG в YC Console перед миграциями;
#   - nginx -t && systemctl reload nginx (под root);
#   - проверку соседних сайтов через baseline;
#   - финальные smoke-curl-ы.
# См. docs/DEPLOY.md, раздел «Обновление кода (универсальная команда)».

set -euo pipefail

main() {
  if [[ -t 1 ]]; then
    BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; CYAN=$'\e[36m'; NC=$'\e[0m'
  else
    BOLD=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
  fi

  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  COMPOSE=(docker compose -f infra/docker-compose.prod.yml)

  STATUS_BEFORE=""
  STATUS_AFTER=""
  trap 'rm -f "${STATUS_BEFORE:-}" "${STATUS_AFTER:-}"' EXIT

  step() { echo; echo "${BOLD}${CYAN}━━ $* ━━${NC}"; }

  # ─── 1/6 · git pull ───
  step "1/6 · git pull"
  COMMIT_BEFORE=$(git rev-parse --short HEAD)
  git pull --ff-only
  COMMIT_AFTER=$(git rev-parse --short HEAD)
  git log --oneline -1

  # ─── 2/6 · build ───
  step "2/6 · build образов (matcheck-api, matcheck-web)"
  "${COMPOSE[@]}" build matcheck-api matcheck-web

  # ─── 3/6 · миграции ДО ───
  step "3/6 · миграции — статус ДО"
  STATUS_BEFORE=$(mktemp)
  "${COMPOSE[@]}" run --rm matcheck-api node_modules/.bin/tsx scripts/migrations-status.ts \
    | tee "$STATUS_BEFORE"
  APPLIED_BEFORE=$(grep -oP '\[migrations\] applied: \K\d+'                "$STATUS_BEFORE" || echo 0)
  PENDING_BEFORE=$(grep -oP 'applied: \d+ / journal: \d+ / pending: \K\d+' "$STATUS_BEFORE" || echo 0)
  PENDING_TAGS=$(  grep    '^\[migrations\] pending tags:'                 "$STATUS_BEFORE" \
                 | sed 's/^\[migrations\] pending tags: //' || true)

  # ─── 4/6 · migrate ───
  step "4/6 · применение миграций"
  "${COMPOSE[@]}" run --rm matcheck-api node_modules/.bin/tsx scripts/migrate.ts

  # ─── 5/6 · миграции ПОСЛЕ ───
  step "5/6 · миграции — статус ПОСЛЕ"
  STATUS_AFTER=$(mktemp)
  "${COMPOSE[@]}" run --rm matcheck-api node_modules/.bin/tsx scripts/migrations-status.ts \
    | tee "$STATUS_AFTER"
  APPLIED_AFTER=$(grep -oP '\[migrations\] applied: \K\d+'                "$STATUS_AFTER" || echo 0)
  PENDING_AFTER=$(grep -oP 'applied: \d+ / journal: \d+ / pending: \K\d+' "$STATUS_AFTER" || echo 0)
  APPLIED_NOW=$(( APPLIED_AFTER - APPLIED_BEFORE ))

  # ─── 6/6 · up -d ───
  step "6/6 · пересоздание контейнеров"
  "${COMPOSE[@]}" up -d --force-recreate matcheck-api matcheck-web

  # ─── Сводка ───
  echo
  echo "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
  echo "${BOLD}║                    Сводка деплоя                         ║${NC}"
  echo "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"

  if [[ "$COMMIT_BEFORE" == "$COMMIT_AFTER" ]]; then
    printf "  %-18s ${GREEN}✓${NC} %s (без изменений)\n" "Git pull" "$COMMIT_AFTER"
  else
    printf "  %-18s ${GREEN}✓${NC} %s → %s\n"            "Git pull" "$COMMIT_BEFORE" "$COMMIT_AFTER"
  fi

  printf "  %-18s ${GREEN}✓${NC} %s\n" "Сборка образов" "matcheck-api, matcheck-web"

  if (( PENDING_BEFORE == 0 )); then
    printf "  %-18s ${GREEN}✓${NC} нет новых (всего в БД: %d)\n" "Миграции" "$APPLIED_AFTER"
  elif (( APPLIED_NOW == PENDING_BEFORE && PENDING_AFTER == 0 )); then
    printf "  %-18s ${GREEN}✓${NC} %d из %d применена(о)\n" "Миграции" "$APPLIED_NOW" "$PENDING_BEFORE"
    if [[ -n "$PENDING_TAGS" ]]; then
      printf "  %-18s   %s\n" "" "$PENDING_TAGS"
    fi
  else
    printf "  %-18s ${YELLOW}!${NC} ожидалось %d, применено %d (pending после: %d)\n" \
      "Миграции" "$PENDING_BEFORE" "$APPLIED_NOW" "$PENDING_AFTER"
  fi

  printf "  %-18s ${GREEN}✓${NC} matcheck-api, matcheck-web up\n" "Контейнеры"
  echo
  echo "${BOLD}${GREEN}  Деплой завершён успешно${NC}"
  echo
}

main "$@"
