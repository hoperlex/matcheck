-- Контакт пользователя и автор УПД — для функции «позвонить менеджеру»
-- из мобильного клиента (в шапке списка материалов на 1 Этапе показывается
-- кнопка-чип с именем + ☎, тап → ACTION_DIAL).
--
-- 1) users.phone — добровольный E.164-номер. Хранится «как ввели» (мобила/веб
--    при показе нормализует к +7XXXXXXXXXX для tel:URI). Длина 32 запас под
--    форматные символы (+ - () пробелы) на случай, если кто-то не нормализует.
-- 2) source_documents.created_by_user_id — пользователь, ЗАГРУЗИВШИЙ УПД
--    через /upload-upd (XML) или /upload-upd-pdf (PDF). Для УПД из EDO/mail
--    автора нет (poller, не юзер) — поле остаётся NULL, мобила в этом случае
--    кнопку звонка не показывает. ON DELETE SET NULL: удаление пользователя
--    не каскадирует на УПД, как и существующая практика (deliveries.inspector_id,
--    confirmed_by_mol_user_id и т. д.).
ALTER TABLE "users"
  ADD COLUMN "phone" varchar(32) NULL;

ALTER TABLE "source_documents"
  ADD COLUMN "created_by_user_id" uuid NULL
    REFERENCES "users"("id") ON DELETE SET NULL;

CREATE INDEX "source_documents_created_by_idx"
  ON "source_documents" ("created_by_user_id")
  WHERE "created_by_user_id" IS NOT NULL;
