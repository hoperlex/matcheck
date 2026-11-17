-- Ручные МОЛ в выпадающих списках: старый импорт 01.06.2026 уходит в архив.
--
-- Списки выбора МОЛ на портале перестают фильтровать source=fot и показывают
-- всех активных: ФОТ + заведённых вручную (кладовщики, которых нет в ФОТ).
-- 39 ручных записей из импорта 01.06 (ПТО, геодезия, сисадмин…) иначе
-- засорили бы эти списки. На 17.11 ни на одну нет ссылок.
--
-- Отбор — по явному списку id, снятому с боя 17.11 (возраст записи
-- принадлежность к импорту не доказывает). Ссылки перепроверяются в момент
-- применения: запись, на которую успели сослаться, остаётся активной.
--
-- Журнал responsible_persons_archived_0150 хранит ровно те строки, которые
-- изменила эта миграция, и момент изменения. Down по нему снимает архив только
-- с нетронутых с тех пор записей (updated_at = archived_at): решение
-- менеджера, принятое после миграции, и архив, бывший до неё, откат не
-- отменяет. Журнал удаляется down-миграцией.
--
-- Планшет: строки уйдут дельтой /sync (отбор по updated_at) с isActive=false,
-- контракт тот же. МОЛ на планшете не выбирают.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS responsible_persons_archived_0150 (
  id uuid PRIMARY KEY,
  archived_at timestamptz NOT NULL
);
--> statement-breakpoint
WITH legacy(id) AS (
  VALUES
    ('49009881-9a22-42a8-8584-4205c87bed3c'::uuid), -- Александрович О.В. (геодезия)
    ('cb538a93-81dd-44ce-b46d-7805b759d63e'::uuid), -- Ахмадуллов А.И.
    ('e2cb5454-8367-4f22-8a67-871f654e7e45'::uuid), -- Барулин И.А. (ПТО)
    ('9470bc87-ee93-4e87-b509-46939cb69904'::uuid), -- Белорусец С.В.
    ('317ffdbe-d52e-4fe4-9e16-e33447419a1e'::uuid), -- Берсенев А.В.
    ('33c95719-acc6-43c1-8369-cedb476bc266'::uuid), -- Бешлей О.И.
    ('5cd4a3c1-4489-43c9-9cef-4799ec1b3738'::uuid), -- Гнатуша В.А.
    ('dd0986e7-8e59-4d61-a6b6-fe028b1e7c1c'::uuid), -- Джумаев Абдусаттор Х.
    ('3a2976c4-0afd-4ee6-8fcd-81360d9430c9'::uuid), -- Дмитриев А.А. (ПТО)
    ('2be28659-782a-4d65-ab2d-3072ed59a2d6'::uuid), -- Долгих А.И. (СВК)
    ('89e7f583-b900-40b3-8248-fc30aa8f678f'::uuid), -- Долотказин А.Р. (автотехник)
    ('3bc8b692-e0b0-476d-ad02-e62e2b638c73'::uuid), -- Жабунин А.А.
    ('0f9cf6e6-8211-401c-ac67-c1fe8833824c'::uuid), -- Зоричев Д.В.
    ('f0072179-3772-4d2f-a762-fb4d58bfa6e6'::uuid), -- Качугин С.А. (сис. админ)
    ('c8e3541c-5997-4187-8a6b-908205536583'::uuid), -- Кобилов А.Ж.
    ('58009608-9a1d-40cb-91d8-fc548b887ef5'::uuid), -- Козак Н.Б.
    ('091db316-9a3a-47bb-8428-80fe14dc458a'::uuid), -- Колбухов Д.Н. (гл. энергетик)
    ('2d61c13d-e37e-4891-a5e5-5cb1ea8aa7d7'::uuid), -- Кутько В.Н. (ДМР)
    ('a434f3c0-e342-49ac-9477-12e37cdea86a'::uuid), -- Кучаров Р.Б. (геодезия)
    ('b28f7dad-44b8-49f7-97bf-559324a4b94f'::uuid), -- Ложко Л.Е. (техн.рук.)
    ('2a823c49-05a1-4c1b-8fc6-3523feab3eef'::uuid), -- Лосев Б.С.
    ('b1c386b8-fba0-4481-8ca8-8b24c07dd1ec'::uuid), -- Маматхалилов Д.А.
    ('178033ef-41fc-44dc-a060-35e64ce3521e'::uuid), -- Матросов Р.М.
    ('6a110244-7246-4eb8-b225-78e573ec164a'::uuid), -- Морозова В.А.
    ('097c5336-2b66-4a48-8010-3917451c30e0'::uuid), -- Насиковский А.Б.
    ('f2e601b2-b1ae-4f3d-9a70-787b11e48d6a'::uuid), -- Насирдинов С.К. (техн.рук.)
    ('0ad41b4b-3fab-42bd-aa1e-fcda4af15bdb'::uuid), -- Орехова Г.М.
    ('8b004a9a-9f6b-4111-9c8d-72de919b959f'::uuid), -- Полунков И.Н. (ПТО)
    ('928abe8d-c9db-4767-a63d-2cef9bfd2356'::uuid), -- Руин А.В.
    ('d3415753-70bd-4b7c-b051-f5a1042451d3'::uuid), -- Савин А.С.
    ('b3da3440-7d54-4a83-bd53-997cd2d5593f'::uuid), -- Сатыбалдиева Е.В. (ПТО)
    ('8ec8151b-dae2-4440-bc5c-6618733fabd7'::uuid), -- Ситдиков Р.А. (рук. фасад.)
    ('e1f7de96-c058-4768-9ca7-43c5be0c2eee'::uuid), -- Филатова В.А. (ПТО)
    ('d7047267-d85a-4808-966d-1f8936411820'::uuid), -- Хадисов И.Ш. (механик)
    ('3c6f9f78-3045-4b67-85ce-4742d90992b4'::uuid), -- Черников С.С.
    ('38657baf-f0bc-4bcd-9379-3898ef34f93c'::uuid), -- Шашмурин Б.Б.
    ('7a7bcb01-d7e8-4c01-afa9-ba62a964c7fc'::uuid), -- Шуст О.П. (ПТО)
    ('67cbf763-0a5d-4921-bd50-0b9913e04102'::uuid), -- Щербаков М.А.
    ('cb869775-87ba-4180-8cf6-b5d0a273217c'::uuid)  -- Якимов А.С. (геодезия)
),
upd AS (
  UPDATE responsible_persons rp
     SET is_active = false,
         updated_at = now()
    FROM legacy l
   WHERE rp.id = l.id
     AND rp.fot_employee_id IS NULL
     AND rp.is_active
     AND NOT EXISTS (SELECT 1 FROM source_documents x WHERE x.recipient_mol_id = rp.id)
     AND NOT EXISTS (SELECT 1 FROM source_bundles x WHERE x.recipient_mol_id = rp.id)
     AND NOT EXISTS (SELECT 1 FROM deliveries x WHERE x.recipient_mol_id = rp.id)
     AND NOT EXISTS (SELECT 1 FROM delivery_sources x WHERE x.recipient_mol_id = rp.id)
     AND NOT EXISTS (SELECT 1 FROM shipments x WHERE x.receiver_mol_id = rp.id)
  RETURNING rp.id, rp.updated_at
)
INSERT INTO responsible_persons_archived_0150 (id, archived_at)
SELECT id, updated_at FROM upd
ON CONFLICT (id) DO NOTHING;
