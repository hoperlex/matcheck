import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { MolPerson } from '@matcheck/contracts';
import { responsiblePersons } from '../../db/schema.js';
import type { Db } from '../../db/client.js';

/**
 * Зеркалит МОЛ из внешней БД ФОТ в локальную таблицу
 * `responsible_persons`. Ключ — `fot_employee_id` (BIGINT UNIQUE
 * по partial-индексу из миграции 0053). Локально созданные МОЛ
 * (где `fot_employee_id IS NULL`) этим sync'ом не трогаются —
 * у них другая природа и их редактирует менеджер.
 *
 * Поведение:
 *  - INSERT для employeeId, которого ещё нет.
 *  - UPDATE для существующих ФОТ-записей: fullName/position обновляются,
 *    isActive принудительно поднимается в true (приходит = «вернулся в ФОТ»).
 *  - ФОТ-записи в БД, которых НЕТ в свежем списке из ФОТ, помечаются
 *    isActive=false (логическая деактивация — историю не теряем,
 *    из выпадающих списков скрываются через ?activeOnly=true).
 *
 * NB: НЕ удаляем строки, потому что на них могут ссылаться
 * deliveries.recipient_mol_id / source_documents.recipient_mol_id /
 * shipments.receiver_mol_id (FK SET NULL — но historical связь дороже).
 */
export async function syncFotMolToLocal(
  db: Db,
  items: MolPerson[],
  log?: FastifyBaseLogger,
): Promise<{ upserted: number; deactivated: number }> {
  if (items.length === 0) {
    // Пустой список из ФОТ — деактивацию пропускаем (это наверняка
    // ошибка/сбой, а не «уволили всех 44 человек»). Лучше показать
    // последний валидный кэш, чем обнулить справочник.
    return { upserted: 0, deactivated: 0 };
  }

  // UPSERT по fot_employee_id. position в ФОТ хранится в `position_name`
  // и мы отдаём его как positionName — кладём в локальный `position`.
  // phone в ФОТ нет — оставляем NULL.
  const values = items.map((m) => ({
    fullName: m.fullName,
    position: m.positionName,
    fotEmployeeId: m.employeeId,
    isActive: true,
  }));

  await db
    .insert(responsiblePersons)
    .values(values)
    .onConflictDoUpdate({
      target: responsiblePersons.fotEmployeeId,
      // partial unique index — указываем его условие, чтобы pg выбрал
      // именно его при ON CONFLICT.
      targetWhere: sql`${responsiblePersons.fotEmployeeId} IS NOT NULL`,
      set: {
        fullName: sql`excluded.full_name`,
        position: sql`excluded.position`,
        isActive: true,
        updatedAt: new Date(),
      },
    });

  // Деактивация ФОТ-записей, которых больше нет в свежем списке.
  // Локально созданные (fot_employee_id IS NULL) — не трогаем.
  const presentIds = items.map((m) => m.employeeId);
  const deactivated = await db
    .update(responsiblePersons)
    .set({ isActive: false, updatedAt: new Date() })
    .where(
      and(
        isNotNull(responsiblePersons.fotEmployeeId),
        notInArray(responsiblePersons.fotEmployeeId, presentIds),
        eq(responsiblePersons.isActive, true),
      ),
    )
    .returning({ id: responsiblePersons.id });

  log?.info(
    { upserted: items.length, deactivated: deactivated.length },
    'syncFotMolToLocal: done',
  );

  return { upserted: items.length, deactivated: deactivated.length };
}

/**
 * Вспомогалка, чтобы избежать гонок: если sync уже идёт — ждём его,
 * вместо того чтобы запускать второй параллельный. routes/mol.ts
 * вызывает это после каждого свежего fetchFromFot().
 */
let inflight: Promise<unknown> | null = null;
export async function syncFotMolToLocalSerialized(
  db: Db,
  items: MolPerson[],
  log?: FastifyBaseLogger,
): Promise<void> {
  if (inflight) {
    await inflight.catch(() => undefined);
    return;
  }
  inflight = syncFotMolToLocal(db, items, log).finally(() => {
    inflight = null;
  });
  await inflight.catch((err) => {
    log?.error({ err }, 'syncFotMolToLocal failed');
  });
}

// Список UUID локальных МОЛ, к которым PATCH/DELETE запрещён.
// Используется в routes/responsiblePersons.ts перед мутацией.
export async function isFotResponsiblePerson(
  db: Db,
  id: string,
): Promise<boolean> {
  const [row] = await db
    .select({ fot: responsiblePersons.fotEmployeeId })
    .from(responsiblePersons)
    .where(eq(responsiblePersons.id, id))
    .limit(1);
  return row?.fot != null;
}

// Тот же фильтр, но для bulk-delete: возвращает id-шники, которые
// принадлежат ФОТ (их удалять/менять запрещено).
export async function filterFotResponsiblePersonIds(
  db: Db,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: responsiblePersons.id })
    .from(responsiblePersons)
    .where(
      and(
        inArray(responsiblePersons.id, ids),
        isNotNull(responsiblePersons.fotEmployeeId),
      ),
    );
  return rows.map((r) => r.id);
}
