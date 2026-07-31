-- Повторный забор письма и срок хранения почты.
--
-- Зачем колонка. Письмо, которое не удалось скачать (слишком большое, обрыв
-- связи, битый MIME), после исчерпания попыток становится терминальным и
-- watermark его перешагивает — обычный проход к нему больше не вернётся.
-- Единственный способ забрать такое письмо — точечный дозабор по UID, и
-- поллеру нужен признак, какие именно UID запрошены.
--
-- Признаком не может быть статус `fetching`: он же стоит у попытки, которая
-- идёт прямо сейчас. Отдельная отметка времени различает «повтори это письмо»
-- и «эта попытка в работе», а заодно показывает оператору, когда он нажал
-- кнопку.
ALTER TABLE mail_receipts
  ADD COLUMN IF NOT EXISTS replay_requested_at timestamptz;

-- Частичный индекс: строк с запросом единицы, а поллер спрашивает про них
-- каждый проход.
CREATE INDEX IF NOT EXISTS mail_receipts_replay_idx
  ON mail_receipts (mail_account_id, uid_validity, uid)
  WHERE replay_requested_at IS NOT NULL;

-- Ускоряет выборку писем на удаление по сроку хранения: без индекса это
-- seq scan по всей таблице на каждом прогоне уборки.
CREATE INDEX IF NOT EXISTS mail_messages_retention_idx
  ON mail_messages (created_at)
  WHERE status IN ('ingested', 'rejected', 'no_attachments', 'ignored', 'rejected_sender');
