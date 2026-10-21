#!/usr/bin/env bash
# scripts/deploy.sh — одношаговый деплой matcheck в проде.
#
# Использование (на mosgate, под пользователем matcheck):
#   cd /srv/matcheck/app
#   ./scripts/deploy.sh            # обычный деплой
#   ./scripts/deploy.sh --plan     # git pull и показать, что будет сделано; ничего не собирать
#   ./scripts/deploy.sh --force    # собрать обе стороны и пересоздать все контейнеры
#                                  # (с обычным кэшем сборки — это НЕ сброс кэша)
#   ./scripts/deploy.sh --no-pull  # деплой текущего HEAD без git pull (откат через checkout)
#
# Делает:
#   1. git pull
#   2. scripts/build-env.sh — стоп на грязном дереве, ревизии сторон, настройки Sentry
#   3. решает, что собирать: сторону (API или портал) собираем, только если её
#      ревизия отличается от той, на которой запущены её контейнеры
#   4. docker compose build — только нужные образы, по очереди
#   5. migrations-status.ts  (read-only, точка отсчёта)
#   6. migrate.ts            (применяет pending-миграции; запускается всегда)
#   7. migrations-status.ts  (контрольный замер)
#   8. если воркер будет пересоздан — ждёт его текущее задание (до 10 минут),
#      затем docker compose up -d --wait: compose сам пересоздаёт контейнеры, у
#      которых сменился образ или конфигурация (в том числе api.env), и ждёт healthcheck
#
# Печатает в конце таблицу-сводку: коммит, что собрано, сколько миграций
# применено (X из Y) и их теги, ждали ли воркер, какие контейнеры пересозданы.
#
# НЕ делает (остаётся ручным):
#   - снэпшот PG в YC Console перед миграциями;
#   - nginx -t && systemctl reload nginx (под root);
#   - проверку соседних сайтов через baseline;
#   - финальные smoke-curl-ы (--wait проверяет только healthcheck контейнеров).
# См. docs/DEPLOY.md, раздел «Обновление кода скриптом».

set -euo pipefail

# UTF-8 локаль нужна, чтобы ${#str} считал символы (codepoints), а не байты —
# без этого pad() ниже выравнивает русские labels неправильно.
export LC_ALL="${LC_ALL:-C.UTF-8}"

main() {
  if [[ -t 1 ]]; then
    BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; CYAN=$'\e[36m'; NC=$'\e[0m'
  else
    BOLD=''; GREEN=''; YELLOW=''; CYAN=''; NC=''
  fi

  # Выравнивание метки до фиксированной ширины В СИМВОЛАХ (а не байтах).
  # printf %-Ns считает байты — кириллица в UTF-8 = 2 байта, и колонки съезжают.
  pad() {
    local label="$1" width="${2:-15}" len=${#1} n
    n=$(( width - len ))
    (( n < 0 )) && n=0
    printf '%s%*s' "$label" "$n" ''
  }

  local FORCE=0 PLAN=0 PULL=1 arg
  for arg in "$@"; do
    case "$arg" in
      --force)   FORCE=1 ;;
      --plan)    PLAN=1 ;;
      --no-pull) PULL=0 ;;
      *)
        echo "Неизвестный аргумент: $arg (допустимо: --plan, --force, --no-pull)" >&2
        return 2
        ;;
    esac
  done

  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  COMPOSE=(docker compose -f infra/docker-compose.prod.yml)

  # Почтовый воркер подхватывается, только если его уже подняли руками.
  #
  # Пока почта не запущена, контейнера нет — и деплой о нём не знает. Но как
  # только его подняли, он ОБЯЗАН обновляться вместе с остальными: иначе приём
  # писем молча остался бы на коде того дня, когда контейнер запустили, и
  # расхождение обнаружилось бы через недели.
  API_FAMILY=(matcheck-api matcheck-worker)
  if [ -n "$("${COMPOSE[@]}" ps -aq matcheck-mail-worker 2>/dev/null)" ]; then
    API_FAMILY+=(matcheck-mail-worker)
  fi
  SERVICES=("${API_FAMILY[@]}" matcheck-web)

  STATUS_BEFORE=""
  STATUS_AFTER=""
  trap 'rm -f "${STATUS_BEFORE:-}" "${STATUS_AFTER:-}"' EXIT

  step() { echo; echo "${BOLD}${CYAN}━━ $* ━━${NC}"; }

  REV_LABEL=org.opencontainers.image.revision
  CFG_LABEL=matcheck.build-config

  # Метка контейнера; пусто, если нет контейнера или метки.
  container_label() {
    local v
    v=$(docker container inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null) || return 0
    [[ "$v" == '<no value>' ]] && v=''
    printf '%s' "$v"
  }
  container_exists() { docker container inspect "$1" >/dev/null 2>&1; }
  short() { if [[ -n "$1" ]]; then printf '%s' "${1:0:12}"; else printf 'нет метки'; fi; }

  # ─── 1/8 · git pull ───
  step "1/8 · git pull"
  COMMIT_BEFORE=$(git rev-parse --short HEAD)
  if (( PULL )); then
    git pull --ff-only
  else
    echo "  пропущен (--no-pull): деплоится текущий HEAD"
  fi
  COMMIT_AFTER=$(git rev-parse --short HEAD)
  git log --oneline -1

  # ─── 2/8 · окружение сборки ───
  step "2/8 · окружение сборки"
  # shellcheck source=scripts/build-env.sh
  . scripts/build-env.sh || exit 1
  echo "  ревизия API:    $(short "$MATCHECK_API_REV")"
  echo "  ревизия портала: $(short "$MATCHECK_WEB_REV")  (настройки сборки $MATCHECK_WEB_CFG)"

  # ─── 3/8 · что менять ───
  #
  # Сравниваем с тем, что ЗАПУЩЕНО, а не с HEAD до pull: если прошлый деплой упал
  # после pull, повтор увидит старые метки на контейнерах и доделает работу.
  # Решение влияет только на сборку и на явное ожидание воркера. Пересоздаёт
  # контейнеры compose по своим правилам (новый образ под тегом, изменённая
  # конфигурация), а миграции идут на каждом деплое — поэтому даже ошибка
  # здесь не оставит прод на старом коде.
  step "3/8 · что менять"
  local c cur cfg BUILD_API=$FORCE BUILD_WEB=$FORCE
  for c in "${API_FAMILY[@]}"; do
    if ! container_exists "$c"; then
      printf '  %s нет контейнера\n' "$(pad "$c" 22)"; BUILD_API=1; continue
    fi
    cur=$(container_label "$c" "$REV_LABEL")
    if [[ "$cur" == "$MATCHECK_API_REV" ]]; then
      printf '  %s %s — актуальна\n' "$(pad "$c" 22)" "$(short "$cur")"
    else
      printf '  %s %s → %s\n' "$(pad "$c" 22)" "$(short "$cur")" "$(short "$MATCHECK_API_REV")"
      BUILD_API=1
    fi
  done
  if ! container_exists matcheck-web; then
    printf '  %s нет контейнера\n' "$(pad matcheck-web 22)"; BUILD_WEB=1
  else
    cur=$(container_label matcheck-web "$REV_LABEL")
    cfg=$(container_label matcheck-web "$CFG_LABEL")
    if [[ "$cur" == "$MATCHECK_WEB_REV" && "$cfg" == "$MATCHECK_WEB_CFG" ]]; then
      printf '  %s %s — актуальна\n' "$(pad matcheck-web 22)" "$(short "$cur")"
    else
      printf '  %s %s → %s' "$(pad matcheck-web 22)" "$(short "$cur")" "$(short "$MATCHECK_WEB_REV")"
      [[ "$cfg" != "$MATCHECK_WEB_CFG" ]] && printf ' (настройки сборки %s → %s)' "${cfg:-нет}" "$MATCHECK_WEB_CFG"
      printf '\n'
      BUILD_WEB=1
    fi
  fi

  # Будет ли пересоздан воркер. Без новой сборки спрашиваем сам compose:
  # dry-run проходит тот же путь, что настоящий `up`, и видит и новый образ под
  # тегом, и изменённую конфигурацию (compose-файл, содержимое api.env).
  #
  # Не `config --hash`: на compose 2.40.3 (hub) он считает хеш иначе, чем `up`
  # при создании контейнера, и расходится с меткой com.docker.compose.config-hash
  # без всяких изменений — воркер ждали на каждом деплое. И спрашивать надо тот
  # же compose, что выполнит `up`: хеши разных версий не совпадают.
  #
  # Если ответ не распознан, считаем, что пересоздание будет: лишнее ожидание
  # лучше SIGKILL посреди задания.
  local WORKER_WAIT=0 WORKER_WHY='' dry
  if (( FORCE )); then
    WORKER_WAIT=1; WORKER_WHY='--force'
  elif (( BUILD_API )); then
    WORKER_WAIT=1; WORKER_WHY='новый образ API'
  elif container_exists matcheck-worker; then
    dry=$("${COMPOSE[@]}" --progress plain --dry-run up -d --no-build matcheck-worker 2>&1) || dry=''
    if grep -qE 'Container[[:space:]]+matcheck-worker[[:space:]]+Recreate' <<<"$dry"; then
      WORKER_WAIT=1; WORKER_WHY='compose пересоздаст его (новый образ под тегом или изменилась конфигурация — compose, api.env)'
    elif ! grep -qE 'Container[[:space:]]+matcheck-worker[[:space:]]+(Running|Starting|Started)' <<<"$dry"; then
      WORKER_WAIT=1; WORKER_WHY='compose не ответил, ждём на всякий случай'
    fi
  fi

  echo
  printf '  %s %s\n' "$(pad 'API' 10)"    "$( (( BUILD_API )) && echo собрать || echo 'без изменений')"
  printf '  %s %s\n' "$(pad 'Портал' 10)" "$( (( BUILD_WEB )) && echo собрать || echo 'без изменений')"
  printf '  %s %s\n' "$(pad 'Воркер' 10)" "$( (( WORKER_WAIT )) && echo "будет пересоздан: $WORKER_WHY" || echo 'не трогаем')"
  (( FORCE )) && echo "  --force: собираем обе стороны и пересоздаём все контейнеры"

  if (( PLAN )); then
    echo
    echo "  --plan: ничего не собрано и не пересоздано. Миграции при деплое проверяются всегда."
    return 0
  fi

  # ─── 4/8 · сборка ───
  #
  # По очереди, а не параллельно: на VPS 2 ядра и мало свободной памяти, tsc и
  # vite одновременно уводят его в swap. worker и mail-worker не собираем — у них
  # тот же образ, его собирает matcheck-api.
  step "4/8 · сборка"
  local BUILT=()
  if (( BUILD_API )); then "${COMPOSE[@]}" build matcheck-api; BUILT+=(API); fi
  if (( BUILD_WEB )); then "${COMPOSE[@]}" build matcheck-web; BUILT+=(портал); fi
  (( ${#BUILT[@]} )) || echo "  не требуется"

  # ─── 5/8 · миграции ДО ───
  #
  # Миграции — на каждом деплое, даже если API не собирали: они идемпотентны и
  # стоят секунды, а пропуск по признаку «образ не менялся» оставил бы БД без
  # миграции, если контейнеры после упавшего migrate пересоздали руками.
  step "5/8 · миграции — статус ДО"
  STATUS_BEFORE=$(mktemp)
  "${COMPOSE[@]}" run --rm matcheck-api node_modules/.bin/tsx scripts/migrations-status.ts \
    | tee "$STATUS_BEFORE"
  APPLIED_BEFORE=$(grep -oP '\[migrations\] applied: \K\d+'                "$STATUS_BEFORE" || echo 0)
  PENDING_BEFORE=$(grep -oP 'applied: \d+ / journal: \d+ / pending: \K\d+' "$STATUS_BEFORE" || echo 0)
  PENDING_TAGS=$(  grep    '^\[migrations\] pending tags:'                 "$STATUS_BEFORE" \
                 | sed 's/^\[migrations\] pending tags: //' || true)

  # ─── 6/8 · migrate ───
  step "6/8 · применение миграций"
  "${COMPOSE[@]}" run --rm matcheck-api node_modules/.bin/tsx scripts/migrate.ts

  # ─── 7/8 · миграции ПОСЛЕ ───
  step "7/8 · миграции — статус ПОСЛЕ"
  STATUS_AFTER=$(mktemp)
  "${COMPOSE[@]}" run --rm matcheck-api node_modules/.bin/tsx scripts/migrations-status.ts \
    | tee "$STATUS_AFTER"
  APPLIED_AFTER=$(grep -oP '\[migrations\] applied: \K\d+'                "$STATUS_AFTER" || echo 0)
  PENDING_AFTER=$(grep -oP 'applied: \d+ / journal: \d+ / pending: \K\d+' "$STATUS_AFTER" || echo 0)
  APPLIED_NOW=$(( APPLIED_AFTER - APPLIED_BEFORE ))

  # ─── 8/8 · контейнеры ───
  #
  # Воркер останавливаем ОТДЕЛЬНО и с большим таймаутом. Распознавание одного
  # тяжёлого пакета идёт минутами: без явного ожидания Docker добивал процесс
  # SIGKILL'ом посреди задания, и документ оставался висеть в processing до окна
  # восстановления. Так воркер успевает доработать текущее задание и снять
  # блокировку BullMQ сам. stop_grace_period в compose — второй рубеж.
  step "8/8 · контейнеры"
  local WAITED=0
  if (( WORKER_WAIT )) && \
     "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx 'matcheck-worker'; then
    echo "  ожидание завершения активного задания воркера (до 10 минут)…"
    "${COMPOSE[@]}" stop -t 600 matcheck-worker
    WAITED=1
  fi

  local -A ID_BEFORE=()
  for c in "${SERVICES[@]}"; do
    ID_BEFORE[$c]=$(docker container inspect -f '{{.Id}}' "$c" 2>/dev/null || true)
  done

  # Без --force-recreate compose трогает только то, что изменилось: новый образ
  # под тегом, другая конфигурация, остановленный контейнер. --wait ждёт
  # healthcheck у api и web; у воркеров его нет — для них только «запущен».
  local UP=(up -d --no-build --wait --wait-timeout 300)
  (( FORCE )) && UP+=(--force-recreate)
  if ! "${COMPOSE[@]}" "${UP[@]}" "${SERVICES[@]}"; then
    echo >&2
    echo "${YELLOW}Контейнеры подняты, но не все прошли healthcheck за 5 минут (или не стартовали).${NC}" >&2
    echo "Смотрите: ${COMPOSE[*]} ps; docker logs --tail 100 <контейнер>" >&2
    exit 1
  fi

  local RECREATED=() id
  for c in "${SERVICES[@]}"; do
    id=$(docker container inspect -f '{{.Id}}' "$c" 2>/dev/null || true)
    [[ "$id" != "${ID_BEFORE[$c]}" ]] && RECREATED+=("$c")
  done

  # Постусловие: все контейнеры на тех ревизиях, которые посчитал build-env.sh.
  local BAD=()
  for c in "${API_FAMILY[@]}"; do
    [[ "$(container_label "$c" "$REV_LABEL")" == "$MATCHECK_API_REV" ]] || BAD+=("$c")
  done
  [[ "$(container_label matcheck-web "$REV_LABEL")" == "$MATCHECK_WEB_REV" \
     && "$(container_label matcheck-web "$CFG_LABEL")" == "$MATCHECK_WEB_CFG" ]] || BAD+=(matcheck-web)
  if (( ${#BAD[@]} )); then
    echo "${YELLOW}Контейнеры не на ожидаемой ревизии: ${BAD[*]}${NC}" >&2
    echo "Повторите ./scripts/deploy.sh; если не поможет — ./scripts/deploy.sh --force" >&2
    exit 1
  fi

  # ─── Сводка ───
  echo
  echo "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
  echo "${BOLD}║                    Сводка деплоя                         ║${NC}"
  echo "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"

  if (( ! PULL )); then
    printf "  %s ${GREEN}✓${NC} %s (без pull)\n"      "$(pad 'Git pull')"       "$COMMIT_AFTER"
  elif [[ "$COMMIT_BEFORE" == "$COMMIT_AFTER" ]]; then
    printf "  %s ${GREEN}✓${NC} %s (без изменений)\n" "$(pad 'Git pull')"       "$COMMIT_AFTER"
  else
    printf "  %s ${GREEN}✓${NC} %s → %s\n"            "$(pad 'Git pull')"       "$COMMIT_BEFORE" "$COMMIT_AFTER"
  fi

  if (( ${#BUILT[@]} )); then
    printf "  %s ${GREEN}✓${NC} %s\n"                 "$(pad 'Сборка образов')" "${BUILT[*]}"
  else
    printf "  %s ${GREEN}✓${NC} не требовалась\n"     "$(pad 'Сборка образов')"
  fi
  printf "  %s   API %s, портал %s\n" "$(pad '')" "$(short "$MATCHECK_API_REV")" "$(short "$MATCHECK_WEB_REV")"

  if (( PENDING_BEFORE == 0 )); then
    printf "  %s ${GREEN}✓${NC} нет новых (всего в БД: %d)\n" "$(pad 'Миграции')" "$APPLIED_AFTER"
  elif (( APPLIED_NOW == PENDING_BEFORE && PENDING_AFTER == 0 )); then
    printf "  %s ${GREEN}✓${NC} %d из %d применена(о)\n"      "$(pad 'Миграции')" "$APPLIED_NOW" "$PENDING_BEFORE"
    if [[ -n "$PENDING_TAGS" ]]; then
      printf "  %s   %s\n"                                    "$(pad '')"         "$PENDING_TAGS"
    fi
  else
    printf "  %s ${YELLOW}!${NC} ожидалось %d, применено %d (pending после: %d)\n" \
      "$(pad 'Миграции')" "$PENDING_BEFORE" "$APPLIED_NOW" "$PENDING_AFTER"
  fi

  if (( WAITED )); then
    printf "  %s ${GREEN}✓${NC} дождались задания (%s)\n" "$(pad 'Воркер')" "$WORKER_WHY"
  else
    printf "  %s ${GREEN}✓${NC} не останавливали\n"        "$(pad 'Воркер')"
  fi

  if (( ${#RECREATED[@]} )); then
    printf "  %s ${GREEN}✓${NC} пересозданы: %s\n" "$(pad 'Контейнеры')" "${RECREATED[*]}"
  else
    printf "  %s ${GREEN}✓${NC} пересоздавать не понадобилось\n" "$(pad 'Контейнеры')"
  fi
  printf "  %s   все up, healthcheck пройден\n" "$(pad '')"
  echo
  echo "${BOLD}${GREEN}  Деплой завершён успешно${NC}"
  echo
}

main "$@"
