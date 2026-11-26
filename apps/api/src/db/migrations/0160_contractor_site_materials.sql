-- Ручной вид «Материалы подрядчика» у связи «подрядчик × объект» (0159).
-- 1С («Списание по субподряду») знает только, как НАШИ материалы передаются
-- подрядчику: реализация или давальческий. Что подрядчик работает на объекте
-- своими материалами, видно только людям — такой вид ставится в карточке
-- контрагента. Код совпадает с признаком приёмки contractor_materials.
-- onec_kind не меняется: импорт 1С этот вид не пишет.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE customer_counterparty_sites
  DROP CONSTRAINT IF EXISTS customer_counterparty_sites_manual_kind_check;
--> statement-breakpoint
ALTER TABLE customer_counterparty_sites
  ADD CONSTRAINT customer_counterparty_sites_manual_kind_check
  CHECK (
    manual_kind IS NULL
    OR manual_kind IN ('realization', 'tolling_act', 'realization_tolling', 'contractor_materials', 'none')
  );
