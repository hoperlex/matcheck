-- Откат 0107: «обработано» снова требует номер, дату и сумму.
--
-- ВНИМАНИЕ: за время жизни 0107 в базе появляются УПД в статусе `parsed` без
-- даты или без суммы — это и есть смысл миграции. Прежний CHECK на таких
-- данных не создастся, поэтому откат СНАЧАЛА возвращает их в работу и только
-- потом ставит ограничение. Комментария тут недостаточно: без этого шага
-- миграция упала бы на живой базе.
--
-- ДЕСТРУКТИВНО в одном смысле: документы, уже уехавшие инспектору, снимаются с
-- планшета обратно к менеджеру. Приёмки, созданные по ним, не затрагиваются —
-- связь операции с документом ограничением не проверяется.

UPDATE "source_documents"
   SET "status" = 'needs_resolution',
       "parse_error_code" = 'partial_parse',
       "parse_error_details" = COALESCE("parse_error_details", '{}'::jsonb)
         || jsonb_build_object('missing',
              (SELECT jsonb_agg(x) FROM (
                 SELECT 'docDate' AS x WHERE "doc_date" IS NULL
                 UNION ALL
                 SELECT 'totalSum' WHERE "total_sum" IS NULL
               ) t),
              'revertedBy', '0107_down'),
       "updated_at" = now()
 WHERE "kind" = 'upd'
   AND "status" = 'parsed'
   AND ("doc_date" IS NULL OR "total_sum" IS NULL);

ALTER TABLE "source_documents" DROP CONSTRAINT IF EXISTS "source_upd_required";

ALTER TABLE "source_documents" ADD CONSTRAINT "source_upd_required" CHECK (
  ("kind" <> 'upd')
  OR ("status" <> 'parsed')
  OR ("doc_number" IS NOT NULL AND "doc_date" IS NOT NULL AND "total_sum" IS NOT NULL)
);
