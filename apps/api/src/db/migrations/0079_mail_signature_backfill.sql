-- Пометка картинок из подписей писем, принятых до исправления фильтра.
--
-- Прежнее условие требовало одновременно четырёх признаков (multipart/related,
-- ссылка из html по Content-ID, тип image/*, размер меньше порога) и на реальной
-- почте не срабатывало ни разу: Outlook и mail.ru кладут иконки подписи в
-- multipart/mixed без Content-ID. В результате 60 иконок — от 121 байта до
-- 174 КБ — попали в состояние `kept` и ушли бы в пакет вместе с настоящим УПД.
--
-- Здесь тот же приговор задним числом. Правило продублировано на SQL осознанно:
-- миграция — снимок логики на момент выката, иначе пришлось бы выкачивать
-- каждое письмо из хранилища и прогонять через код.
--
-- Что НЕ трогается: sha256, staging_s3_key, idx, порядок и число вложений,
-- статусы писем. Файлы остаются на месте — оператор видит их в разборе и
-- возвращает кнопкой «Вернуть».
--
-- Условия одинаковы в обоих запросах и повторяют порядок проверок в коде
-- (domain/mail/attachment-filter.ts): подпись рассматривается только ПОСЛЕ
-- того, как тип опознан и признан пригодным.
--   * status = 'quarantined' — у разобранного письма пакет уже собран, менять
--     состав задним числом значит врать о том, что ушло в распознавание;
--   * state = 'kept' — `restored` это явное решение человека, его не трогаем;
--   * staging_s3_key IS NOT NULL — нельзя помечать то, чего нет в хранилище:
--     отброшенное туда не заливается, и «вернуть» такое вложение невозможно;
--   * sniffed_mime LIKE 'image/%' — порог размера применим ТОЛЬКО к картинкам.
--     Самый лёгкий настоящий документ на проде — xlsx-подтверждение отгрузки на
--     10 КБ, и оно обязано остаться документом.
--
-- Порядок запросов важен: сначала размер, потом имя — чтобы причина совпадала
-- с той, что проставит рантайм у нового письма.

UPDATE mail_attachments a
SET state = 'suspected_signature',
    skip_reason = 'small_image'
FROM mail_messages m
WHERE m.id = a.mail_message_id
  AND m.status = 'quarantined'
  AND a.state = 'kept'
  AND a.staging_s3_key IS NOT NULL
  AND a.sniffed_mime LIKE 'image/%'
  -- Порог совпадает с DEFAULT_ATTACHMENT_LIMITS.signatureMaxBytes = 25 * 1024.
  AND a.size_bytes < 25600;

-- Штамп почтового клиента: Outlook вставляет `OutlookEmoji-<время><uuid>`,
-- mail.ru — `mailrusigimg_<id>`. Имя генерирует клиент, у скана его быть не
-- может, поэтому размер здесь не важен: на проде такие «эмодзи» весят 174 КБ.
UPDATE mail_attachments a
SET state = 'suspected_signature',
    skip_reason = 'mail_client_stamp'
FROM mail_messages m
WHERE m.id = a.mail_message_id
  AND m.status = 'quarantined'
  AND a.state = 'kept'
  AND a.staging_s3_key IS NOT NULL
  AND a.sniffed_mime LIKE 'image/%'
  -- Регулярка, а не ILIKE: символ подчёркивания в LIKE означает «любой знак»,
  -- и шаблон пришлось бы экранировать. Выражение дословно совпадает с
  -- MAIL_CLIENT_STAMP_RE из attachment-filter.ts.
  AND a.filename ~* '^(outlookemoji-|mailrusigimg[-_])';
