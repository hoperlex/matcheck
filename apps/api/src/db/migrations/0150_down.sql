-- Откат 0150: сначала откатить портал и API (иначе вернувшиеся 39 записей
-- окажутся в списках выбора МОЛ).
--
-- Снимает архив только со строк из журнала, которых с момента миграции никто
-- не трогал (updated_at = archived_at). Запись, которую менеджер после
-- миграции вернул и снова отправил в архив (или поправил), остаётся как есть;
-- архивные до миграции записи в журнал не попадали вовсе. Повторный запуск
-- безопасен: без журнала UPDATE пропускается.
DO $$
BEGIN
  IF to_regclass('public.responsible_persons_archived_0150') IS NOT NULL THEN
    UPDATE responsible_persons rp
       SET is_active = true,
           updated_at = now()
      FROM responsible_persons_archived_0150 j
     WHERE rp.id = j.id
       AND NOT rp.is_active
       AND rp.updated_at = j.archived_at;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS responsible_persons_archived_0150;
