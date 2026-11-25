-- Откат 0159: сначала откатить портал и API (они читают таблицу). Ручные связи
-- «подрядчик × объект» теряются безвозвратно; данные 1С возвращает повторный
-- импорт scripts/import-contractor-sites.ts после повторного наката 0159.
DROP TABLE IF EXISTS customer_counterparty_sites;
