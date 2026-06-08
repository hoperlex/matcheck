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

## Проверка целостности

Сверять отпечаток, а не печатать содержимое:

```
sha256sum infra/secrets/yandex-ca/root.crt
```
