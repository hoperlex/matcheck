import type { FastifyInstance } from 'fastify';
import { and, eq, ilike, inArray, isNotNull, isNull, sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { asZod } from '../lib/fastify.js';
import {
  BulkDeleteRequestSchema,
  BulkDeleteResponseSchema,
  ResponsiblePersonImportResponseSchema,
  ResponsiblePersonListResponseSchema,
  ResponsiblePersonSchema,
  ResponsiblePersonUpsertSchema,
  ErrorResponseSchema,
} from '@matcheck/contracts';
import { entityDeletions, responsiblePersons } from '../db/schema.js';
import {
  filterFotResponsiblePersonIds,
  isFotResponsiblePerson,
} from '../domain/mol/syncFotMol.js';

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

function row(r: typeof responsiblePersons.$inferSelect) {
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
      preHandler: [app.authenticate, app.authorize('admin', 'manager', 'inspector_kpp')],
      schema: {
        querystring: ListQuerySchema,
        response: { 200: ResponsiblePersonListResponseSchema },
      },
    },
    async (req) => {
      const { q, activeOnly, source, limit, offset } = req.query;
      const filters = [];
      if (q) filters.push(ilike(responsiblePersons.fullName, `%${q}%`));
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
        // 200 — найден существующий по lower(full_name) (дедуп сработал).
        // 201 — создан новый.
        response: {
          200: ResponsiblePersonSchema,
          201: ResponsiblePersonSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const trimmedName = body.fullName.trim();
      const lname = trimmedName.toLowerCase();
      // Дедуп по lower(full_name) — для МОЛ aliases не делаем (ФИО более
      // уникально, обычно нет коротких форм).
      const [existing] = await app.db
        .select()
        .from(responsiblePersons)
        .where(drSql`lower(${responsiblePersons.fullName}) = ${lname}`)
        .limit(1);
      if (existing) return row(existing);

      const [created] = await app.db.insert(responsiblePersons).values(body).returning();
      if (!created) throw new Error('insert failed');
      reply.code(201);
      return row(created);
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
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      // Запись из ФОТ редактируется на стороне ФОТ-БД, не в MATCHECK.
      // Иначе sync на следующем тике затрёт ручные правки.
      if (await isFotResponsiblePerson(app.db, req.params.id)) {
        return reply.code(409).send({
          error: 'fot_readonly',
          message: 'МОЛ из ФОТ нельзя редактировать в MATCHECK',
        });
      }
      const [updated] = await app.db
        .update(responsiblePersons)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(responsiblePersons.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'not_found' });
      return row(updated);
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
