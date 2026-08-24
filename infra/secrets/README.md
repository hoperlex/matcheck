# Локальные секреты / сертификаты (НЕ коммитятся)

Папка зеркалит прод-путь `/srv/matcheck/secrets` (см. `infra/docker-compose.prod.yml`).
Сами файлы (`root.crt`, `*.pem`, `api.env`) в git **не попадают** — игнорируются в
`.gitignore`. В репозитории живут только `.gitkeep` и этот README, чтобы
структура папок сохранялась.

## Yandex Cloud CA (TLS до managed PostgreSQL)

Положить корневой сертификат сюда:

```
infra/secrets/yandex-ca/root.crt
```

Скачивается с https://storage.yandexcloud.net/cloud-certs/CA.pem
(на проде тот же файл лежит в `/srv/matcheck/secrets/yandex-ca/root.crt`).

Затем прописать путь в `apps/api/.env` (этот файл тоже под `.gitignore`):

```
# абсолютный путь к root.crt на твоей машине
NODE_EXTRA_CA_CERTS=<абсолютный путь>/infra/secrets/yandex-ca/root.crt
DATABASE_URL="postgres://<USER>:<PASSWORD>@<HOST>.mdb.yandexcloud.net:6432/<DB>?sslmode=verify-full&sslrootcert=<абсолютный путь>/infra/secrets/yandex-ca/root.crt"
```

> На Windows путь вида `C:\Users\<имя>\projects\matcheck\infra\secrets\yandex-ca\root.crt`.
> postgres-js не парсит `sslrootcert` из URL сам, поэтому CA дублируется в
> `NODE_EXTRA_CA_CERTS` — иначе handshake падает с
> «self-signed certificate in certificate chain».

## MCP `matcheck-db` — строка подключения (`mcp-db.env`)

Read-only доступ к боевой БД для MCP-сервера `tools/mcp-pg/server.mjs`. Строка
подключения лежит **только** здесь, одним ключом:

```
infra/secrets/mcp-db.env      # режим 600, создавать под `umask 077`
```

```
MATCHECK_DB_RO_URL=postgres://mcp_readonly:<PASSWORD>@<HOST>.mdb.yandexcloud.net:6432/matcheck?sslmode=verify-full
```

Раньше значение экспортировалось из `~/.bashrc` — оттуда оно попадало в окружение
**каждого** дочернего процесса любого шелла (gradle, npm, postinstall-скрипты) и было
видно в `env` / `/proc/<pid>/environ`. Теперь его читает напрямую движок Node через
`--env-file`, и живёт оно только внутри процесса MCP-сервера.

### Две готчи, из-за которых команда запуска выглядит именно так

1. **`--env-file` НЕ приоритетнее существующего окружения.** Если переменная уже есть у
   родительского процесса, она победит значение из файла. Поэтому перед бинарём Node
   обязателен `/usr/bin/env -u MATCHECK_DB_RO_URL` — иначе процесс молча уедет на
   унаследованный (возможно, устаревший) URL.
2. **`NODE_EXTRA_CA_CERTS` через `--env-file` не применяется.** Node читает эту
   переменную при инициализации TLS, до того как значения из файла попадают в
   `process.env`: `tls.getCACertificates('extra').length` даёт `2` при передаче через
   стартовое окружение и `0` через `--env-file` (при том что сама переменная в
   `process.env` видна). Поэтому CA — только в стартовом окружении, а в `mcp-db.env`
   кладётся **исключительно** `MATCHECK_DB_RO_URL`.

Отсюда форма записи в `.mcp.json` (одинаковая в этом репо и в `matcheck.mobile`):

```json
"command": "/usr/bin/env",
"args": [
  "-u", "MATCHECK_DB_RO_URL",
  "/usr/local/bin/node",
  "--env-file=/root/projects/matcheck/infra/secrets/mcp-db.env",
  "/root/projects/matcheck/tools/mcp-pg/server.mjs"
],
"env": { "NODE_EXTRA_CA_CERTS": ".../infra/secrets/yandex-ca/root.crt" }
```

Абсолютный путь к Node исключает PATH-резолв (`/usr/bin/node` = v18 без `--env-file`
при `engines.node >= 22`), но **не** закрепляет версию: `/usr/local/bin/node` — симлинк
на nvm-сборку, его могут перенаправить. Строгий pin при необходимости —
`/root/.nvm/versions/node/v22.22.3/bin/node`.

Проверка без вывода значения:

```
/usr/bin/env -u MATCHECK_DB_RO_URL /usr/local/bin/node \
  --env-file=infra/secrets/mcp-db.env -e 'console.log(process.env.MATCHECK_DB_RO_URL?.length)'
```

## Проверка целостности

Сверять отпечаток, а не печатать содержимое:

```
sha256sum infra/secrets/yandex-ca/root.crt
```
