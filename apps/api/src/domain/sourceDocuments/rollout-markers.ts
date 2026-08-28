import { sql, type SQL } from 'drizzle-orm';

/**
 * Метки выкатного и обратного прогонов новой модели машины.
 *
 * Живут в domain, а не в самом скрипте, по одной причине: правило «помечен ли
 * документ ТЕКУЩИМ выкатом» решает, узнает ли планшет о скрытии документа, и
 * проверить его можно только у настоящей БД — оно целиком на NULL-семантике и
 * сравнении времён. Внутри scripts/ оно было бы непроверяемым.
 */
export const ROLLOUT_MARKER = 'rollout:groups-v1';
export const ROLLBACK_MARKER = 'rollout:groups-v1:rollback';

/**
 * Помечен ли документ выкатом, который действует СЕЙЧАС.
 *
 * Наивная проверка «событие с таким reason когда-либо было» ломается на втором
 * круге: после цикла выкат → откат → выкат повторный выкат не пометил бы ни
 * одного документа, планшеты не получили бы меток удаления и остались бы с
 * документами, которых по новому правилу видеть не должны. Поэтому отсчёт
 * ведётся от последнего отката: значима только метка, поставленная после него.
 *
 * `-infinity` вместо epoch: у документа, который не откатывали ни разу,
 * сравнение обязано пропустить ЛЮБУЮ метку выката, включая проставленную
 * задним числом при переносе данных.
 *
 * Работает только внутри выборки по source_documents — ссылается на её колонку
 * id без алиаса, как и предикат видимости рядом.
 */
export function markedByCurrentRolloutSql(): SQL {
  return sql`exists (
    select 1 from source_document_visibility_events e
     where e.source_document_id = source_documents.id
       and e.reason = ${ROLLOUT_MARKER}
       and e.created_at > coalesce((
         select max(r.created_at) from source_document_visibility_events r
          where r.source_document_id = source_documents.id
            and r.reason = ${ROLLBACK_MARKER}
       ), '-infinity'::timestamptz)
  )`;
}
