-- Откат 0147: сначала выключить канал (ONEC_INTEGRATION_ENABLED=0) и откатить код.
-- Состояние выгрузки в 1С откат не переживёт: после повторного наката все
-- подтверждённые приёмки снова попадут в очередь как new.
DROP TABLE IF EXISTS onec_detection_state;
--> statement-breakpoint
DROP TABLE IF EXISTS delivery_onec_exports;
--> statement-breakpoint
DROP TABLE IF EXISTS service_accounts;
