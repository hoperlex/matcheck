# Развертывание MatCheck на VPS

Runbook для эксплуатации продакшен-инстанса `matcheck.fvds.ru` на VPS `mosgate.fvds.ru`.

## Содержание

- [Обзор](#обзор)
- [Архитектура](#архитектура)
- [Параметры VPS](#параметры-vps)
- [Пользователь и каталоги](#пользователь-и-каталоги)
- [Секреты](#секреты)
- [Docker-стек](#docker-стек)
- [NGINX](#nginx)
- [TLS-сертификат](#tls-сертификат)
- [Логирование](#логирование)
- [Обновление кода](#обновление-кода-универсальная-команда)
- [Откат](#откат)
- [Troubleshooting](#troubleshooting)
- [Не трогать соседей](#не-трогать-соседей)

## Легенда

В командах помечено, под кем выполнять:

- `# [root]` — текущая сессия PuTTY под root.
- `# [matcheck]` — нужно перейти под пользователя matcheck: `sudo -iu matcheck` из root-сессии.

## Обзор

MatCheck состоит из трёх контейнеров в одной docker-сети `matcheck-net`:

| Контейнер | Образ | Назначение | Доступ |
|---|---|---|---|
| `matcheck-api` | сборка из `apps/api/Dockerfile` | Fastify API на TypeScript, через `tsx` | `127.0.0.1:13001` |
| `matcheck-web` | сборка из `apps/web/Dockerfile` | nginx + статика собранной PWA | `127.0.0.1:18080` |
| `matcheck-redis` | `redis:7-alpine` | Redis для BullMQ-задач и rate-limit | внутри сети, без публикации |

Внешние зависимости:

- **PostgreSQL** — Yandex Managed PostgreSQL (`c-*.rw.mdb.yandexcloud.net:6432`, БД `matcheck`).
- **S3** — Cloud.ru Object Storage (`https://s3.cloud.ru`).
- **TLS** — Let's Encrypt через системный `certbot` (`--webroot`).

Реверс-прокси — общесерверный системный NGINX 1.26 (рядом с другими порталами); матчек добавлен отдельным vhost-файлом в `sites-enabled/`. ISPmanager также активен на сервере, но мы **в его конфиги не пишем**.

## Архитектура

```
Internet
   │
   ▼  TLS termination
[185.200.179.0:443]  системный nginx (host)
   │
   ├── matcheck.fvds.ru
   │     /api/v1/* ─► 127.0.0.1:13001 ─► matcheck-api ─► Yandex Managed PG (TLS verify-full)
   │     /sw.js    ─► 127.0.0.1:18080 (no-cache header)
   │     /*        ─► 127.0.0.1:18080 ─► matcheck-web (nginx + статика PWA)
   │
   └── другие сайты (rates, classhub, ravek, billhub, …) — без изменений

matcheck-api ─── matcheck-net ─── matcheck-redis  (BullMQ + rate-limit, без exposure)
matcheck-api ─── Internet HTTPS ─► s3.cloud.ru  (presigned URLs для фото)
```

## Параметры VPS

| Параметр | Значение |
|---|---|
| Хостнейм | `mosgate.fvds.ru` |
| IP | `185.200.179.0` |
| ОС | Ubuntu 24.04 LTS |
| Docker | 28.x, compose v2.40+ |
| Системный nginx | 1.26.3 (слушает только на `185.200.179.0:80/443`) |
| ISPmanager | активен (ihttpd на :1500); матчек **не** регистрируем в его UI |
| certbot | 2.9+ через apt |
| DNS `matcheck.fvds.ru` | A → `185.200.179.0` |

## Пользователь и каталоги

```
matcheck (UID 997, GID 996, в группе docker, без sudo)
└── /srv/matcheck/         (mode 750, owner matcheck:matcheck)
    ├── app/                клон git-репозитория (источник кода и compose)
    ├── secrets/            (mode 700) — секреты, ВНЕ репозитория
    │   ├── api.env                       (mode 600) env-файл для контейнера
    │   ├── jwt-private.pem               Ed25519 приватный JWT
    │   ├── jwt-public.pem                Ed25519 публичный JWT
    │   └── yandex-ca/root.crt            (mode 644) CA YC для TLS с PG
    ├── backups/            пользовательские бэкапы (опционально)
    └── logs/               пользовательские логи (контейнеры пишут в docker-driver json-file)
```

Создание пользователя (выполняется один раз):

```bash
# [root]
useradd --system --create-home --home-dir /srv/matcheck \
        --shell /bin/bash --user-group matcheck
usermod -aG docker matcheck
sudo -u matcheck mkdir -p /srv/matcheck/{app,secrets,backups,logs}
chmod 750 /srv/matcheck
chmod 700 /srv/matcheck/secrets
```

## Секреты

Все секреты лежат в `/srv/matcheck/secrets/`. Каталог **намеренно вне репозитория**, чтобы:
- `git pull` ничего не затирал;
- `git status` не показывал секретные файлы;
- права `700` ограничивали доступ только matcheck.

### Перечень

| Файл | Создаётся командой | Содержит |
|---|---|---|
| `jwt-private.pem` | `openssl genpkey -algorithm ED25519 -out jwt-private.pem` | приватный ключ для подписи JWT |
| `jwt-public.pem` | `openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem` | публичный ключ для верификации |
| `yandex-ca/root.crt` | `curl -fsSL https://storage.yandexcloud.net/cloud-certs/CA.pem -o yandex-ca/root.crt` | CA для verify-full TLS к Yandex PG |
| `api.env` | см. [api.env.example](../infra/api.env.example) | переменные окружения контейнера API |

### Что хранится в api.env

Шаблон с пояснениями находится в `infra/api.env.example`. Ключевые переменные:

- **JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM** — PEM-ключи в одну строку (`\n` как escape). Получить:
  ```bash
  # [matcheck]
  awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' /srv/matcheck/secrets/jwt-private.pem
  awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' /srv/matcheck/secrets/jwt-public.pem
  ```
- **APP_FIELD_ENCRYPTION_KEYS** — JSON-map AES-256-GCM ключей: `{"v1":"<base64 32 байта>"}`. При потере зашифрованные поля (Mail-пароли, EDO-credentials, LLM-ключи) **невосстановимы**.
- **CSRF_SECRET** — случайные ≥ 32 символа.
- **DATABASE_URL** — обязательно в **двойных кавычках** (там `&` в query-string):
  ```
  DATABASE_URL="postgres://USER:PASS@HOST.mdb.yandexcloud.net:6432/matcheck?sslmode=verify-full&sslrootcert=/etc/ssl/yandex/root.crt"
  ```
- **NODE_EXTRA_CA_CERTS=/etc/ssl/yandex/root.crt** — обязательно для Yandex PG: `postgres-js` не читает `sslrootcert=` из URL, а Node нужен явный CA в trust-store.
- **REDIS_URL=redis://matcheck-redis:6379/0** — обращение по имени сервиса внутри `matcheck-net`.
- **S3_ENDPOINT=https://s3.cloud.ru**, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY — из Cloud.ru Console.

### Правила обращения

- НИКОГДА не выводить значения в общий чат / лог. При проверках использовать `wc -c`, `md5sum`, проверку через `openssl pkey -noout` (без `-text`).
- `openssl rand -base64 N > file` (не `tee`).
- В чат с ассистентом копировать только маскированную часть (`M***Bx`).
- Если секрет утёк — немедленно ротировать (для PG — пароль через YC Console).

### Ротация

| Что | Как |
|---|---|
| Пароль PG | YC Console → кластер → Пользователи → admindb → Сменить пароль; обновить `DATABASE_URL` в `api.env`; restart `matcheck-api`. |
| S3-ключи | Cloud.ru Console → Хранилище → Ключи доступа → новый; обновить `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` в `api.env`; restart. |
| JWT-пара | Создать новую пару `openssl genpkey ED25519 …`. Обновить `JWT_PRIVATE_KEY_PEM`/`JWT_PUBLIC_KEY_PEM`; restart. ВСЕ существующие сессии станут невалидны — пользователи будут перелогиниваться. |
| AES-ключи шифрования полей | Сгенерировать новый ключ `v2`, добавить в `APP_FIELD_ENCRYPTION_KEYS` (`{"v1":"...","v2":"..."}`), переключить `APP_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION=v2`. Старые поля будут перешифровываться лениво при чтении. |

## Docker-стек

Описан в [`infra/docker-compose.prod.yml`](../infra/docker-compose.prod.yml). Ключевые свойства:

- Сеть `matcheck-net` — собственный bridge, не подключаемся к default-сети и чужим сетям (`billhub-app_*`, `sh_*` и т.п.).
- `matcheck-redis` без `ports:` — наружу не вылезает.
- `matcheck-api` и `matcheck-web` биндятся на **`127.0.0.1`**, никаких `0.0.0.0` / IP интерфейса.
- `mem_limit` на каждый сервис (RAM на VPS ограничен ~4 GB).
- `restart: unless-stopped`.
- `env_file` указывает абсолютным путём на `/srv/matcheck/secrets/api.env` — секреты подхватываются автоматически, отдельный `--env-file` в команде compose **не нужен**.
- Yandex CA смонтирован в `matcheck-api`: `/srv/matcheck/secrets/yandex-ca/root.crt:/etc/ssl/yandex/root.crt:ro`.

Стартовый запуск:

```bash
# [matcheck]
cd /srv/matcheck/app
docker compose -f infra/docker-compose.prod.yml build
docker compose -f infra/docker-compose.prod.yml up -d
docker ps --filter 'name=matcheck-' --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

## NGINX

Единственный системный файл, который мы создаём — `/etc/nginx/sites-available/matcheck.fvds.ru` + симлинк в `sites-enabled/`. Полное содержимое в этой репе: [`infra/nginx/matcheck.fvds.ru.conf`](../infra/nginx/matcheck.fvds.ru.conf).

Ключевые моменты конфигурации:

- `listen 185.200.179.0:80;` и `listen 185.200.179.0:443 ssl;` — на конкретный IP, как и соседи (системный nginx не слушает на `0.0.0.0`).
- `location /api/v1/ { proxy_pass http://matcheck_api; }` — **без trailing slash**, чтобы префикс `/api/v1` доходил до Fastify (он на нём слушает).
- `location = /sw.js` — отдельная директива с `Cache-Control: no-cache` для PWA service worker.
- `location /.well-known/acme-challenge/ { root /usr/local/mgr5/www/letsencrypt; }` — паритет с соседями, использует общий webroot.
- CSP-заголовок ограничивает источники до `'self'` + `https://s3.cloud.ru` (для presigned URL загрузки фото).

Активация и проверка:

```bash
# [root]
# Симлинк боевого vhost на репо-версию — git pull будет обновлять его автоматически.
ln -sf /srv/matcheck/app/infra/nginx/matcheck.fvds.ru.conf \
       /etc/nginx/sites-available/matcheck.fvds.ru
ln -sf /etc/nginx/sites-available/matcheck.fvds.ru \
       /etc/nginx/sites-enabled/matcheck.fvds.ru
nginx -t                 # ОБЯЗАТЕЛЬНО перед reload
systemctl reload nginx   # graceful, активные соединения соседей не разрываются
```

Симлинк-цепочка `sites-enabled → sites-available → /srv/matcheck/app/infra/nginx/matcheck.fvds.ru.conf` означает, что после любого `git pull` боевой vhost-файл уже актуален — остаётся только `nginx -t && systemctl reload nginx`. Master-процесс nginx работает под root, право `750` на `/srv/matcheck/` ему не мешает.

После каждого `reload nginx` обязательно прогнать health-check соседей (см. [Не трогать соседей](#не-трогать-соседей)).

## TLS-сертификат

Выпуск (один раз для нового домена):

```bash
# [root]
certbot certonly --webroot -w /usr/local/mgr5/www/letsencrypt \
  -d matcheck.fvds.ru \
  --email saztonov.a.p@proton.me --agree-tos --no-eff-email --non-interactive
```

> **НЕ** использовать `certbot --nginx` — он правит чужие vhost-файлы.

Hook для автообновления (чтобы nginx подхватывал новый сертификат):

```bash
# [root]
cat > /etc/letsencrypt/renewal-hooks/deploy/00-reload-nginx.sh <<'EOF'
#!/bin/sh
nginx -t && systemctl reload nginx
EOF
chmod +x /etc/letsencrypt/renewal-hooks/deploy/00-reload-nginx.sh
certbot renew --dry-run   # проверка
```

Сертификаты живут 90 дней, обновляются автоматически через systemd timer `certbot.timer`. Срок проверить:

```bash
# [root]
certbot certificates
```

## Логирование

| Источник | Путь / драйвер |
|---|---|
| nginx access/error matcheck | `/var/log/nginx/matcheck.access.log` / `matcheck.error.log` |
| Docker контейнеры | json-file драйвер с `max-size=10-20m`, `max-file=3-5` (см. compose) |
| systemd | `journalctl -u nginx`, `journalctl -u docker` |

Logrotate для nginx-логов matcheck — отдельный файл в `/etc/logrotate.d/matcheck-nginx`. Содержимое: `daily, rotate 14, compress, delaycompress, USR1`. Чужие правила (`/etc/logrotate.d/nginx`, `ihttpd` и т.п.) не трогаем.

Просмотр:

```bash
# [matcheck]
docker logs -f matcheck-api          # API в реальном времени
docker logs --tail 200 matcheck-api  # последние 200 строк
docker logs --since 10m matcheck-api # за последние 10 минут

# [root]
tail -f /var/log/nginx/matcheck.access.log
tail -f /var/log/nginx/matcheck.error.log
```

## Обновление кода (универсальная команда)

Один и тот же блок работает для **любого** обновления — кода API, кода Web, миграций БД, compose-файла или nginx-vhost. Drizzle-migrate идемпотентен (пропускает уже применённые миграции через `__drizzle_migrations`); `nginx -t && reload` дешёвый и graceful — если vhost в коммите не менялся, reload no-op'нет на тех же байтах. Запускать целиком, не задумываясь, что именно изменилось в последнем коммите.

```bash
# [matcheck]
cd /srv/matcheck/app
git pull
git log --oneline -1   # фиксируем коммит для журнала деплоя

# (Опционально, рекомендуется перед миграциями)
# Снэпшот PG: YC Console → Managed PostgreSQL → кластер → Резервные копии → Создать копию

# Сборка образов (deps кэшируются; пересобирается build-стадия + слой COPY apps/api)
docker compose -f infra/docker-compose.prod.yml build matcheck-api matcheck-web

# Журнал миграций ДО — фиксируем точку отсчёта (read-only, в БД ничего не меняет)
docker compose -f infra/docker-compose.prod.yml \
  run --rm matcheck-api node_modules/.bin/tsx scripts/migrations-status.ts

# Применение миграций (если новых нет — пройдёт за секунду, ничего не сделает)
docker compose -f infra/docker-compose.prod.yml \
  run --rm matcheck-api node_modules/.bin/tsx scripts/migrate.ts

# Журнал миграций ПОСЛЕ — новые строки в конце = миграции, применённые этим деплоем.
# Если вывод идентичен «ДО» — новых миграций в коммите не было.
docker compose -f infra/docker-compose.prod.yml \
  run --rm matcheck-api node_modules/.bin/tsx scripts/migrations-status.ts

# Пересоздание контейнеров — подхватывает новый образ, compose и api.env
docker compose -f infra/docker-compose.prod.yml up -d --force-recreate matcheck-api matcheck-web
```

Шаг `migrations-status.ts` — read-only: печатает таблицу `id | tag | applied_at` из `drizzle.__drizzle_migrations` с тегами из `apps/api/src/db/migrations/meta/_journal.json`. Сравните выводы «ДО» и «ПОСЛЕ» — добавленные строки в конце второй таблицы это миграции, применённые этим деплоем; совпали — новых миграций не было. В конце каждой таблицы — итог `[migrations] applied: N / journal: M / pending: K`; если `pending > 0`, рядом строка `[migrations] pending tags: …`.

```bash
# [root]
# Применить изменения nginx-vhost из репо (симлинк → /srv/matcheck/app/infra/nginx/...).
nginx -t && systemctl reload nginx

# Проверка, что соседи не задеты (baseline зафиксирован 2026-05-13)
for site in rates.fvds.ru aihub.fvds.ru classhub.fvds.ru ravek.link \
            billhub.fvds.ru passdesk.fvds.ru osa.fvds.ru testaihub.fvds.ru; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "https://$site/")
  printf '%-25s %s\n' "$site" "$code"
done | diff /root/sites-baseline-pre-matcheck.txt -
# ожидаем: пустой вывод (нет diff с baseline)
```

```bash
# [matcheck]
# Финальная проверка matcheck
sleep 15
docker ps --filter 'name=matcheck-' --format 'table {{.Names}}\t{{.Status}}'
docker logs --tail 30 matcheck-api
curl -fsS https://matcheck.fvds.ru/api/v1/auth/refresh -X POST | head -5  # ожидаем 401 (нет cookie)
curl -fsSI https://matcheck.fvds.ru/ | head -3
```

Что покрывает блок:

| Изменение в коммите | Подхватывается чем |
|---|---|
| `apps/api/**`, `apps/web/**`, `packages/contracts/**` | `build` + `up -d --force-recreate matcheck-api matcheck-web` |
| Миграции в `apps/api/src/db/migrations/**` | шаг `scripts/migrate.ts` |
| `infra/docker-compose.prod.yml` (для api/web) | `up -d --force-recreate matcheck-api matcheck-web` |
| `infra/nginx/matcheck.fvds.ru.conf` | симлинк `sites-available` → репо + `nginx -t && systemctl reload nginx` |

Что **НЕ** покрывает (требует отдельных шагов):

- `/srv/matcheck/secrets/api.env` — лежит вне репо, правится вручную (см. ниже);
- структурные изменения compose (новый сервис, том) — нужен `up -d` без перечисления сервисов;
- настройки самого `matcheck-redis` — в универсальной команде он намеренно не пересоздаётся, чтобы не терять очереди BullMQ.

Что если `git pull` упал с `dubious ownership` — значит вы под root. Перейдите в matcheck: `sudo -iu matcheck`. Git-операции делаются только под пользователем matcheck.

### При обновлении только `api.env` (без правки кода)

```bash
# [matcheck]
nano /srv/matcheck/secrets/api.env
docker compose -f /srv/matcheck/app/infra/docker-compose.prod.yml up -d --force-recreate matcheck-api
```

`--force-recreate` гарантирует, что контейнер перечитает env при старте (без него compose оставил бы старый).

### При обновлении только `infra/docker-compose.prod.yml`

```bash
# [matcheck]
cd /srv/matcheck/app
git pull
docker compose -f infra/docker-compose.prod.yml up -d   # автоматически применяет изменения compose
```

Если изменения касаются только api/web — проще запустить полную универсальную команду выше, она и так делает `--force-recreate matcheck-api matcheck-web`.

### Ручная перевыдача TLS-сертификата

Авторенью идёт через systemd timer `certbot.timer` + deploy-hook (`/etc/letsencrypt/renewal-hooks/deploy/00-reload-nginx.sh`), ручной шаг нужен только при принудительной перевыдаче:

```bash
# [root]
certbot renew --force-renewal --cert-name matcheck.fvds.ru
# deploy-hook сам сделает nginx -t && systemctl reload nginx
```

## Откат

### Откат кода

```bash
# [matcheck]
cd /srv/matcheck/app
git log --oneline -10                                       # найти предыдущий рабочий коммит
git checkout <prev-sha>                                     # или: git reset --hard <prev-sha>
docker compose -f infra/docker-compose.prod.yml build matcheck-api
docker compose -f infra/docker-compose.prod.yml up -d --force-recreate matcheck-api
```

### Откат БД (после плохой миграции)

YC Console → Managed PostgreSQL → кластер → Резервные копии → выбрать снэпшот ДО миграции → **Восстановить в существующий кластер**. Подтвердить, дождаться. Затем выполнить откат кода до коммита, который соответствует этой схеме БД.

### Откат nginx-конфига matcheck

```bash
# [root]
rm /etc/nginx/sites-enabled/matcheck.fvds.ru     # отключить наш блок
nginx -t && systemctl reload nginx
# matcheck больше не отвечает по 443, но соседи живут как раньше
```

### Полный аварийный откат nginx

Если оригинальный конфиг повредился:

```bash
# [root]
tar xzf /root/nginx-state-pre-matcheck-<STAMP>.tar.gz -C /
nginx -t && systemctl reload nginx
```

Бэкап создавался перед первым деплоем.

## Troubleshooting

### `Cannot find module '/app/dist/index.js'` или `Cannot find package 'fastify'` в docker logs

Старая болезнь runtime-образа без tsx. Текущий Dockerfile запускает api **через `tsx`** напрямую из TypeScript-источников (`apps/api/src/index.ts`), и `dist/` не используется. Если образ старый — `docker compose build --no-cache matcheck-api`.

### `self-signed certificate in certificate chain` при подключении к PG

Не выставлен `NODE_EXTRA_CA_CERTS` в `api.env`. Должно быть:
```
NODE_EXTRA_CA_CERTS=/etc/ssl/yandex/root.crt
```
Соответствующий путь смонтирован в контейнер как `/etc/ssl/yandex/root.crt:ro` через `docker-compose.prod.yml`.

### `Route POST:/auth/login not found` (404)

В системном nginx у `location /api/v1/` есть trailing slash в `proxy_pass`: `proxy_pass http://matcheck_api/;` — он отрезает префикс `/api/v1`, а Fastify слушает на полных путях `/api/v1/...`. Должно быть **без** trailing slash:
```nginx
location /api/v1/ {
    proxy_pass http://matcheck_api;
    ...
}
```

### 401 на `/auth/login` или `/auth/register` (публичные!)

В `apps/api/src/plugins/auth.ts` whitelist `PUBLIC_PATHS` должен содержать **полные** пути с префиксом `/api/v1/`, иначе глобальный `onRequest` hook режет публичные endpoint-ы:
```ts
const PUBLIC_PATHS = new Set([
  '/health',
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/refresh',
]);
```

### 401 на `/auth/login` после правильного пароля

Свежий пользователь регистрируется с `isActive=false`. Активировать админом:
```bash
# [matcheck]
docker exec matcheck-api node -e "
  const postgres = require('postgres');
  const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  sql\`UPDATE users SET is_active=true WHERE email=\$1 RETURNING email, role, is_active\`.bind('user@example.com')
    .then(r => { console.log(r); return sql.end(); });
"
```

### Поток 401 на `/api/v1/events` в консоли

EventSource не умеет посылать `Authorization: Bearer`. С коммита `9fa0ee2` бэк выдаёт дополнительный cookie `__Host-access` (через `Set-Cookie` при login/refresh), а `attachUser` имеет fallback на этот cookie. Если поток сохраняется — пользователь логинился ДО появления фикса; нужно очистить cookies (DevTools → Application → Clear site data) и перелогиниться.

### Healthcheck `unhealthy` сразу после старта

Зайти в контейнер и проверить, что api слушает:
```bash
docker exec matcheck-api wget -qO- http://127.0.0.1:3001/health
```
Если ничего не возвращается — смотреть `docker logs --tail 100 matcheck-api`, скорее всего проблема в `api.env` (см. предыдущие пункты).

### Соседний сайт стал отвечать 502/504 после reload nginx

Никогда не должно случиться (мы трогаем только свой vhost), но в качестве страховки:
```bash
# [root]
diff /root/nginx-checksums-pre-matcheck.txt \
     <(find /etc/nginx/sites-enabled /etc/nginx/vhosts /etc/nginx/vhosts-includes \
       /etc/nginx/modules-includes /etc/nginx/ssl_cert_servers /etc/nginx/conf.d \
       -type f ! -name 'matcheck.fvds.ru' -exec md5sum {} \; | sort)
# если ненулевой diff — какой-то чужой файл задело; откатить из tar-бэкапа
```

## Не трогать соседей

Главный приоритет деплоя — не сломать другие сайты на этом VPS (`rates.fvds.ru`, `aihub.fvds.ru`, `classhub.fvds.ru`, `ravek.link`, `billhub.fvds.ru` и др.).

**Read-only для нас:**

- `/etc/nginx/nginx.conf`
- `/etc/nginx/sites-enabled/{bcard,rates.fvds.ru}` — чужие vhost
- `/etc/nginx/vhosts/**`, `vhosts-includes/**`, `modules-includes/**` — ISP-managed
- `/etc/nginx/ssl_cert_servers/**` — ISP-managed
- `/etc/nginx/conf.d/isplimitreq.conf`, `conf.d/ssl_servers_inc.conf` — ISP-managed
- `/etc/apache2/**`
- `/usr/local/mgr5/**` (читаем только `/usr/local/mgr5/www/letsencrypt/` как webroot)
- `/etc/letsencrypt/live/<чужой-домен>/**`, `renewal/<чужой-домен>.conf`

**Запретные действия:**

- `certbot --nginx` / `--apache` — только `--webroot`.
- Регистрация `matcheck.fvds.ru` в UI ISPmanager (ISP начнёт генерить свой vhost и конфликтовать).
- Публикация портов matcheck на `0.0.0.0` или `185.200.179.0` (только `127.0.0.1`).
- `docker {network,volume,system} prune` без жёстких `--filter`.
- Активация UFW / правка iptables.
- `systemctl restart nginx` — только `reload`.

**Контроль:**

После любой правки системного nginx обязательно:

```bash
# [root]
# 1. Тест синтаксиса
nginx -t

# 2. Reload (НЕ restart)
systemctl reload nginx

# 3. Соседи — те же коды, что до изменений
for site in rates.fvds.ru aihub.fvds.ru classhub.fvds.ru ravek.link \
            billhub.fvds.ru passdesk.fvds.ru osa.fvds.ru testaihub.fvds.ru; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "https://$site/")
  printf '%-25s %s\n' "$site" "$code"
done | diff /root/sites-baseline-pre-matcheck.txt -
# ожидаем: пустой вывод
```

Baseline соседей (зафиксирован 2026-05-13 11:39) хранится в `/root/sites-baseline-pre-matcheck.txt`. Часть сайтов отвечают `500/502/000` ещё до нашего деплоя — это разрешённое состояние, наша задача не ухудшить.
