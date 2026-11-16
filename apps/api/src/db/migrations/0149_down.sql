-- Откат 0149: сначала откатить портал и API. Группы теряются целиком;
-- привязки УПД из ЭДО живут в delivery_edo_matches и остаются.
DROP TABLE IF EXISTS delivery_group_members;
--> statement-breakpoint
DROP TABLE IF EXISTS delivery_groups;
