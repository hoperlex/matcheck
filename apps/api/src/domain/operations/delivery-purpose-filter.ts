// Фильтр «Признак приёмки» в «Принятых» — одно условие для списка и выгрузки
// Excel (оба идут через buildDeliveryFilters).
//
// Признаков у приёмки бывает несколько: общий (deliveries.purpose) и, в режиме
// «Разные получатели», свой у документа — у строки delivery_sources или у
// свободной УПД из ЭДО (delivery_edo_matches без блока скана, 0152). Приёмка
// подходит, если хоть один из них среди выбранных. Свой признак документа
// учитывается по тому же правилу, что в Excel (purposeFor в export.xlsx):
// только при включённом режиме и own_purpose. Пустой признак (NULL) — пункт
// «Не указан», и у общего, и у своего.

import { sql as drSql, type SQL } from 'drizzle-orm';
import { DELIVERY_PURPOSE_FILTER_NONE, type DeliveryPurposeFilterValue } from '@matcheck/contracts';
import { deliveries } from '../../db/schema.js';

/** Колонка признака совпала с одним из выбранных пунктов. */
function purposeMatches(column: SQL, values: readonly DeliveryPurposeFilterValue[]): SQL {
  const codes = values.filter((v) => v !== DELIVERY_PURPOSE_FILTER_NONE);
  const parts: SQL[] = [];
  if (codes.length > 0) parts.push(drSql`${column} IN ${codes}`);
  if (values.includes(DELIVERY_PURPOSE_FILTER_NONE)) parts.push(drSql`${column} IS NULL`);
  return drSql`(${drSql.join(parts, drSql` OR `)})`;
}

/**
 * Условие на строку deliveries. values — уже разобранные пункты
 * (parseDeliveryPurposeFilter), непустой список: пустой фильтр не сужает
 * выдачу, и условие для него не строится.
 */
export function deliveryPurposeFilterCondition(values: readonly DeliveryPurposeFilterValue[]): SQL {
  // CHECK 0152 (section_own_chk) не даёт своих настроек связи с блоком скана;
  // section_document_id IS NULL повторяет loadFreeEdoDocuments явно.
  return drSql`(
    ${purposeMatches(drSql`${deliveries.purpose}`, values)}
    OR (${deliveries.recipientsPerDocument} AND (
      EXISTS (
        SELECT 1 FROM delivery_sources ds_p
         WHERE ds_p.delivery_id = ${deliveries.id}
           AND ds_p.own_purpose
           AND ${purposeMatches(drSql`ds_p.purpose`, values)}
      )
      OR EXISTS (
        SELECT 1 FROM delivery_edo_matches dem_p
         WHERE dem_p.delivery_id = ${deliveries.id}
           AND dem_p.section_document_id IS NULL
           AND dem_p.own_purpose
           AND ${purposeMatches(drSql`dem_p.purpose`, values)}
      )
    ))
  )`;
}
