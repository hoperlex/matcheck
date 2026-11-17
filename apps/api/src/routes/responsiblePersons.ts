import type { FastifyInstance } from 'fastify';
import { and, eq, ilike, inArray, isNotNull, isNull, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { asZod } from '../lib/fastify.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  ResponsiblePersonConflictSchema,
  ResponsiblePersonCreateResponseSchema,
  ResponsiblePersonImportResponseSchema,
  ResponsiblePersonListResponseSchema,
  ResponsiblePersonSchema,
  ResponsiblePersonUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import type { Db } from '../db/client.js';
import { entityDeletions, responsiblePersons } from '../db/schema.js';
import {
  filterFotResponsiblePersonIds,
  isFotResponsiblePerson,
} from '../domain/mol/syncFotMol.js';
import { escapeLike } from '../lib/like.js';

const ListQuerySchema = z.object({
  q: z.string().optional(),
  activeOnly: z.coerce.boolean().optional(),
  // Фильтр по источнику МОЛ:
  //  fot   — только зеркалированные из внешней БД ФОТ (fot_employee_id IS NOT NULL);
  //  local — только заведённые в MATCHECK вручную (fot_employee_id IS NULL);
  //  all   — без фильтра (поведение по умолчанию для обратной совместимости).
  // Выпадающие списки МОЛ в Документах/Поставках/УПД/Накладной шлют
  // source=fot, чтобы пользователь выбирал ровно тот набор, что в
  // Справочники → МОЛ. Импорт-экраны и админ-страницы могут запросить
  // local/all.
  source: z.enum(['fot', 'local', 'all']).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

type Row = typeof responsiblePersons.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Сериализует создание/правку МОЛ с одним ФИО: проверка «такой уже есть» и
 * запись идут под одной advisory-блокировкой, иначе два одновременных POST
 * заводят две ручные записи. Ключ — ФИО в нижнем регистре без крайних
 * пробелов (toLowerCase в JS кириллицу понимает всегда, поэтому одинаковые
 * ФИО в разном регистре берут одну блокировку).
 *
 * Уникального индекса по ФИО нет намеренно: архивная ФОТ-запись и новая
 * ручная с тем же ФИО обязаны уживаться (человек выпал из ФОТ, а принимать
 * материал продолжает). Инвариант «не больше одного активного МОЛ с ФИО»
 * держат POST и PATCH этого файла; синк ФОТ вставляет только ФОТ-записи.
 */
async function lockMolName(tx: Tx, fullName: string): Promise<void> {
  const key = `responsible_person:${fullName.trim().toLowerCase()}`;
  await tx.execute(drSql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

/** Все записи с тем же ФИО; сравнение — в SQL с lower() с обеих сторон. */
async function findSameName(tx: Tx, fullName: string, exceptId?: string): Promise<Row[]> {
  const sameName = drSql`lower(btrim(${responsiblePersons.fullName})) = lower(btrim(${fullName}))`;
  return tx
    .select()
    .from(responsiblePersons)
    .where(exceptId ? and(sameName, drSql`${responsiblePersons.id} <> ${exceptId}`) : sameName);
}

function row(r: Row) {
  return {
    id: r.id,
    fullName: r.fullName,
    phone: r.phone,
    position: r.position,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function responsiblePersonRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  app.get(
    '/api/v1/responsible-persons',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp', 'monitor')],
      schema: {
        querystring: ListQuerySchema,
        response: { 200: ResponsiblePersonListResponseSchema },
      },
    },
    async (req) => {
      const { q, activeOnly, source, limit, offset } = req.query;
      const filters = [];
      if (q) filters.push(ilike(responsiblePersons.fullName, `%${escapeLike(q)}%`));
      if (activeOnly) filters.push(eq(responsiblePersons.isActive, true));
      if (source === 'fot') filters.push(isNotNull(responsiblePersons.fotEmployeeId));
      else if (source === 'local') filters.push(isNull(responsiblePersons.fotEmployeeId));
      const where = filters.length ? and(...filters) : undefined;

      const rows = await app.db
        .select()
        .from(responsiblePersons)
        .where(where)
        .orderBy(responsiblePersons.fullName)
        .limit(limit)
        .offset(offset);
      const [{ count } = { count: 0 }] = await app.db
        .select({ count: drSql<number>`count(*)::int` })
        .from(responsiblePersons)
        .where(where);
      return { items: rows.map(row), total: count };
    },
  );

  app.post(
    '/api/v1/responsible-persons',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        body: ResponsiblePersonUpsertSchema,
        // 201 created  — заведена новая ручная запись.
        // 200 existing — активный МОЛ с таким ФИО уже есть (ФОТ или ручной).
        // 409 mol_archived — ручная запись с таким ФИО в архиве.
        response: {
          200: ResponsiblePersonCreateResponseSchema,
          201: ResponsiblePersonCreateResponseSchema,
          409: ResponsiblePersonConflictSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      // POST никогда не меняет существующие записи: право «создавать» не даёт
      // правки. Вернуть запись из архива — PATCH, у него своё право «edit».
      // Новая запись всегда активна (isActive из тела не берём): в архив МОЛ
      // уводит правка, а не создание.
      const result = await app.db.transaction(async (tx) => {
        await lockMolName(tx, body.fullName);
        const same = await findSameName(tx, body.fullName);
        const active = same.find((r) => r.isActive);
        if (active) return { kind: 'existing' as const, rec: active };
        // Архивная ФОТ-запись создание не блокирует: человек выпал из ФОТ,
        // а материал принимать продолжает — заводим ручную рядом.
        const archivedLocal = same.find((r) => !r.isActive && r.fotEmployeeId == null);
        if (archivedLocal) return { kind: 'archived' as const, rec: archivedLocal };
        const [created] = await tx
          .insert(responsiblePersons)
          .values({
            fullName: body.fullName,
            position: body.position ?? null,
            phone: body.phone ?? null,
            isActive: true,
          })
          .returning();
        if (!created) throw new Error('insert failed');
        return { kind: 'created' as const, rec: created };
      });

      if (result.kind === 'archived') {
        return reply.code(409).send({
          error: 'mol_archived' as const,
          message: `«${result.rec.fullName}» есть в справочнике, но в архиве`,
          existing: row(result.rec),
        });
      }
      if (result.kind === 'created') {
        reply.code(201);
        return { ...row(result.rec), outcome: 'created' as const };
      }
      return { ...row(result.rec), outcome: 'existing' as const };
    },
  );

  // Массовый импорт МОЛ из .xlsx. Колонки: ФИО (обязательная), Должность,
  // Телефон. Заголовки в первой строке, регистр и язык не важны. Дубликаты
  // по нормализованному ФИО (lower+trim) пропускаются — и относительно БД,
  // и внутри файла. Битые строки попадают в errors с номером строки Excel,
  // остальные вставляются одной транзакцией.
  app.post(
    '/api/v1/responsible-persons/import',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
    },
    async (req, reply) => {
      const mp = req as unknown as {
        file: () => Promise<
          | {
              filename: string;
              mimetype: string;
              toBuffer: () => Promise<Buffer>;
            }
          | undefined
        >;
      };
      const fileData = await mp.file();
      if (!fileData) {
        return reply.code(400).send({ error: 'no_file', message: 'Файл не приложен' });
      }
      const lower = fileData.filename.toLowerCase();
      const isXlsx =
        fileData.mimetype.includes('spreadsheetml') ||
        fileData.mimetype.includes('excel') ||
        lower.endsWith('.xlsx') ||
        lower.endsWith('.xls');
      if (!isXlsx) {
        return reply.code(400).send({ error: 'bad_mime', message: 'Ожидается .xlsx файл' });
      }

      const buffer = await fileData.toBuffer();
      if (buffer.length === 0) {
        return reply.code(400).send({ error: 'empty_file', message: 'Файл пустой' });
      }

      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(buffer as unknown as ArrayBuffer);
      } catch (err) {
        req.log.warn({ err }, 'responsible-persons import: xlsx parse failed');
        return reply.code(400).send({ error: 'bad_xlsx', message: 'Не удалось прочитать xlsx' });
      }

      const ws = wb.worksheets[0];
      if (!ws) {
        return reply.code(400).send({ error: 'no_sheet', message: 'В файле нет листов' });
      }

      const headerRow = ws.getRow(1);
      const aliases: Record<string, 'fullName' | 'position' | 'phone'> = {
        фио: 'fullName',
        fio: 'fullName',
        fullname: 'fullName',
        'ф.и.о.': 'fullName',
        'ф.и.о': 'fullName',
        должность: 'position',
        position: 'position',
        телефон: 'phone',
        phone: 'phone',
        тел: 'phone',
      };
      const colIdx: Partial<Record<'fullName' | 'position' | 'phone', number>> = {};
      headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        const key = String(cell.text ?? '').trim().toLowerCase();
        const field = aliases[key];
        if (field && colIdx[field] == null) colIdx[field] = colNumber;
      });
      if (colIdx.fullName == null) {
        return reply.code(400).send({
          error: 'fio_column_not_found',
          message: 'Не найдена колонка ФИО в первой строке',
        });
      }

      const existing = await app.db
        .select({ fullName: responsiblePersons.fullName })
        .from(responsiblePersons);
      const seen = new Set<string>(existing.map((r) => r.fullName.trim().toLowerCase()));

      const toInsert: { fullName: string; position: string | null; phone: string | null }[] = [];
      const errors: { row: number; reason: string }[] = [];
      let skippedDuplicates = 0;

      const lastRow = ws.actualRowCount;
      for (let r = 2; r <= lastRow; r += 1) {
        const excelRow = ws.getRow(r);
        const readCell = (idx: number | undefined): string | undefined => {
          if (idx == null) return undefined;
          const t = String(excelRow.getCell(idx).text ?? '').trim();
          return t.length === 0 ? undefined : t;
        };
        const fullName = readCell(colIdx.fullName);
        const position = readCell(colIdx.position);
        const phone = readCell(colIdx.phone);

        // Полностью пустая строка — пропускаем молча, без записи в errors.
        if (fullName == null && position == null && phone == null) continue;

        const parsed = ResponsiblePersonUpsertSchema.safeParse({ fullName, position, phone });
        if (!parsed.success) {
          errors.push({
            row: r,
            reason: parsed.error.issues
              .map((i) => `${i.path.join('.') || 'строка'}: ${i.message}`)
              .join('; '),
          });
          continue;
        }

        const key = parsed.data.fullName.trim().toLowerCase();
        if (seen.has(key)) {
          skippedDuplicates += 1;
          continue;
        }
        seen.add(key);
        toInsert.push({
          fullName: parsed.data.fullName,
          position: parsed.data.position ?? null,
          phone: parsed.data.phone ?? null,
        });
      }

      if (toInsert.length > 0) {
        await app.db.transaction(async (tx) => {
          await tx.insert(responsiblePersons).values(toInsert);
        });
      }

      const body = {
        created: toInsert.length,
        skippedDuplicates,
        errors,
      };
      return ResponsiblePersonImportResponseSchema.parse(body);
    },
  );

  app.patch(
    '/api/v1/responsible-persons/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: ResponsiblePersonUpsertSchema.partial(),
        response: {
          200: ResponsiblePersonSchema,
          404: ErrorResponseSchema,
          // fot_readonly — ErrorResponse; mol_name_taken — с записью-тёзкой.
          409: z.union([ResponsiblePersonConflictSchema, ErrorResponseSchema]),
        },
      },
    },
    async (req, reply) => {
      const id = req.params.id;
      const result = await app.db.transaction(async (tx) => {
        // Порядок блокировок: строка, затем ФИО. POST строк не блокирует,
        // поэтому цикла ожидания нет.
        const [current] = await tx
          .select()
          .from(responsiblePersons)
          .where(eq(responsiblePersons.id, id))
          .for('update');
        if (!current) return { kind: 'not_found' as const };
        // Запись из ФОТ редактируется на стороне ФОТ-БД, не в MATCHECK.
        // Иначе sync на следующем тике затрёт ручные правки.
        if (current.fotEmployeeId != null) return { kind: 'fot_readonly' as const };

        // Активной запись останется или станет (возврат из архива, смена ФИО) —
        // второго активного МОЛ с тем же ФИО быть не должно.
        const nextName = req.body.fullName ?? current.fullName;
        const nextActive = req.body.isActive ?? current.isActive;
        if (nextActive) {
          await lockMolName(tx, nextName);
          const clash = (await findSameName(tx, nextName, id)).find((r) => r.isActive);
          if (clash) return { kind: 'name_taken' as const, clash };
        }
        const [updated] = await tx
          .update(responsiblePersons)
          .set({ ...req.body, updatedAt: new Date() })
          .where(eq(responsiblePersons.id, id))
          .returning();
        if (!updated) throw new Error('update failed');
        return { kind: 'ok' as const, updated };
      });

      if (result.kind === 'not_found') return reply.code(404).send({ error: 'not_found' });
      if (result.kind === 'fot_readonly') {
        return reply.code(409).send({
          error: 'fot_readonly',
          message: 'МОЛ из ФОТ нельзя редактировать в MATCHECK',
        });
      }
      if (result.kind === 'name_taken') {
        return reply.code(409).send({
          error: 'mol_name_taken' as const,
          message: `Активный МОЛ «${result.clash.fullName}» уже есть в справочнике`,
          existing: row(result.clash),
        });
      }
      return row(result.updated);
    },
  );

  app.delete(
    '/api/v1/responsible-persons/:id',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      // ФОТ-записи не удаляются вручную — увольнение проходит через ФОТ,
      // sync проставит isActive=false.
      if (await isFotResponsiblePerson(app.db, req.params.id)) {
        return reply.code(409).send({
          error: 'fot_readonly',
          message: 'МОЛ из ФОТ нельзя удалить в MATCHECK',
        });
      }
      // Hard-delete + запись в журнал hard-delete, чтобы офлайн-клиенты
      // удалили локальную копию через /sync.deletedIds.responsiblePersons.
      // siteId=null — это глобальный справочник, не привязан к объекту.
      const result = await app.db.transaction(async (tx) => {
        const deleted = await tx
          .delete(responsiblePersons)
          .where(eq(responsiblePersons.id, req.params.id))
          .returning({ id: responsiblePersons.id });
        if (deleted.length === 0) return null;
        await tx.insert(entityDeletions).values({
          entityType: 'responsible_person',
          entityId: req.params.id,
          siteId: null,
          deletedByUserId: req.user?.id ?? null,
        });
        return deleted[0];
      });
      if (!result) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  // Массовое удаление МОЛов. Hard-delete + запись каждого удалённого
  // в entity_deletions (та же таблица, что для одиночного DELETE), чтобы
  // offline-клиенты узнали об удалении через /sync.deletedIds.
  // FK от source_documents.recipient_mol_id и других — все SET NULL,
  // удаление не блокируется ничем.
  app.post(
    '/api/v1/responsible-persons/bulk-delete',
    {
      preHandler: [app.authenticate, app.authorize('admin')],
      schema: {
        body: BulkDeleteRequestSchema,
        response: { 200: BulkDeleteResponseSchema },
      },
    },
    async (req) => {
      const requested = req.body.ids;
      // ФОТ-id-шники в запросе игнорируем (помечаем как skipped с причиной
      // fot_readonly). Их sync-логика обновляет сама.
      const fotIds = await filterFotResponsiblePersonIds(app.db, requested);
      const fotSet = new Set(fotIds);
      const ids = requested.filter((id) => !fotSet.has(id));
      const result = await app.db.transaction(async (tx) => {
        if (ids.length === 0) return [] as string[];
        const deleted = await tx
          .delete(responsiblePersons)
          .where(inArray(responsiblePersons.id, ids))
          .returning({ id: responsiblePersons.id });
        if (deleted.length > 0) {
          await tx.insert(entityDeletions).values(
            deleted.map((d) => ({
              entityType: 'responsible_person' as const,
              entityId: d.id,
              siteId: null,
              deletedByUserId: req.user?.id ?? null,
            })),
          );
        }
        return deleted.map((d) => d.id);
      });
      const deletedSet = new Set(result);
      const skipped = [
        // ФОТ-id-шники, которые мы заведомо не трогали.
        ...fotIds.map((id) => ({ id, reason: 'system_readonly' as const })),
        // Локальные id, которые не нашлись в таблице на момент DELETE.
        ...ids
          .filter((id) => !deletedSet.has(id))
          .map((id) => ({ id, reason: 'not_found' as const })),
      ];
      return { deleted: result, skipped };
    },
  );
}
