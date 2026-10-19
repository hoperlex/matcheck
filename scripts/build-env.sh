# shellcheck shell=bash
# scripts/build-env.sh — окружение для сборки образов matcheck.
#
# Подключать через `.` из корня репозитория — его использует deploy.sh, и с него же
# начинается любая ручная сборка:
#   cd /srv/matcheck/app
#   . scripts/build-env.sh && docker compose -f infra/docker-compose.prod.yml build matcheck-api
#
# Делает:
#   - останавливается на грязном рабочем дереве;
#   - считает ревизии сторон MATCHECK_API_REV и MATCHECK_WEB_REV;
#   - подгружает настройки Sentry портала и считает их отпечаток MATCHECK_WEB_CFG;
#   - экспортирует всё это для compose (build-args в infra/docker-compose.prod.yml).
#
# Ничего не собирает и секретов не печатает. Ошибки — через return, а не exit:
# при ручном подключении exit закрыл бы оболочку оператора.

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'build-env.sh подключают через точку: . scripts/build-env.sh' >&2
  exit 1
fi

_matcheck_build_env() {
  if [[ ! -f infra/docker-compose.prod.yml || ! -f scripts/build-env.sh ]]; then
    echo 'build-env: подключайте из корня репозитория (cd /srv/matcheck/app)' >&2
    return 1
  fi

  # Образ с незакоммиченными правками, помеченный SHA чистого коммита, хуже
  # отсутствия отпечатка: отчёт сверки промптов уверенно назовёт не тот код, и
  # расхождение будут искать в промпте. Раньше эту проверку делал Dockerfile API,
  # но для неё в контексте сборки нужен .git, а он ломал кэш на каждом коммите.
  # Игнорируемые файлы `git status` не видит — их не пускает в контекст .dockerignore.
  local dirty
  dirty=$(git status --porcelain) || return 1
  if [[ -n "$dirty" ]]; then
    echo 'СБОРКА ОСТАНОВЛЕНА: рабочее дерево грязное, отпечаток был бы неверным:' >&2
    printf '%s\n' "$dirty" >&2
    return 1
  fi

  # Ревизия стороны — последний коммит, менявший что-либо, КРОМЕ другого приложения.
  #
  # Именно исключение, а не список входов: так правило может ошибиться только в
  # безопасную сторону. Любая правка вне apps/* (contracts, lockfile, compose, docs)
  # меняет обе ревизии, и обе стороны соберутся, как раньше. Сторона пропускается,
  # только если с её деплоя менялось исключительно другое приложение. Забытый вход
  # в белом списке, наоборот, тихо оставил бы прод на старом коде.
  #
  # В коммите MATCHECK_API_REV содержимое всего вне apps/web совпадает с HEAD,
  # поэтому как отпечаток кода API (/app/BUILD_SHA) он честный. То же правило —
  # в apps/api/scripts/upd-prompt-ab.ts (gitRevision), чтобы один и тот же код
  # давал один отпечаток и в образе, и в рабочей копии.
  #
  # ':/' и ':(top,…)' — пути от корня репозитория, независимо от текущего каталога.
  local api_rev web_rev rev
  api_rev=$(git log -1 --format=%H -- ':/' ':(top,exclude)apps/web') || return 1
  web_rev=$(git log -1 --format=%H -- ':/' ':(top,exclude)apps/api') || return 1
  for rev in "$api_rev" "$web_rev"; do
    if ! printf '%s' "$rev" | grep -qxE '[0-9a-f]{40}'; then
      echo "build-env: не удалось посчитать ревизию стороны (получено: «${rev}»)" >&2
      return 1
    fi
  done

  # Sentry портала (опционально): публичный DSN, org/project и release уходят
  # build-arg'ами в бандл, auth-token — BuildKit-секретом для загрузки source maps.
  # Без файла плагин отключён и сборка не меняется. Файл вне репозитория (режим 600).
  local sentry_env=/srv/matcheck/secrets/sentry.web.env
  if [[ -f "$sentry_env" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$sentry_env"
    set +a
  fi
  export VITE_SENTRY_DSN="${VITE_SENTRY_DSN:-}"
  # Релиз — короткая ревизия портала, а не HEAD: иначе каждый коммит в API
  # менял бы аргумент сборки портала и запускал vite заново. Явно заданный в
  # sentry.web.env релиз сохраняем как есть.
  local release_override="${VITE_SENTRY_RELEASE:-}"
  export VITE_SENTRY_RELEASE="${release_override:-$(git rev-parse --short "$web_rev")}"
  export SENTRY_ORG="${SENTRY_ORG:-}"
  export SENTRY_PROJECT="${SENTRY_PROJECT:-}"
  export SENTRY_AUTH_TOKEN="${SENTRY_AUTH_TOKEN:-}"

  # Отпечаток сборочных настроек портала: меняется, если правят или удаляют
  # sentry.web.env. Токен входит только флагом «есть / нет» — сам секрет ни в
  # аргументы, ни в метки образа не попадает. Релиз по умолчанию сюда не входит:
  # он производный от ревизии портала, а её сторожит своя метка.
  local token_set=0
  [[ -n "$SENTRY_AUTH_TOKEN" ]] && token_set=1
  MATCHECK_WEB_CFG=$(printf '%s\n' "$VITE_SENTRY_DSN" "$SENTRY_ORG" "$SENTRY_PROJECT" \
                       "$release_override" "$token_set" | sha256sum | cut -c1-12)

  export MATCHECK_API_REV="$api_rev"
  export MATCHECK_WEB_REV="$web_rev"
  export MATCHECK_WEB_CFG
}

if _matcheck_build_env; then
  unset -f _matcheck_build_env
else
  unset -f _matcheck_build_env
  return 1
fi
