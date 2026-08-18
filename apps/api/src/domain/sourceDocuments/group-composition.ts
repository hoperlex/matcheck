// Канонический состав машины: какие именно документы обязана содержать
// операция, создаваемая по группе.
//
// Зачем отдельный модуль, а не запрос по месту. Состав нужен трём разным
// местам — проверке upsert, созданию claim и порталу, — и это ровно тот случай,
// когда две реализации расходятся при первой правке. Причём расходятся молча:
// сервер потребует документ, которого клиент никогда не видел, и валидная
// машина будет отклонена как «неполный состав».
//
// Главная тонкость — archived. Он НЕ блокирует готовность группы (осознанно
// исключённый дубль или сертификат не должен держать машину вечно), но и на
// планшет не уезжает: предикат видимости требует status = 'parsed'. Поэтому
// «все нетехнические неудалённые документы» — неверный состав. Верный — ровно
// то, что клиент реально получил, то есть mobileVisibleSourceDocumentSql.
//
// Второй источник расхождения — поколение загрузки. Пакет, перезалитый после
// удаления документов, имеет старые строки прошлого поколения; documentGroupIdSql
// уже учитывает и assembly_version, и актуальность поколения, поэтому здесь он
// переиспользуется, а не повторяется.

import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sourceDocuments } from '../../db/schema.js';
import { documentGroupIdSql, documentGroupRevisionSql } from './document-group.js';
import { mobileVisibleSourceDocumentSql } from './mobile-visibility.js';

/** Почему состав не удалось принять. Каждый случай — свой typed-ответ клиенту. */
export type GroupCompositionError =
  /** В присланном списке один и тот же документ дважды. */
  | { kind: 'duplicate_documents'; documentIds: string[] }
  /** Документы принадлежат разным машинам — операция по ним невозможна. */
  | { kind: 'multiple_groups'; groupIds: string[] }
  /** Присланный groupId не совпал с вычисленным сервером. */
  | { kind: 'group_mismatch'; expected: string | null; received: string }
  /** Состав машины изменился с момента, когда планшет открыл форму. */
  | { kind: 'group_changed'; expected: number | null; received: number }
  /** Прислано подмножество: часть документов машины отсутствует. */
  | { kind: 'incomplete_group'; missing: string[]; extra: string[] };

export type GroupComposition = {
  /** Корневой пакет машины. null — документы группы не образуют. */
  groupId: string | null;
  /** Версия состава на момент чтения; null для негрупповых документов. */
  groupRevision: number | null;
  /** Полный состав, который клиент обязан прислать целиком. */
  documentIds: string[];
};

type DocRow = { id: string; groupId: string | null; groupRevision: number | null };

/**
 * Группа присланных документов и её полный канонический состав.
 *
 * Возвращает `null` в `groupId`, когда группы нет вовсе: одиночный документ,
 * ручной внос, legacy-сборка. Это законный и самый частый случай — вызывающий
 * обязан пропустить такую операцию по прежнему пути, без claim и проверок.
 *
 * Вызывать ВНУТРИ транзакции, уже заблокировавшей корневой пакет: иначе между
 * чтением состава и записью операции воркер успеет добавить в машину документ.
 */
export async function resolveGroupComposition(
  db: Db,
  args: { documentIds: string[]; siteId: string | null; direction: 'inbound' | 'outbound' },
): Promise<{ composition: GroupComposition } | { error: GroupCompositionError }> {
  const { documentIds, siteId, direction } = args;

  // Дубли ловим до запроса: сравнение множеств их бы не заметило, а вставка
  // связей упала бы по первичному ключу junction-таблицы — то есть 500 вместо
  // внятного отказа.
  const seen = new Set<string>();
  const duplicates = documentIds.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  if (duplicates.length > 0) {
    return { error: { kind: 'duplicate_documents', documentIds: [...new Set(duplicates)] } };
  }

  if (documentIds.length === 0) {
    // Ручная приёмка без документов — законный путь, группы у неё нет.
    return { composition: { groupId: null, groupRevision: null, documentIds: [] } };
  }

  const idList = sql.join(
    documentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const sent = await db.execute<DocRow>(sql`
    select ${sourceDocuments.id} as id,
           ${documentGroupIdSql()} as "groupId",
           ${documentGroupRevisionSql()} as "groupRevision"
      from ${sourceDocuments}
     where ${sourceDocuments.id} in (${idList})
  `);

  const groupIds = [...new Set(sent.map((r) => r.groupId).filter((g): g is string => !!g))];
  if (groupIds.length > 1) {
    return { error: { kind: 'multiple_groups', groupIds } };
  }
  // Ни один документ не входит в группу — прежний путь.
  if (groupIds.length === 0) {
    return { composition: { groupId: null, groupRevision: null, documentIds: [] } };
  }

  const groupId = groupIds[0]!;
  const groupRevision = sent.find((r) => r.groupId === groupId)?.groupRevision ?? null;

  // Полный состав: то, что планшет реально получил бы по этой машине. Условия
  // по объекту и направлению — часть состава, а не отдельная проверка: документ
  // соседнего объекта в ту же операцию попасть не может, и требовать его от
  // клиента нельзя.
  const scope = [
    sql`(${documentGroupIdSql()}) = ${groupId}::uuid`,
    mobileVisibleSourceDocumentSql(),
    sql`${sourceDocuments.direction} = ${direction}`,
    ...(siteId ? [sql`${sourceDocuments.siteId} = ${siteId}::uuid`] : []),
  ];
  const members = await db.execute<{ id: string }>(sql`
    select ${sourceDocuments.id} as id
      from ${sourceDocuments}
     where ${sql.join(scope, sql` and `)}
     order by ${sourceDocuments.id}
  `);

  return {
    composition: { groupId, groupRevision, documentIds: members.map((r) => r.id) },
  };
}

/**
 * Сверка присланного набора с каноническим составом.
 *
 * Отдельной функцией, потому что вызывается и приёмкой, и отгрузкой, и обе
 * обязаны отвечать одинаково: «прислал не всю машину» — это не то же самое, что
 * «прислал чужой документ», и клиенту нужны оба списка, чтобы объяснить
 * инспектору, что произошло.
 */
export function compareWithComposition(
  sent: string[],
  composition: GroupComposition,
): GroupCompositionError | null {
  const canonical = new Set(composition.documentIds);
  const provided = new Set(sent);
  const missing = composition.documentIds.filter((id) => !provided.has(id));
  const extra = sent.filter((id) => !canonical.has(id));
  if (missing.length === 0 && extra.length === 0) return null;
  return { kind: 'incomplete_group', missing, extra };
}
