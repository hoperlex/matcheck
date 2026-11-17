-- «Высота» вместо «ИП Сатаневский» в приёмках (жалоба 17.11, приёмка 25616).
--
-- Строку counterparties 23b221d5 (ИНН «ООО "ВЫСОТА"» 7727294638, КПП NULL, имя
-- «ИП Сатаневский Никита Михайлович») завело распознавание накладных 11957,
-- 11992 и 12029: модель дала грузополучателю ИНН грузоотправителя. Строка
-- заняла место «ИНН без КПП» «Высоты», и выбор «Высоты» поставщиком в
-- приёмке ставил чужое имя. На 17.11 так получили 24888, 24994, 25616, 25619
-- и 25693.
--
-- Скрипт переименовывает строку в «ООО "ВЫСОТА"» (приёмки, ссылающиеся на неё,
-- станут «Высотой» без повторного выбора) и снимает грузополучателя у трёх
-- накладных — то, что для новых документов делает 5a3fb00. Имя
-- грузополучателя (consignee_name_raw) остаётся.
--
-- Порядок: как можно раньше, лучше до выката 5a3fb00 / 9a9bcd3 / bc1ed83. Если
-- выкат прошёл первым (17.11 так и вышло: миграция 0150 — 11:48 UTC), то до
-- запуска скрипта выбор «Высоты» получает 409 supplier_inn_taken. После
-- запуска пять приёмок становятся «Высотой» без повторного выбора.
--
-- Все проверки внутри DO-блока: при любом расхождении — исключение и откат
-- всего. Приёмок может быть больше 4: каждая ссылка через supplier_id — это
-- выбор «Высоты» (у «ИП Сатаневского» в справочнике другой ИНН). Их число
-- выводится в NOTICE.
--
-- Запуск: psql -v ON_ERROR_STOP=1 -f apps/api/scripts/vysota-supplier-2026-11-17.sql
begin;
do $$
declare
  cp constant uuid := '23b221d5-5bbc-49fd-85c0-28dd2bb76e3f';
  n int;
begin
  select (select count(*) from deliveries where contractor_id = cp)
       + (select count(*) from shipments where supplier_id = cp or receiver_counterparty_id = cp)
       + (select count(*) from delivery_sources where contractor_id = cp)
       + (select count(*) from source_bundles where contractor_id = cp)
       + (select count(*) from mail_accounts where default_contractor_id = cp)
       + (select count(*) from mail_routes where contractor_id = cp)
       + (select count(*) from source_documents
           where cp in (supplier_id, buyer_id, recipient_id, contractor_id))
    into n;
  if n <> 0 then raise exception 'посторонние ссылки на строку: %', n; end if;

  update counterparties
     set name = 'ООО "ВЫСОТА"', is_supplier = true, is_customer = false, updated_at = now()
   where id = cp and inn = '7727294638' and name = 'ИП Сатаневский Никита Михайлович';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'counterparties: ждали 1, затронуто %', n; end if;

  update source_documents
     set consignee_id = null, consignee_inn_raw = null, updated_at = now()
   where id in ('5abfe1b9-5f18-4270-85bd-2a5ec1fc6713',
                'f6df0818-b7b1-4b9a-bde6-2ed09b04f8d2',
                '01183aa3-e56d-4982-b40f-b7316f55cd06')
     and consignee_id = cp;
  get diagnostics n = row_count;
  if n <> 3 then raise exception 'source_documents: ждали 3, затронуто %', n; end if;

  select count(*) into n from deliveries where supplier_id = cp;
  if n < 4 then raise exception 'приёмок с этим поставщиком %, ждали не меньше 4', n; end if;
  raise notice 'приёмок, которые станут «ООО "ВЫСОТА"»: %', n;
end $$;
commit;
