-- Маркер «фото подтверждено в S3» для cleanup-job orphan-записей.
--
-- В текущем pipeline (POST /photos/presign) запись в delivery_photos /
-- shipment_photos создаётся ДО PUT в S3. Если клиент не выполнит PUT (батарея,
-- выход из приложения, потеря сети), в БД остаётся orphan-запись со s3Key,
-- по которому объекта в S3 нет — GET /photos/:id/url отдаст 404.
--
-- Решение: после успешного PUT клиент вызывает POST /photos/{id}/confirm —
-- сервер делает S3.HEAD и проставляет uploaded_at = now(). Cleanup-job раз в
-- час чистит записи с uploaded_at IS NULL и taken_at < now() - 1 hour.
--
-- Существующие записи (до миграции) — backfill: считаем все ранее загруженные
-- фото подтверждёнными (uploaded_at = taken_at), чтобы cleanup-job не удалил
-- их по ошибке.

ALTER TABLE delivery_photos
  ADD COLUMN uploaded_at timestamptz NULL;
ALTER TABLE shipment_photos
  ADD COLUMN uploaded_at timestamptz NULL;

-- Backfill: считаем все существующие фото подтверждёнными, дата подтверждения
-- — taken_at (точное время неизвестно, это лучшее приближение).
UPDATE delivery_photos SET uploaded_at = taken_at WHERE uploaded_at IS NULL;
UPDATE shipment_photos SET uploaded_at = taken_at WHERE uploaded_at IS NULL;

-- Partial-индекс для cleanup-job: быстро найти неподтверждённые orphan'ы.
CREATE INDEX delivery_photos_orphan_idx
  ON delivery_photos (taken_at)
  WHERE uploaded_at IS NULL;
CREATE INDEX shipment_photos_orphan_idx
  ON shipment_photos (taken_at)
  WHERE uploaded_at IS NULL;
