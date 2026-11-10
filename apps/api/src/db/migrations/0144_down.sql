-- Откат 0144: сначала откатить код договоров (маршруты, веб, CLI), потом схему —
-- иначе работающий API получит ошибки на пропавших таблицах. Это откат ФИЧИ
-- целиком, а не импорта: данные импорта откатываются через
-- scripts/import-contracts.ts --revert. Выбранные в приёмках договоры откат не
-- переживёт — откатывать, только если их нет.
DO $$
BEGIN
  IF to_regclass('delivery_contracts') IS NOT NULL
     AND EXISTS (SELECT 1 FROM delivery_contracts) THEN
    RAISE EXCEPTION 'Откат 0144 невозможен: в приёмках выбраны договоры — сначала отвяжите их';
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS delivery_contract_events;
--> statement-breakpoint
DROP TABLE IF EXISTS delivery_contracts;
--> statement-breakpoint
DROP TABLE IF EXISTS supplier_contract_imports;
--> statement-breakpoint
DROP TABLE IF EXISTS supplier_contracts;
