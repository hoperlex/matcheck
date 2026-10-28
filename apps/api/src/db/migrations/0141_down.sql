-- Откат 0141: сначала откатить код интеграции EstiMat (маршруты, обход, веб),
-- потом схему. Привязки заказов к приёмкам откат не переживёт — откатывать,
-- только если их нет.
DO $$
BEGIN
  IF to_regclass('delivery_supplier_orders') IS NOT NULL
     AND EXISTS (SELECT 1 FROM delivery_supplier_orders) THEN
    RAISE EXCEPTION 'Откат 0141 невозможен: есть привязки заказов EstiMat к приёмкам — сначала отвяжите их';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS delivery_supplier_orders;
--> statement-breakpoint
DROP TABLE IF EXISTS estimat_sync_runs;
--> statement-breakpoint
DROP TABLE IF EXISTS estimat_supplier_order_events;
--> statement-breakpoint
DROP TABLE IF EXISTS estimat_supplier_orders;
