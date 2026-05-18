# matcheck Mobile API — руководство интегратора

Документация для разработчиков внешних клиентов matcheck — нативных мобильных приложений (Android Kotlin, iOS Swift) и интеграций.

Артефакт-источник правды: [`packages/contracts/openapi.json`](../packages/contracts/openapi.json). Эта спецификация автоматически генерируется из Zod-схем в [`packages/contracts/src/`](../packages/contracts/src/) и проверяется в CI на отсутствие расхождений (workflow [`contracts-drift`](../.github/workflows/contracts-drift.yml)).

## Базовый URL и версионирование

| Среда | Base URL |
|---|---|
| Production | `https://matcheck.fvds.ru` |
| Local dev | `http://localhost:3001` |

Все пути префиксированы `/api/v1/`. Стратегия:

- **Non-breaking changes** (добавление полей в response, новые опциональные поля в request, новые эндпоинты) — не требуют bump версии.
- **Breaking changes** (удаление поля, изменение типа поля, изменение семантики) — требуют перехода на `/api/v2/`. Это согласовывается заранее.

Клиент должен слать заголовок `User-Agent: matcheck-android/<version> (Build <code>; Android <api>)` для логов и аналитики, и `X-Client-Type: mobile` для активации mobile auth flow.

## Аутентификация

### Алгоритм

JWT (Ed25519, EdDSA). Payload: `{ sub: userId, role, sid: sessionId, aal: 'aal1' }`. Issuer: `matcheck-api`, audience: `matcheck-web`. Клиенту **не нужно** валидировать подпись JWT — это делает сервер при каждом запросе. Достаточно хранить токены как непрозрачные строки.

### Сроки жизни

- **Access-token**: 900 сек (15 мин).
- **Refresh-token**: 14 дней с момента выдачи.
- **Максимальная длительность сессии**: 90 дней (после этого refresh не продлевается, требуется новый login).

### Mobile vs web — ключевое отличие

Веб-клиент использует HttpOnly-cookies для refresh-token. Мобильному клиенту cookies **не подходят** (нет жизненного цикла страницы, не работают cross-origin при сценарии prefetching). Поэтому для активации mobile-flow клиент **обязан** слать заголовок:

```
X-Client-Type: mobile
```

При наличии этого заголовка `/auth/login` и `/auth/refresh` возвращают `refreshToken` и `refreshExpiresIn` **в теле ответа**, а cookies не устанавливают.

### POST `/api/v1/auth/login`

**Запрос:**

```http
POST /api/v1/auth/login
Host: matcheck.fvds.ru
Content-Type: application/json
X-Client-Type: mobile
User-Agent: matcheck-android/1.0 (Build 1; Android 14)

{"email": "inspector@example.ru", "password": "..."}
```

**Ответ 200:**

```json
{
  "accessToken": "eyJhbGciOiJFZERTQSIs...",
  "expiresIn": 900,
  "user": {
    "id": "uuid",
    "email": "inspector@example.ru",
    "role": "inspector_kpp",
    "isActive": true,
    "siteId": "uuid-объекта-строительства",
    "createdAt": "2026-01-01T00:00:00.000Z"
  },
  "refreshToken": "base64url-32-bytes-of-randomness",
  "refreshExpiresIn": 1209600
}
```

Поле `user.siteId` для роли `inspector_kpp` всегда заполнено — это объект,
к которому привязан пользователь. Мобильный клиент сохраняет его при логине;
селект объекта в UI инспектора отключён (сервер всё равно перезаписывает).
Для admin/manager `siteId` равен `null`.

**Ошибки:**

- `400 weak_password` — слабый пароль (только для `/auth/register`)
- `401 invalid_credentials` — неверный email/пароль
- `401 account_inactive` — аккаунт деактивирован
- `423 account_locked` — аккаунт временно заблокирован (после 10 неудачных попыток на 30 мин)
- `429` — превышен rate-limit на /login (5 запросов / 15 мин на email)

### POST `/api/v1/auth/refresh`

Принимает refresh-token в заголовке `Authorization: Bearer` (для mobile) либо из cookie `__Host-refresh` (для web). Ротация: старый refresh-token инвалидируется при первом успешном использовании. **Reuse уже использованного refresh** → 401 + полная инвалидация всей сессии (защита от кражи).

**Запрос:**

```http
POST /api/v1/auth/refresh
Host: matcheck.fvds.ru
X-Client-Type: mobile
Authorization: Bearer <refreshToken>
```

**Ответ 200:**

```json
{
  "accessToken": "eyJhbGciOiJFZERTQSIs...",
  "expiresIn": 900,
  "refreshToken": "новый-refresh-token",
  "refreshExpiresIn": 1209600
}
```

**Клиент обязан** заменить хранимые токены на новые из тела ответа **прежде**, чем делать любые другие запросы — иначе старый refresh при следующем использовании выкинет всю сессию.

### Обработка 401 на бизнес-эндпоинтах

Любой запрос с истёкшим access-token получает 401. Стандартная реализация interceptor (OkHttp / Ktor):

1. Поймать 401 на ответе.
2. Вызвать `/auth/refresh` с текущим refresh-token.
3. Если refresh успешен — сохранить новые токены, повторить исходный запрос с новым access.
4. Если refresh упал с 401 (`invalid_refresh` / `no_refresh`) — выкинуть пользователя на login.

Параллельные запросы не должны вызывать гонки на refresh — используйте mutex/lock на `/auth/refresh`. Все запросы, словившие 401, должны ждать единственного выполнения refresh, а потом повторяться с новым access.

### POST `/api/v1/auth/logout`

Завершает сессию на сервере. Mobile-клиент шлёт `Authorization: Bearer <accessToken>` — сервер инвалидирует сессию по `sid` из JWT. Refresh-token cookie тоже инвалидируется (если был).

### GET `/api/v1/auth/me`

Профиль текущего пользователя — полезен после login для подтверждения, что токен валиден и для отображения email/role.

### Хранение токенов на Android

Рекомендуется:

- **Refresh-token**: EncryptedSharedPreferences (Jetpack Security) или DataStore + Tink AEAD. Не класть в SharedPreferences без шифрования и не логировать.
- **Access-token**: можно в памяти (Singleton/Hilt) — он короткоживущий. При необходимости пережить рестарт процесса — тоже в EncryptedSharedPreferences.

Никогда не логировать токены в Crashlytics/Sentry — обработчики падений могут заэкспортить ваш скоп. Если используете Timber — фильтруйте поля `accessToken`, `refreshToken` в TimberDebugTree.

## Видимость данных и роли

| Роль | Доступ |
|---|---|
| `inspector_kpp` | Видит deliveries и shipments своего объекта (`siteId`), включая записи других инспекторов на том же объекте. Создаёт от своего имени. GET по `counterparties` и `materials`. Mobile-клиент рассчитан на эту роль. |
| `manager` | Видит все `deliveries`/`shipments`, может создавать справочники. |
| `admin` | Полный доступ. Окончательное удаление помеченных документов (см. ниже) — только admin. |

Сервер фильтрует данные на стороне БД — клиенту не нужно делать фильтрацию. При запросе `/deliveries` инспектор получит только данные своего объекта (по `siteId`), даже без явных query-параметров.

## OCC (optimistic concurrency control) для приёмок

`POST /api/v1/deliveries` принимает `baseVersion: number` — версия, на которой клиент основывал свои локальные изменения.

**Поведение:**

- Сервер сравнивает `baseVersion` c текущей `delivery.version` в БД.
- Если совпадают — применяется upsert, версия инкрементируется, возвращается 200 + обновлённая `Delivery`.
- Если не совпадают — **409 Conflict** + body:
  ```json
  {
    "error": "conflict",
    "serverVersion": 7,
    "server": { /* полное состояние Delivery на сервере */ }
  }
  ```

**Клиент должен:**

1. Показать UI разрешения конфликта оператору (три стратегии: server_win / local_win / merge).
2. Применить выбранную стратегию локально.
3. Повторить POST с `baseVersion = serverVersion` из ответа 409.

Идемпотентности через `Idempotency-Key` header **нет** для приёмок. Используйте OCC.

Образец TS-реализации: [`apps/web/src/services/conflictResolver.ts`](../apps/web/src/services/conflictResolver.ts). Логику синхронизации (push-queue, retry, OCC) можно один к одному перенести на Kotlin/Coroutines + Room.

## Shipments (отгрузки)

`POST/GET/DELETE /api/v1/shipments` — зеркало `/deliveries`, та же модель OCC,
тот же photo-pipeline. Отличия:

- Поле `kind: 'contractor' | 'return' | 'transfer' | 'writeoff'` — обязательно
  при upsert.
- `receiverCounterpartyId` — обязателен для `contractor` и `return`.
- `destSiteId` (другой объект-получатель) — обязателен для `transfer`,
  должен отличаться от `siteId`.
- `writeoff` — без `receiverCounterpartyId` и `destSiteId`.
- Статусы: `not_filled` → `draft` → `shipped` → `confirmed_mol`.

OCC ответ — `ShipmentConflictResponse` (структура идентична `ConflictResponse`
для deliveries, только snapshot — `Shipment`).

## Soft-delete (двухэтапное удаление)

Бизнес-правило: оформленные/подтверждённые МОЛ приёмки и отгрузки нельзя
удалить напрямую — сначала ставится пометка («корзина»), окончательно удаляет
только админ с портала. На планшете инспектора кнопка «удалить окончательно»
не показывается.

### Эндпоинты

| Сценарий | Эндпоинт | Кто |
|---|---|---|
| Удалить черновик | `DELETE /api/v1/deliveries\|shipments/{id}` | inspector_kpp своего `siteId`, manager, admin |
| Пометить оформленную/подтверждённую | `POST /api/v1/deliveries\|shipments/{id}/mark-deletion` body `{reason?: string}` | inspector_kpp своего `siteId`, manager, admin |
| Снять пометку | `POST /api/v1/deliveries\|shipments/{id}/unmark-deletion` | автор пометки или admin |
| Окончательно удалить помеченный | `DELETE /api/v1/deliveries\|shipments/{id}` | **только admin** |
| Открыть корзину | `GET /api/v1/deliveries\|shipments?trash=1` | inspector_kpp (своего объекта), manager, admin |

### Поля в DTO

После пометки `Delivery`/`Shipment` содержат:

```json
{
  "pendingDeletionAt": "2026-05-18T10:00:00.000Z",
  "pendingDeletionByUserId": "uuid",
  "pendingDeletionByUserEmail": "user@example.ru",
  "pendingDeletionReason": "ошибка ввода"
}
```

В ответе `/sync` поле `pendingDeletionByUserEmail` всегда `null` — это
намеренное упрощение (без дополнительного join). Реальный email подтягивается
при открытии деталей через `GET /deliveries|shipments/{id}`.

### Семантика 409 и 400

| Код | Значение | Что делать клиенту |
|---|---|---|
| 409 `must_mark_first` | DELETE filled/confirmed_mol без пометки | Вызвать `mark-deletion`, потом повторить DELETE (только admin) |
| 409 `already_pending` | mark по уже помеченному | Обновить локальную копию из server-snapshot |
| 409 `not_pending` | unmark по не помеченному | Обновить локальную копию |
| 409 `pending_deletion` | upsert / photo presign / photo delete по помеченному | UI в read-only, разрешить только unmark |
| 400 `cannot_mark_status` | mark по draft/not_filled | Использовать обычный DELETE |

### Read-only режим клиента

При `pendingDeletionAt != null` мобильное приложение должно:
- блокировать редактирование полей;
- скрыть кнопку камеры (сервер вернёт 409 на `POST /photos/presign`);
- показать бейдж «На удалении» с автором, датой и причиной.

Окончательное удаление (`DELETE` после mark) кнопка показывается **только**
если `role === 'admin'`. Для inspector_kpp — нет.

## Photo pipeline

Двухэтапный процесс с дедупликацией по `contentHash`.

### Алгоритм

1. **Клиент сжимает фото** нативно. Формат — любой: JPEG, PNG, HEIC/HEIF, WebP
   (что прислано — то и сохраняется в S3). Рекомендация — сжатие до ~1.5 МБ
   ради экономии трафика на полевом 4G:
   - Main: max side 2048 px, цель ~1.5 МБ.
   - Thumb (опционально): max side 320 px, цель ~0.1 МБ.

   В `POST /photos/presign` обязательно слать реальный `contentType` —
   `"image/jpeg"`, `"image/heic"`, `"image/webp"` и т.д. Сервер использует
   его для расширения файла в S3.

2. **Клиент считает SHA-256** от main-байтов:
   ```kotlin
   val md = MessageDigest.getInstance("SHA-256")
   val contentHash = md.digest(mainBytes).joinToString("") { "%02x".format(it) }
   ```
   Опционально — то же для thumb (`thumbContentHash`).

3. **Клиент генерирует** `idempotencyKey: UUID` (один на фото на всю жизнь — сохраните в Room вместе с blob).

4. **POST `/api/v1/photos/presign`**:
   ```json
   {
     "deliveryId": "uuid-приёмки",
     "kind": "cargo",
     "contentHash": "sha256-hex-64-chars",
     "idempotencyKey": "uuid-сгенерированный-клиентом",
     "contentType": "image/jpeg",
     "thumbContentHash": "sha256-hex-thumb-опционально"
   }
   ```

5. **Сервер отвечает 200** с одним из двух вариантов:
   - `alreadyExists: true` — фото с таким `contentHash` уже было загружено, возвращает существующий `photoId` и `s3Key`. **Клиент не загружает в S3.**
   - `alreadyExists: false` — выдаются `uploadUrl` (PUT presigned URL, TTL 300 сек) и `thumbUploadUrl` (если был `thumbContentHash`). Клиент загружает в S3.

6. **PUT в S3:**
   ```http
   PUT <uploadUrl>
   Content-Type: image/jpeg
   
   <binary body>
   ```
   Прямой PUT, без OkHttp-interceptor на Authorization (presigned URL уже подписан AWS-методом). Параллельно — `thumbUploadUrl` если он выдан.

7. На успешный PUT (HTTP 200) **рекомендуется** вызвать `POST /api/v1/photos/{id}/confirm` —
   сервер делает S3.HEAD и проставляет `uploaded_at = now()`. Это защищает
   запись от автоматической очистки orphan-задачей (раз в час сервер
   проверяет неподтверждённые фото старше 1 часа и удаляет, если объекта
   в S3 нет). Без confirm фото всё равно «дозреет» через час (cleanup
   увидит S3-объект и проставит uploaded_at), но клиент не должен пытаться
   открыть фото с `uploadedAt: null` — `GET /url` может вернуть 404, если
   запись orphan'нулась.

### TTL и retry

- Presigned URL живёт **300 сек** (5 мин). Если упустили окно — повторите `/photos/presign` с тем же `idempotencyKey`: сервер выдаст новый presigned URL для того же `s3Key`.
- При офлайне фото остаются в локальной БД (Room) с флагом `uploaded=false`. WorkManager Worker пытается загрузить их когда появляется сеть.

### Просмотр фото

`GET /api/v1/photos/{id}/url?thumb=false` возвращает `{ url, expiresIn }` — presigned GET-URL (TTL 300 сек). Клиент использует его в `Image`/`Glide`/`Coil` для отображения. Кешируется на стороне клиента, повторно запрашивается только когда URL истёк.

## Дельта-синхронизация

`GET /api/v1/sync?since={ISO-8601-timestamp}&windowDays={1..365}` возвращает
все объекты с `updatedAt >= since`:

```json
{
  "cursor": "2026-05-14T10:30:00.000Z",
  "serverNow": "2026-05-14T10:30:01.000Z",
  "counterparties": [...],
  "materials": [...],
  "sites": [...],
  "statuses": [...],
  "sourceDocuments": [...],
  "deliveries": [...],
  "shipments": [...],
  "deletedIds": {
    "deliveries": ["uuid", ...],
    "shipments": ["uuid", ...],
    "sourceDocuments": ["uuid", ...]
  }
}
```

### Параметры

- **`since`** (опц.) — ISO-8601. Если не задан — initial-sync, окно
  ограничивается `windowDays`.
- **`windowDays`** (опц., default 90, 1..365) — окно для initial-sync:
  `deliveries`/`shipments`/`sourceDocuments` отдаются за последние N дней.
  При дельта-sync (`since != null`) — игнорируется (старые записи могли
  поменяться, дельта-sync их захватывает).

### Что отдаёт inspector_kpp

- `counterparties`, `materials`, `sites`, `statuses` — полностью (без siteId-фильтра).
- `deliveries`, `shipments` — по своему `siteId` (включая записи других
  инспекторов на том же объекте).
- `sourceDocuments` — по своему `siteId`, **только не привязанные** к
  приёмке/отгрузке (это сценарий «Inbox: ожидаемые УПД»).
- `deletedIds` — id записей, физически удалённых после `since`, по своему
  `siteId`. Пустые массивы при initial-sync.

### Limits на запрос

| Тип | Лимит |
|---|---|
| `counterparties` | 500 |
| `materials` | 500 |
| `sites` | 500 |
| `sourceDocuments` | 200 |
| `deliveries` | 500 |
| `shipments` | 500 |

Если в каком-то массиве пришло ровно лимит — возможно, есть ещё данные. Стратегия pagination через cursor:

```
1. since = stored_cursor (или 1970-01-01T00:00:00Z при первом запуске)
2. GET /sync?since=since → response
3. сохранить все объекты в Room
4. если хоть один массив имеет length == limit → since = response.cursor, GOTO 2
5. иначе stored_cursor = response.cursor
```

Cursor — это серверное время, не client clock. Не пытайтесь генерировать его сами.

### Когда вызывать sync

- При старте приложения.
- Каждые 60 сек на фоне (WorkManager `PeriodicWorkRequest`).
- После любой успешной локальной мутации (push-then-pull).
- При получении SSE-события (см. ниже).
- При возврате сети после офлайна (NetworkCallback).

## SSE для real-time уведомлений

`GET /api/v1/events` — Server-Sent Events.

**Auth:** `Authorization: Bearer <accessToken>` в заголовке (стандартный браузерный `EventSource` не отправляет custom headers, поэтому на Android используйте `okhttp-sse`).

**Реализация на Kotlin (OkHttp):**

```kotlin
val client = OkHttpClient()
val request = Request.Builder()
    .url("https://matcheck.fvds.ru/api/v1/events")
    .header("Authorization", "Bearer $accessToken")
    .header("X-Client-Type", "mobile")
    .build()
val factory = EventSources.createFactory(client)
val listener = object : EventSourceListener() {
    override fun onEvent(es: EventSource, id: String?, type: String?, data: String) {
        when (type) {
            "delivery_updated", "delivery_deleted",
            "source_document_updated", "counterparty_updated",
            "material_updated" -> triggerSync()
            "ping" -> markConnectionAlive()
        }
    }
    override fun onFailure(es: EventSource, t: Throwable?, response: Response?) {
        // 401 → попробовать /auth/refresh и переподключиться
        // network error → reconnect через 2..10 сек с jitter
    }
}
factory.newEventSource(request, listener)
```

**Формат события:**

```
event: delivery_updated
data: {"type":"delivery_updated","entityId":"<uuid>","ts":"2026-05-14T10:00:00.000Z"}
```

Поле `entityId` обязательно для всех `*_updated` и `*_deleted` событий (для
`ping` — отсутствует). При `*_deleted` клиент может **сразу удалить** локальную
запись по `entityId`, без вызова `/sync`.

**Event types:** `delivery_updated`, `delivery_deleted`, `shipment_updated`,
`shipment_deleted`, `source_document_updated`, `source_document_deleted`,
`counterparty_updated`, `material_updated`, `site_updated`, `ping`.

**Ping:** каждые 25 сек. Если ping не приходит дольше 60 сек — соединение считается мёртвым, переподключайтесь.

**Важно:** SSE — это «триггер для sync», а не канал данных. На событие `*_updated` клиент **должен** вызвать `GET /sync?since={last_cursor}` — само событие содержит только тип и `entityId`, актуальное состояние нужно подтянуть отдельно. Для `*_deleted` достаточно удалить локальную запись по `entityId`.

## Offline-first архитектура клиента

Главное правило: **UI никогда не делает прямой `POST /deliveries`**. Сохранение должно идти через локальную БД и очередь.

```
[UI "Сохранить"]
      ↓ применить optimistic-изменение
      ↓ записать в Room: delivery + mutation в queue
[Sync Worker (WorkManager)]
      ↓ периодически или по триггеру
      ↓ забрать pending mutations из queue
      ↓ POST /api/v1/deliveries
      ├ 200 → удалить mutation, обновить delivery из ответа
      ├ 409 → флаг conflictPending=true, ждать UI-разрешения
      ├ 5xx → retry с exponential backoff (max 6 попыток)
      └ 4xx (кроме 409) → drop (логирование ошибки)
[SSE Listener]
      ↓ при invalidation-событии
      ↓ запустить sync-pull
```

Образец на TypeScript (один-в-один переносится на Kotlin):

- [`apps/web/src/services/sync.ts`](../apps/web/src/services/sync.ts) — push/pull цикл с cursor
- [`apps/web/src/services/conflictResolver.ts`](../apps/web/src/services/conflictResolver.ts) — стратегии разрешения 409
- [`apps/web/src/services/photoPipeline.ts`](../apps/web/src/services/photoPipeline.ts) — двухэтапный photo pipeline
- [`apps/web/src/lib/db.ts`](../apps/web/src/lib/db.ts) — IndexedDB schema (на Kotlin — Room с аналогичными таблицами `deliveries`, `mutations`, `photos`, `source_documents`, `references`, `settings`)

## Cert pinning (рекомендуется для production)

КПП работают на полевых Wi-Fi (стройплощадки, общие сети) — это типичные сценарии MITM. Чтобы исключить подмену сертификата:

```kotlin
// Для Let's Encrypt пиннить нужно intermediate (R10/R11/E5/E6), не leaf —
// leaf обновляется каждые 60-90 дней.
val pinner = CertificatePinner.Builder()
    .add("matcheck.fvds.ru", "sha256/<base64-SPKI-hash-intermediate>")
    .add("matcheck.fvds.ru", "sha256/<base64-SPKI-hash-backup-intermediate>")
    .build()

val client = OkHttpClient.Builder()
    .certificatePinner(pinner)
    .build()
```

Узнать актуальный SPKI hash intermediate:

```bash
openssl s_client -connect matcheck.fvds.ru:443 -servername matcheck.fvds.ru < /dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary \
  | openssl enc -base64
```

Включать минимум 2 хеша (текущий + резервный intermediate), чтобы не положить приложение при ротации CA.

## Генерация Kotlin-клиента

```bash
# Установить OpenAPI Generator CLI (требует JRE 11+)
npm install -g @openapitools/openapi-generator-cli

# Сгенерировать Kotlin/Retrofit2 клиент
openapi-generator-cli generate \
  -i packages/contracts/openapi.json \
  -g kotlin \
  -o ./generated/matcheck-api \
  --additional-properties=\
library=jvm-retrofit2,\
serializationLibrary=kotlinx_serialization,\
dateLibrary=java8,\
useCoroutines=true,\
packageName=ru.matcheck.api
```

Получаете:
- `ru.matcheck.api.models.*` — data classes для всех схем (Delivery, SourceDocument, и т.д.)
- `ru.matcheck.api.apis.*` — Retrofit-интерфейсы по тегам (AuthApi, DeliveriesApi, ...)
- `ru.matcheck.api.infrastructure.*` — ApiClient, авторизация, сериализация

Подключите как Gradle-модуль в Android-проект или как локальный maven-репозиторий.

## FAQ

**Q: Можно использовать cookies на Android?**  
A: Технически — да, через `JavaNetCookieJar`. Практически — не нужно. Все возможности cookies покрыты Bearer-flow + `X-Client-Type: mobile`. Cookies усложняют отладку и не дают преимуществ.

**Q: Как тестировать на dev/staging?**  
A: Запросите у matcheck-команды доступ к staging-окружению или тестовому аккаунту `inspector_kpp` на production с фиктивной площадкой. До этого можно поднять локальный API: см. `README.md` корня репо.

**Q: Что делать, если фото большое и upload в S3 падает?**  
A: Уменьшите `maxSide` при сжатии (с 2048 до 1600 или 1280). На дешёвых Android-планшетах с медленным процессором InSampleSize=2 уже даёт нормальное качество. Также убедитесь, что upload идёт **поверх HTTP/2** — OkHttp по умолчанию это поддерживает, но за прокси может опускаться до HTTP/1.1.

**Q: SSE отваливается через 30-60 сек на 4G/LTE.**  
A: Это типично для мобильных сетей с агрессивным idle-timeout. Реализуйте автореконнект с jitter (2..10 сек) и обновляйте отображение «онлайн/офлайн» по факту получения ping. Альтернатива — отключить SSE на мобильном и полагаться на periodic sync через WorkManager (но реактивность хуже).

**Q: Где Postman/Insomnia коллекция?**  
A: [`docs/mobile-api/postman.json`](mobile-api/postman.json) — генерируется из openapi.json. Импортируйте в Postman / Bruno / Insomnia.

## Контакты и обратная связь

- Технические вопросы по API: создайте issue в репозитории matcheck с тегом `mobile-api`
- Breaking changes контракта согласовываются заранее в issue/Slack
- Drift между Zod и openapi.json ловит CI — если PR упал на job `contracts-drift`, выполните локально:
  ```bash
  pnpm --filter @matcheck/contracts gen:openapi
  git add packages/contracts/openapi.json
  ```

## Verification: ручная проверка mobile-flow

После деплоя изменений (этот PR) проверьте через curl:

```bash
# 1. Login с X-Client-Type: mobile — refreshToken должен прийти в теле
curl -i -X POST https://matcheck.fvds.ru/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Client-Type: mobile" \
  -d '{"email":"<email>","password":"<password>"}'

# Ожидаем:
# HTTP/2 200
# (нет Set-Cookie с __Host-refresh)
# {"accessToken":"...","expiresIn":900,"user":{...},"refreshToken":"...","refreshExpiresIn":1209600}

# 2. Refresh через Authorization: Bearer
REFRESH="<вставить refreshToken из шага 1>"
curl -i -X POST https://matcheck.fvds.ru/api/v1/auth/refresh \
  -H "X-Client-Type: mobile" \
  -H "Authorization: Bearer $REFRESH"

# Ожидаем:
# HTTP/2 200
# {"accessToken":"...","expiresIn":900,"refreshToken":"новый","refreshExpiresIn":1209600}

# 3. Reuse старого refresh → 401 (старый теперь инвалидирован)
curl -i -X POST https://matcheck.fvds.ru/api/v1/auth/refresh \
  -H "X-Client-Type: mobile" \
  -H "Authorization: Bearer $REFRESH"

# Ожидаем:
# HTTP/2 401
# {"error":"invalid_refresh"}

# 4. Веб-flow (без X-Client-Type) — cookies устанавливаются, refreshToken в теле НЕТ
curl -i -X POST https://matcheck.fvds.ru/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<email>","password":"<password>"}'

# Ожидаем:
# HTTP/2 200
# set-cookie: __Host-refresh=...
# set-cookie: __Host-access=...
# {"accessToken":"...","expiresIn":900,"user":{...}}    ← без refreshToken
```
