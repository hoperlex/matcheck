import type { FastifyInstance } from 'fastify';
import { sql as drSql } from 'drizzle-orm';
import { z } from 'zod';
import { asZod } from '../lib/fastify.js';
import {
  InspectorStatsResponseSchema,
  IntakeJournalResponseSchema,
  OperationsCountersResponseSchema,
  ShipmentJournalResponseSchema,
  ShipmentKindSchema,
  StatsSummaryResponseSchema,
  StockBalanceResponseSchema,
} from '@matcheck/contracts';

const StockQuerySchema = z.object({
  materialId: z.string().uuid().optional(),
  // Подрядчик(и) — CSV вида `uuid1,uuid2`. Для остатков фильтруем И приёмки
  // (deliveries.contractor_id), И отгрузки (shipments.receiver_counterparty_id) —
  // показываем «движение в пределах этих подрядчиков».
  contractorId: z.string().optional(),
  // Объект(ы) — CSV. Пустая строка / undefined = «все».
  siteId: z.string().optional(),
  q: z.string().optional(),
  date: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const IntakeQuerySchema = z.object({
  siteId: z.string().optional(),
  contractorId: z.string().optional(),
  q: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const ShipmentJournalQuerySchema = z.object({
  siteId: z.string().optional(),
  kind: ShipmentKindSchema.optional(),
  contractorId: z.string().optional(),
  q: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const InspectorStatsQuerySchema = z.object({
  siteId: z.string().optional(),
  inspectorId: z.string().optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(500).default(500),
  offset: z.coerce.number().int().nonnegative().default(0),
});

// Дашборд /stats — KPI + динамика + «требует внимания» одним запросом.
// from/to — YYYY-MM-DD в МСК. Если не заданы — default 30 дней до сегодня.
// siteIds/inspectorIds — CSV (как везде в этом файле).
const StatsSummaryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  siteIds: z.string().optional(),
  inspectorIds: z.string().optional(),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function safeDate(v: string | undefined): string | null {
  return v && DATE_RE.test(v) ? v : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHIPMENT_KIND_RE = /^(contractor|return|transfer|writeoff)$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function safeUuid(v: string | undefined): string | null {
  return v && UUID_RE.test(v) ? v : null;
}

// Парсит CSV вида `uuid1,uuid2,uuid3` в массив валидированных UUID-строк.
// Невалидные элементы отбрасываются молча — defensive, чтобы кривой URL
// не уронил весь запрос. Пустая строка / undefined → [].
function safeUuids(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter((x) => UUID_RE.test(x));
}

// Собирает SQL-фрагмент `col IN ('uuid1'::uuid, 'uuid2'::uuid, ...)`.
// Все uuid уже прошли через safeUuids — экранирование не нужно.
function uuidInClause(col: string, ids: string[]): string {
  return `${col} IN (${ids.map((id) => `'${id}'::uuid`).join(',')})`;
}

function safeTimestamp(v: string | undefined): string | null {
  return v && ISO_TS_RE.test(v) ? v : null;
}

function safeKind(v: string | undefined): string | null {
  return v && SHIPMENT_KIND_RE.test(v) ? v : null;
}

function escapeLike(q: string): string {
  return q.replace(/'/g, "''").replace(/\\/g, '\\\\');
}

function maybeDateIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function maybeDocDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execRows(app: any, sqlText: string): Promise<Record<string, unknown>[]> {
  const res = await app.db.execute(drSql.raw(sqlText));
  return (res as { rows?: Record<string, unknown>[] }).rows ?? (res as Record<string, unknown>[]);
}

export async function reportRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = asZod(rawApp);

  // ─── Остатки на сейчас или на дату («На объекте») ──────────────────────
  app.get(
    '/api/v1/reports/stock',
    {
      preHandler: [app.authenticate],
      schema: { querystring: StockQuerySchema, response: { 200: StockBalanceResponseSchema } },
    },
    async (req) => {
      const { siteId, materialId, contractorId, q, date, limit, offset } = req.query;
      const sIds = safeUuids(siteId);
      const mId = safeUuid(materialId);
      const cIds = safeUuids(contractorId);
      const dateTs = safeTimestamp(date);

      // qty_in/qty_out агрегируем напрямую из deliveries/shipments, чтобы
      // подтянуть подрядчиков (string_agg) и сумму приёмок (Σ qty × price).
      // dateFilterDelivery/Shipment — необязательный фильтр по дате среза.
      const dateFilterDelivery = dateTs
        ? `AND COALESCE(d.arrived_at, d.updated_at) <= '${dateTs}'::timestamptz`
        : '';
      const dateFilterShipment = dateTs
        ? `AND COALESCE(s.shipped_at, s.updated_at) <= '${dateTs}'::timestamptz`
        : '';
      // Фильтр подрядчика(ов) — IN (...) если выбрано несколько.
      const contractorFilterDelivery = cIds.length
        ? `AND ${uuidInClause('d.contractor_id', cIds)}`
        : '';
      const contractorFilterShipment = cIds.length
        ? `AND ${uuidInClause('s.receiver_counterparty_id', cIds)}`
        : '';

      const filters: string[] = [];
      if (sIds.length) filters.push(uuidInClause('b.site_id', sIds));
      if (mId) filters.push(`b.material_id = '${mId}'::uuid`);
      if (q) {
        const safeQ = escapeLike(q);
        filters.push(
          `(COALESCE(m.name, '') ILIKE '%${safeQ}%' OR COALESCE(m.code, '') ILIKE '%${safeQ}%' OR COALESCE(b.name_raw, '') ILIKE '%${safeQ}%')`,
        );
      }
      const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

      // Ключ группировки: если позиция привязана к справочнику material —
      // группируем по material_id; иначе — по сырому тексту di.name_raw.
      // Это позволяет ввести в баланс позиции, заведённые инспектором руками
      // или распознанные LLM без последующей линковки в справочник.
      // Префикс 'name:' гарантирует, что текст-ключ никогда не совпадёт
      // с uuid материала.
      const groupKeyDelivery = `COALESCE(di.material_id::text, 'name:' || di.name_raw)`;
      const groupKeyShipment = `COALESCE(si.material_id::text, 'name:' || si.name_raw)`;

      // Приёмки в разрезе (site × group_key × unit). Контрагентов собираем
      // в string_agg, сумму считаем как Σ qty × price (NULL → 0 в произведении,
      // но если у всех NULL — финальная sum = NULL, отдаём как «—» на фронте).
      // Pending_deletion_at IS NULL — приёмки, помеченные на удаление, в баланс
      // не должны входить (правка-баг: раньше учитывались).
      const intakesCte = `
        intakes AS (
          SELECT
            d.site_id,
            ${groupKeyDelivery} AS group_key,
            MAX(di.material_id::text)::uuid AS material_id,
            MAX(di.name_raw)    AS name_raw,
            di.unit,
            SUM(COALESCE(di.qty_actual, di.qty_planned))::numeric(18,4) AS qty_in,
            CASE
              WHEN bool_or(di.price IS NOT NULL)
              THEN SUM(COALESCE(di.qty_actual, di.qty_planned) * COALESCE(di.price, 0))::numeric(18,2)
              ELSE NULL
            END AS sum_in,
            NULLIF(string_agg(DISTINCT con.name, ', ' ORDER BY con.name), '') AS contractor_names
          FROM delivery_items di
          JOIN deliveries d ON d.id = di.delivery_id
          JOIN statuses st  ON st.id = d.status_id
          LEFT JOIN counterparties con ON con.id = d.contractor_id
          WHERE st.entity_type = 'delivery'
            AND st.code IN ('filled','confirmed_mol')
            AND d.pending_deletion_at IS NULL
            AND COALESCE(di.qty_actual, di.qty_planned) IS NOT NULL
            ${dateFilterDelivery}
            ${contractorFilterDelivery}
          GROUP BY d.site_id, ${groupKeyDelivery}, di.unit
        )
      `;

      // Отгрузки и приходы-перемещения собираем в один кортеж, чтобы получить
      // qty_out и qty_in_transfer по site × group_key × unit.
      const movementsCte = `
        out_aggs AS (
          SELECT
            s.site_id,
            ${groupKeyShipment} AS group_key,
            MAX(si.material_id::text)::uuid AS material_id,
            MAX(si.name_raw)    AS name_raw,
            si.unit,
            SUM(COALESCE(si.qty_actual, si.qty_planned))::numeric(18,4) AS qty_out
          FROM shipment_items si
          JOIN shipments s  ON s.id = si.shipment_id
          JOIN statuses st  ON st.id = s.status_id
          WHERE st.entity_type = 'shipment'
            AND st.code IN ('shipped','confirmed_mol')
            AND s.pending_deletion_at IS NULL
            AND COALESCE(si.qty_actual, si.qty_planned) IS NOT NULL
            ${dateFilterShipment}
            ${contractorFilterShipment}
          GROUP BY s.site_id, ${groupKeyShipment}, si.unit
        ),
        in_transfer AS (
          SELECT
            s.dest_site_id AS site_id,
            ${groupKeyShipment} AS group_key,
            MAX(si.material_id::text)::uuid AS material_id,
            MAX(si.name_raw)    AS name_raw,
            si.unit,
            SUM(COALESCE(si.qty_actual, si.qty_planned))::numeric(18,4) AS qty_transfer_in
          FROM shipment_items si
          JOIN shipments s  ON s.id = si.shipment_id
          JOIN statuses st  ON st.id = s.status_id
          WHERE st.entity_type = 'shipment'
            AND st.code IN ('shipped','confirmed_mol')
            AND s.pending_deletion_at IS NULL
            AND s.kind = 'transfer'
            AND s.dest_site_id IS NOT NULL
            AND COALESCE(si.qty_actual, si.qty_planned) IS NOT NULL
            ${dateFilterShipment}
          GROUP BY s.dest_site_id, ${groupKeyShipment}, si.unit
        )
      `;

      // bal — финальный агрегат: intakes + in_transfer слева, out_aggs справа.
      // Включаем строки, у которых есть хоть какое-то движение (FULL OUTER JOIN).
      const balCte = `
        bal AS (
          SELECT
            COALESCE(i.site_id, o.site_id, t.site_id)        AS site_id,
            COALESCE(i.material_id, o.material_id, t.material_id) AS material_id,
            COALESCE(i.name_raw, o.name_raw, t.name_raw)     AS name_raw,
            COALESCE(i.unit, o.unit, t.unit)                 AS unit,
            COALESCE(i.qty_in, 0)::numeric(18,4)
              + COALESCE(t.qty_transfer_in, 0)::numeric(18,4) AS qty_in,
            COALESCE(o.qty_out, 0)::numeric(18,4)            AS qty_out,
            (COALESCE(i.qty_in, 0) + COALESCE(t.qty_transfer_in, 0) - COALESCE(o.qty_out, 0))::numeric(18,4)
                                                              AS balance,
            i.sum_in,
            i.contractor_names
          FROM intakes i
          FULL OUTER JOIN out_aggs o
            ON o.site_id = i.site_id AND o.group_key = i.group_key AND o.unit = i.unit
          FULL OUTER JOIN in_transfer t
            ON t.site_id = COALESCE(i.site_id, o.site_id)
            AND t.group_key = COALESCE(i.group_key, o.group_key)
            AND t.unit = COALESCE(i.unit, o.unit)
          WHERE (COALESCE(i.qty_in, 0) + COALESCE(t.qty_transfer_in, 0) - COALESCE(o.qty_out, 0)) <> 0
        )
      `;

      const ctes = `WITH ${intakesCte}, ${movementsCte}, ${balCte}`;

      const rows = await execRows(
        app,
        `
        ${ctes}
        SELECT
          b.material_id AS "materialId",
          COALESCE(m.name, b.name_raw, '— без материала —') AS "materialName",
          b.site_id   AS "siteId",
          si.code     AS "siteCode",
          si.name     AS "siteName",
          b.unit      AS "unit",
          b.qty_in::text  AS "qtyIn",
          b.qty_out::text AS "qtyOut",
          b.balance::text AS "balance",
          b.contractor_names AS "contractorName",
          b.sum_in::text  AS "sum"
        FROM bal b
        LEFT JOIN materials m ON m.id = b.material_id
        JOIN sites si        ON si.id = b.site_id
        ${whereSql}
        ORDER BY si.code, COALESCE(m.name, b.name_raw, '— без материала —')
        LIMIT ${limit} OFFSET ${offset}
        `,
      );

      const totalRows = await execRows(
        app,
        `
        ${ctes}
        SELECT count(*)::int AS count
        FROM bal b
        LEFT JOIN materials m ON m.id = b.material_id
        JOIN sites si        ON si.id = b.site_id
        ${whereSql}
        `,
      );

      return {
        items: rows.map((r) => ({
          materialId: (r.materialId as string | null) ?? null,
          materialName: String(r.materialName),
          siteId: String(r.siteId),
          siteCode: String(r.siteCode),
          siteName: String(r.siteName),
          unit: String(r.unit),
          qtyIn: String(r.qtyIn ?? '0'),
          qtyOut: String(r.qtyOut ?? '0'),
          balance: String(r.balance ?? '0'),
          contractorName: (r.contractorName as string | null) ?? null,
          sum: r.sum === null || r.sum === undefined ? null : String(r.sum),
        })),
        total: Number(totalRows[0]?.count ?? 0),
      };
    },
  );

  // ─── Журнал «Поступление» ──────────────────────────────────────────────
  app.get(
    '/api/v1/reports/intake',
    {
      preHandler: [app.authenticate],
      schema: { querystring: IntakeQuerySchema, response: { 200: IntakeJournalResponseSchema } },
    },
    async (req) => {
      const { siteId, contractorId, q, dateFrom, dateTo, limit, offset } = req.query;
      const sIds = safeUuids(siteId);
      const cIds = safeUuids(contractorId);
      const from = safeTimestamp(dateFrom);
      const to = safeTimestamp(dateTo);

      const where: string[] = [
        `st.entity_type = 'delivery'`,
        `st.code IN ('filled', 'confirmed_mol')`,
      ];
      if (sIds.length) where.push(uuidInClause('d.site_id', sIds));
      if (cIds.length) where.push(uuidInClause('d.contractor_id', cIds));
      if (from) where.push(`COALESCE(d.arrived_at, d.updated_at) >= '${from}'::timestamptz`);
      if (to) where.push(`COALESCE(d.arrived_at, d.updated_at) <= '${to}'::timestamptz`);
      if (q) {
        const safe = escapeLike(q);
        where.push(
          `(di.name_raw ILIKE '%${safe}%' OR COALESCE(m.name, '') ILIKE '%${safe}%' OR COALESCE(sup.name, '') ILIKE '%${safe}%')`,
        );
      }
      const whereSql = where.join(' AND ');

      const rows = await execRows(
        app,
        `
        SELECT
          di.id AS "itemId",
          d.id AS "deliveryId",
          d.arrived_at AS "arrivedAt",
          d.site_id AS "siteId",
          si.code AS "siteCode",
          si.name AS "siteName",
          di.material_id AS "materialId",
          COALESCE(m.name, di.name_raw) AS "materialName",
          COALESCE(di.qty_actual, di.qty_planned)::text AS "qty",
          di.unit AS "unit",
          di.price::text AS "price",
          di.vat_sum::text AS "vatSum",
          CASE
            WHEN di.price IS NULL THEN NULL
            ELSE (COALESCE(di.qty_actual, di.qty_planned) * di.price)::numeric(18,2)::text
          END AS "sum",
          d.supplier_id AS "supplierId",
          sup.name AS "supplierName",
          d.contractor_id AS "contractorId",
          con.name AS "contractorName",
          sd.doc_number AS "docNumber",
          sd.doc_date AS "docDate",
          st.code AS "statusCode",
          st.label AS "statusLabel"
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN statuses st ON st.id = d.status_id
        JOIN sites si ON si.id = d.site_id
        LEFT JOIN materials m ON m.id = di.material_id
        LEFT JOIN counterparties sup ON sup.id = d.supplier_id
        LEFT JOIN counterparties con ON con.id = d.contractor_id
        LEFT JOIN LATERAL (
          SELECT sdoc.doc_number, sdoc.doc_date
          FROM delivery_sources ds
          JOIN source_documents sdoc ON sdoc.id = ds.source_document_id
          WHERE ds.delivery_id = d.id
          ORDER BY sdoc.doc_date DESC NULLS LAST
          LIMIT 1
        ) sd ON true
        WHERE ${whereSql}
        ORDER BY COALESCE(d.arrived_at, d.updated_at) DESC, di.line_no
        LIMIT ${limit} OFFSET ${offset}
        `,
      );

      const totalRows = await execRows(
        app,
        `
        SELECT count(*)::int AS count
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN statuses st ON st.id = d.status_id
        LEFT JOIN materials m ON m.id = di.material_id
        LEFT JOIN counterparties sup ON sup.id = d.supplier_id
        WHERE ${whereSql}
        `,
      );

      return {
        items: rows.map((r) => ({
          itemId: String(r.itemId),
          deliveryId: String(r.deliveryId),
          arrivedAt: maybeDateIso(r.arrivedAt),
          siteId: String(r.siteId),
          siteCode: String(r.siteCode),
          siteName: String(r.siteName),
          materialId: (r.materialId as string | null) ?? null,
          materialName: String(r.materialName),
          qty: r.qty === null || r.qty === undefined ? null : String(r.qty),
          unit: String(r.unit),
          price: r.price === null || r.price === undefined ? null : String(r.price),
          vatSum: r.vatSum === null || r.vatSum === undefined ? null : String(r.vatSum),
          sum: r.sum === null || r.sum === undefined ? null : String(r.sum),
          supplierId: (r.supplierId as string | null) ?? null,
          supplierName: (r.supplierName as string | null) ?? null,
          contractorId: (r.contractorId as string | null) ?? null,
          contractorName: (r.contractorName as string | null) ?? null,
          docNumber: (r.docNumber as string | null) ?? null,
          docDate: maybeDocDate(r.docDate),
          statusCode: String(r.statusCode),
          statusLabel: String(r.statusLabel),
        })),
        total: Number(totalRows[0]?.count ?? 0),
      };
    },
  );

  // ─── Журнал «Отгрузка» ─────────────────────────────────────────────────
  app.get(
    '/api/v1/reports/shipment',
    {
      preHandler: [app.authenticate],
      schema: {
        querystring: ShipmentJournalQuerySchema,
        response: { 200: ShipmentJournalResponseSchema },
      },
    },
    async (req) => {
      const { siteId, kind, contractorId, q, dateFrom, dateTo, limit, offset } = req.query;
      const sIds = safeUuids(siteId);
      const k = safeKind(kind);
      const cIds = safeUuids(contractorId);
      const from = safeTimestamp(dateFrom);
      const to = safeTimestamp(dateTo);

      const where: string[] = [
        `st.entity_type = 'shipment'`,
        `st.code IN ('shipped', 'confirmed_mol')`,
      ];
      if (sIds.length) where.push(uuidInClause('s.site_id', sIds));
      if (k) where.push(`s.kind = '${k}'::shipment_kind`);
      if (cIds.length) where.push(uuidInClause('s.receiver_counterparty_id', cIds));
      if (from) where.push(`COALESCE(s.shipped_at, s.updated_at) >= '${from}'::timestamptz`);
      if (to) where.push(`COALESCE(s.shipped_at, s.updated_at) <= '${to}'::timestamptz`);
      if (q) {
        const safe = escapeLike(q);
        where.push(
          `(si2.name_raw ILIKE '%${safe}%' OR COALESCE(m.name, '') ILIKE '%${safe}%' OR COALESCE(rc.name, '') ILIKE '%${safe}%')`,
        );
      }
      const whereSql = where.join(' AND ');

      const rows = await execRows(
        app,
        `
        SELECT
          si2.id AS "itemId",
          s.id AS "shipmentId",
          s.shipped_at AS "shippedAt",
          s.kind AS "kind",
          s.site_id AS "siteId",
          so.code AS "siteCode",
          so.name AS "siteName",
          s.dest_site_id AS "destSiteId",
          ds.name AS "destSiteName",
          s.receiver_counterparty_id AS "receiverCounterpartyId",
          rc.name AS "receiverName",
          si2.material_id AS "materialId",
          COALESCE(m.name, si2.name_raw) AS "materialName",
          COALESCE(si2.qty_actual, si2.qty_planned)::text AS "qty",
          si2.unit AS "unit",
          sd.doc_number AS "docNumber",
          sd.doc_date AS "docDate",
          st.code AS "statusCode",
          st.label AS "statusLabel"
        FROM shipment_items si2
        JOIN shipments s ON s.id = si2.shipment_id
        JOIN statuses st ON st.id = s.status_id
        JOIN sites so ON so.id = s.site_id
        LEFT JOIN sites ds ON ds.id = s.dest_site_id
        LEFT JOIN materials m ON m.id = si2.material_id
        LEFT JOIN counterparties rc ON rc.id = s.receiver_counterparty_id
        LEFT JOIN LATERAL (
          SELECT sdoc.doc_number, sdoc.doc_date
          FROM shipment_sources ss
          JOIN source_documents sdoc ON sdoc.id = ss.source_document_id
          WHERE ss.shipment_id = s.id
          ORDER BY sdoc.doc_date DESC NULLS LAST
          LIMIT 1
        ) sd ON true
        WHERE ${whereSql}
        ORDER BY COALESCE(s.shipped_at, s.updated_at) DESC, si2.line_no
        LIMIT ${limit} OFFSET ${offset}
        `,
      );

      const totalRows = await execRows(
        app,
        `
        SELECT count(*)::int AS count
        FROM shipment_items si2
        JOIN shipments s ON s.id = si2.shipment_id
        JOIN statuses st ON st.id = s.status_id
        LEFT JOIN materials m ON m.id = si2.material_id
        LEFT JOIN counterparties rc ON rc.id = s.receiver_counterparty_id
        WHERE ${whereSql}
        `,
      );

      return {
        items: rows.map((r) => ({
          itemId: String(r.itemId),
          shipmentId: String(r.shipmentId),
          shippedAt: maybeDateIso(r.shippedAt),
          kind: r.kind as 'contractor' | 'return' | 'transfer' | 'writeoff',
          siteId: String(r.siteId),
          siteCode: String(r.siteCode),
          siteName: String(r.siteName),
          destSiteId: (r.destSiteId as string | null) ?? null,
          destSiteName: (r.destSiteName as string | null) ?? null,
          receiverCounterpartyId: (r.receiverCounterpartyId as string | null) ?? null,
          receiverName: (r.receiverName as string | null) ?? null,
          materialId: (r.materialId as string | null) ?? null,
          materialName: String(r.materialName),
          qty: r.qty === null || r.qty === undefined ? null : String(r.qty),
          unit: String(r.unit),
          docNumber: (r.docNumber as string | null) ?? null,
          docDate: maybeDocDate(r.docDate),
          statusCode: String(r.statusCode),
          statusLabel: String(r.statusLabel),
        })),
        total: Number(totalRows[0]?.count ?? 0),
      };
    },
  );

  // ─── Статистика по инспекторам КПП ─────────────────────────────────────
  // Группировка: (день × инспектор × объект). «Машины» = COUNT приёмок +
  // отгрузок этого инспектора за день. «Сумма без НДС» = SUM(qty × price)
  // по delivery_items привязанных приёмок (формула совпадает с
  // /reports/intake — единая трактовка денег во всём портале). У shipments
  // цены обычно нет, для них сумму не считаем.
  app.get(
    '/api/v1/reports/inspector-stats',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        querystring: InspectorStatsQuerySchema,
        response: { 200: InspectorStatsResponseSchema },
      },
    },
    async (req) => {
      const { siteId, inspectorId, dateFrom, dateTo, limit, offset } = req.query;
      const sIds = safeUuids(siteId);
      const iIds = safeUuids(inspectorId);
      const from = safeTimestamp(dateFrom);
      const to = safeTimestamp(dateTo);

      // Дата операции — в МСК: бизнес-день у пользователя именно московский.
      // COALESCE на updated_at — fallback на случай если arrived_at/shipped_at
      // не проставлены (мобила могла пропустить).
      const dateExprD = `DATE(COALESCE(d.arrived_at, d.updated_at) AT TIME ZONE 'Europe/Moscow')`;
      const dateExprS = `DATE(COALESCE(s.shipped_at, s.updated_at) AT TIME ZONE 'Europe/Moscow')`;

      const whereD: string[] = [
        `st.entity_type = 'delivery'`,
        `st.code IN ('filled', 'confirmed_mol')`,
        `d.pending_deletion_at IS NULL`,
        `d.inspector_id IS NOT NULL`,
      ];
      const whereS: string[] = [
        `st.entity_type = 'shipment'`,
        `st.code IN ('shipped', 'confirmed_mol')`,
        `s.pending_deletion_at IS NULL`,
        `s.inspector_id IS NOT NULL`,
      ];
      if (sIds.length) {
        whereD.push(uuidInClause('d.site_id', sIds));
        whereS.push(uuidInClause('s.site_id', sIds));
      }
      if (iIds.length) {
        whereD.push(uuidInClause('d.inspector_id', iIds));
        whereS.push(uuidInClause('s.inspector_id', iIds));
      }
      if (from) {
        whereD.push(`COALESCE(d.arrived_at, d.updated_at) >= '${from}'::timestamptz`);
        whereS.push(`COALESCE(s.shipped_at, s.updated_at) >= '${from}'::timestamptz`);
      }
      if (to) {
        whereD.push(`COALESCE(d.arrived_at, d.updated_at) <= '${to}'::timestamptz`);
        whereS.push(`COALESCE(s.shipped_at, s.updated_at) <= '${to}'::timestamptz`);
      }
      const whereDSql = whereD.join(' AND ');
      const whereSSql = whereS.join(' AND ');

      const rows = await execRows(
        app,
        `
        WITH ops AS (
          SELECT
            ${dateExprD} AS op_date,
            d.inspector_id,
            d.site_id,
            d.id AS delivery_id,
            NULL::uuid AS shipment_id
          FROM deliveries d
          JOIN statuses st ON st.id = d.status_id
          WHERE ${whereDSql}

          UNION ALL

          SELECT
            ${dateExprS} AS op_date,
            s.inspector_id,
            s.site_id,
            NULL::uuid AS delivery_id,
            s.id AS shipment_id
          FROM shipments s
          JOIN statuses st ON st.id = s.status_id
          WHERE ${whereSSql}
        ),
        delivery_sums AS (
          SELECT
            di.delivery_id,
            SUM(COALESCE(di.qty_actual, di.qty_planned) * di.price)::numeric(18,2) AS sum_no_vat
          FROM delivery_items di
          WHERE di.price IS NOT NULL
          GROUP BY di.delivery_id
        )
        SELECT
          o.op_date::text AS "date",
          o.inspector_id AS "inspectorId",
          u.full_name AS "inspectorFullName",
          u.email AS "inspectorEmail",
          o.site_id AS "siteId",
          si.code AS "siteCode",
          si.name AS "siteName",
          -- Разбивка машин: FILTER (WHERE …) — нативный PG-синтаксис для
          -- условных счётчиков. Инвариант deliveries + shipments == vehicles
          -- держится автоматически: каждая строка ops имеет ровно один из
          -- id ненулевым по построению UNION в CTE.
          COUNT(*) FILTER (WHERE o.delivery_id IS NOT NULL)::int AS "deliveries",
          COUNT(*) FILTER (WHERE o.shipment_id IS NOT NULL)::int AS "shipments",
          COUNT(*)::int AS "vehicles",
          COALESCE(SUM(ds.sum_no_vat), 0)::numeric(18,2)::text AS "sumNoVat"
        FROM ops o
        LEFT JOIN delivery_sums ds ON ds.delivery_id = o.delivery_id
        LEFT JOIN users u ON u.id = o.inspector_id
        LEFT JOIN sites si ON si.id = o.site_id
        GROUP BY o.op_date, o.inspector_id, u.full_name, u.email, o.site_id, si.code, si.name
        ORDER BY o.op_date DESC, COALESCE(u.full_name, u.email)
        LIMIT ${limit} OFFSET ${offset}
        `,
      );

      const totalRows = await execRows(
        app,
        `
        WITH ops AS (
          SELECT ${dateExprD} AS op_date, d.inspector_id, d.site_id
          FROM deliveries d
          JOIN statuses st ON st.id = d.status_id
          WHERE ${whereDSql}
          UNION ALL
          SELECT ${dateExprS} AS op_date, s.inspector_id, s.site_id
          FROM shipments s
          JOIN statuses st ON st.id = s.status_id
          WHERE ${whereSSql}
        )
        SELECT COUNT(*)::int AS count FROM (
          SELECT op_date, inspector_id, site_id FROM ops
          GROUP BY op_date, inspector_id, site_id
        ) t
        `,
      );

      return {
        items: rows.map((r) => ({
          date: String(r.date),
          inspectorId: String(r.inspectorId),
          inspectorFullName: (r.inspectorFullName as string | null) ?? null,
          inspectorEmail: String(r.inspectorEmail),
          siteId: String(r.siteId),
          siteCode: String(r.siteCode),
          siteName: String(r.siteName),
          deliveries: Number(r.deliveries),
          shipments: Number(r.shipments),
          vehicles: Number(r.vehicles),
          sumNoVat: String(r.sumNoVat),
        })),
        total: Number(totalRows[0]?.count ?? 0),
      };
    },
  );

  // ─── Счётчики для шапки раздела «Операции» ─────────────────────────────
  //
  // completedToday = COUNT приёмок+отгрузок со status='confirmed_mol' и
  // confirmed_by_mol_at в сегодняшнем дне МСК.
  // inProgress = COUNT приёмок (status='filled') + отгрузок (status='shipped')
  // — 1 Этап есть, 2 Этап ещё нет.
  // Inspector_kpp видит только свой site_id (по аналогии с /deliveries
  // и /shipments); admin/manager — глобально.
  app.get(
    '/api/v1/reports/operations-counters',
    {
      preHandler: [app.authenticate],
      schema: { response: { 200: OperationsCountersResponseSchema } },
    },
    async (req) => {
      const inspectorSiteId =
        req.user?.role === 'inspector_kpp' ? safeUuid(req.user.siteId ?? undefined) : null;
      // Если inspector без назначенного site — возвращаем нули, чтобы не
      // светить чужие данные. Это edge-case: admin ещё не задал объект.
      if (req.user?.role === 'inspector_kpp' && !inspectorSiteId) {
        return { completedToday: 0, inProgressToday: 0, overdue: 0 };
      }
      const siteFilterD = inspectorSiteId
        ? `AND d.site_id = '${inspectorSiteId}'::uuid`
        : '';
      const siteFilterS = inspectorSiteId
        ? `AND s.site_id = '${inspectorSiteId}'::uuid`
        : '';

      // del/sh_progress (filled/shipped, без МОЛ) делим по дате arrived_at /
      // shipped_at: today = МСК-день совпадает с сегодняшним; overdue =
      // строго раньше. NULL-дата уходит в overdue (на всякий — давно
      // забытая запись без даты прибытия).
      const rows = await execRows(
        app,
        `
        WITH
          del_done AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            JOIN statuses st ON st.id = d.status_id
            WHERE st.entity_type = 'delivery' AND st.code = 'confirmed_mol'
              AND d.pending_deletion_at IS NULL
              AND d.confirmed_by_mol_at IS NOT NULL
              AND DATE(d.confirmed_by_mol_at AT TIME ZONE 'Europe/Moscow')
                = DATE(NOW() AT TIME ZONE 'Europe/Moscow')
              ${siteFilterD}
          ),
          sh_done AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            JOIN statuses st ON st.id = s.status_id
            WHERE st.entity_type = 'shipment' AND st.code = 'confirmed_mol'
              AND s.pending_deletion_at IS NULL
              AND s.confirmed_by_mol_at IS NOT NULL
              AND DATE(s.confirmed_by_mol_at AT TIME ZONE 'Europe/Moscow')
                = DATE(NOW() AT TIME ZONE 'Europe/Moscow')
              ${siteFilterS}
          ),
          del_progress_today AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            JOIN statuses st ON st.id = d.status_id
            WHERE st.entity_type = 'delivery' AND st.code = 'filled'
              AND d.pending_deletion_at IS NULL
              AND d.arrived_at IS NOT NULL
              AND DATE(d.arrived_at AT TIME ZONE 'Europe/Moscow')
                = DATE(NOW() AT TIME ZONE 'Europe/Moscow')
              ${siteFilterD}
          ),
          sh_progress_today AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            JOIN statuses st ON st.id = s.status_id
            WHERE st.entity_type = 'shipment' AND st.code = 'shipped'
              AND s.pending_deletion_at IS NULL
              AND s.shipped_at IS NOT NULL
              AND DATE(s.shipped_at AT TIME ZONE 'Europe/Moscow')
                = DATE(NOW() AT TIME ZONE 'Europe/Moscow')
              ${siteFilterS}
          ),
          del_overdue AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            JOIN statuses st ON st.id = d.status_id
            WHERE st.entity_type = 'delivery' AND st.code = 'filled'
              AND d.pending_deletion_at IS NULL
              AND (d.arrived_at IS NULL OR
                   DATE(d.arrived_at AT TIME ZONE 'Europe/Moscow')
                     < DATE(NOW() AT TIME ZONE 'Europe/Moscow'))
              ${siteFilterD}
          ),
          sh_overdue AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            JOIN statuses st ON st.id = s.status_id
            WHERE st.entity_type = 'shipment' AND st.code = 'shipped'
              AND s.pending_deletion_at IS NULL
              AND (s.shipped_at IS NULL OR
                   DATE(s.shipped_at AT TIME ZONE 'Europe/Moscow')
                     < DATE(NOW() AT TIME ZONE 'Europe/Moscow'))
              ${siteFilterS}
          )
        SELECT
          ((SELECT n FROM del_done) + (SELECT n FROM sh_done))::int                       AS "completedToday",
          ((SELECT n FROM del_progress_today) + (SELECT n FROM sh_progress_today))::int   AS "inProgressToday",
          ((SELECT n FROM del_overdue) + (SELECT n FROM sh_overdue))::int                 AS "overdue"
        `,
      );
      const r = rows[0] ?? {};
      return {
        completedToday: Number(r.completedToday ?? 0),
        inProgressToday: Number(r.inProgressToday ?? 0),
        overdue: Number(r.overdue ?? 0),
      };
    },
  );

  // ─── Сводка для дашборда /stats ────────────────────────────────────────
  //
  // Один публичный endpoint обслуживает все три виджета сводки: KPI strip,
  // динамика по дням (stacked bar), «требует внимания». Внутри —
  // 3 параллельных SQL-запроса через Promise.all для читаемости (один CTE
  // на 200 строк глазами невозможно проверить). Цена 3 round-trip на
  // дашборде, открываемом раз в минуту, незначительна.
  //
  // Числовая консистентность гарантирована:
  //   • inProgressToday/overdue — копия SQL из /operations-counters →
  //     цифры совпадают с шапкой Операций по построению.
  //   • sumDeliveries — Σ qty × price только по приёмкам (у отгрузок
  //     цены нет, иначе бы размывало). UI подписан как «Сумма приёмок».
  //
  // Безопасность: только SELECT, никаких write-операций. inspector_kpp
  // принудительно фильтруется по его site_id (как везде в этом файле).
  app.get(
    '/api/v1/reports/stats-summary',
    {
      preHandler: [app.authenticate, app.authorize('admin', 'manager')],
      schema: {
        querystring: StatsSummaryQuerySchema,
        response: { 200: StatsSummaryResponseSchema },
      },
    },
    async (req) => {
      const sIds = safeUuids(req.query.siteIds);
      const iIds = safeUuids(req.query.inspectorIds);

      // Default 30 дней до сегодня (включительно). Даты собираем по МСК-дню.
      const todayMsk = new Date().toLocaleDateString('en-CA', {
        timeZone: 'Europe/Moscow',
      });
      const toStr = safeDate(req.query.to) ?? todayMsk;
      let fromStr = safeDate(req.query.from);
      if (!fromStr) {
        const toDate = new Date(`${toStr}T00:00:00Z`);
        toDate.setUTCDate(toDate.getUTCDate() - 29);
        fromStr = toDate.toISOString().slice(0, 10);
      }
      // Кол-во дней в периоде (включая обе границы).
      const days = Math.max(
        1,
        Math.round(
          (Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) /
            86_400_000,
        ) + 1,
      );

      // Общие WHERE-фрагменты периода (МСК-день) и опциональных фильтров.
      // Для дат используем COALESCE(arrived_at|shipped_at, updated_at) —
      // тот же подход, что в /inspector-stats. Это даёт fallback для
      // edge-case'а, когда мобила не прислала arrived_at.
      const dateExprD = `DATE(COALESCE(d.arrived_at, d.updated_at) AT TIME ZONE 'Europe/Moscow')`;
      const dateExprS = `DATE(COALESCE(s.shipped_at, s.updated_at) AT TIME ZONE 'Europe/Moscow')`;

      const periodD = `${dateExprD} BETWEEN '${fromStr}'::date AND '${toStr}'::date`;
      const periodS = `${dateExprS} BETWEEN '${fromStr}'::date AND '${toStr}'::date`;

      const extraD: string[] = [`d.pending_deletion_at IS NULL`];
      const extraS: string[] = [`s.pending_deletion_at IS NULL`];
      if (sIds.length) {
        extraD.push(uuidInClause('d.site_id', sIds));
        extraS.push(uuidInClause('s.site_id', sIds));
      }
      if (iIds.length) {
        extraD.push(uuidInClause('d.inspector_id', iIds));
        extraS.push(uuidInClause('s.inspector_id', iIds));
      }
      const filtersD = extraD.join(' AND ');
      const filtersS = extraS.join(' AND ');

      // inspector_kpp — серверный enforcement по site_id (как в
      // /operations-counters). Для admin/manager — пропускаем.
      const inspectorSiteId =
        req.user?.role === 'inspector_kpp'
          ? safeUuid(req.user.siteId ?? undefined)
          : null;
      if (req.user?.role === 'inspector_kpp' && !inspectorSiteId) {
        return {
          range: { from: fromStr, to: toStr, days },
          kpi: {
            deliveries: 0,
            shipments: 0,
            vehicles: 0,
            sumDeliveries: '0',
            avgPerDay: 0,
            inProgressToday: 0,
          },
          daily: [],
          attention: {
            noDocumentDeliveries: 0,
            noDocumentShipments: 0,
            noPhotosDeliveries: 0,
            noPhotosShipments: 0,
            overdue: 0,
            mismatchDocs: 0,
            transit: 0,
          },
        };
      }
      const inspectorFilterD = inspectorSiteId
        ? ` AND d.site_id = '${inspectorSiteId}'::uuid`
        : '';
      const inspectorFilterS = inspectorSiteId
        ? ` AND s.site_id = '${inspectorSiteId}'::uuid`
        : '';
      const enforceD = `${filtersD}${inspectorFilterD}`;
      const enforceS = `${filtersS}${inspectorFilterS}`;

      // ─── 1) KPI + daily series ─────────────────────────────────────────
      const kpiSql = `
        WITH
          del AS (
            SELECT ${dateExprD} AS op_date, d.id
            FROM deliveries d
            WHERE ${enforceD} AND ${periodD}
          ),
          sh AS (
            SELECT ${dateExprS} AS op_date, s.id
            FROM shipments s
            WHERE ${enforceS} AND ${periodS}
          ),
          del_sum AS (
            SELECT COALESCE(SUM(di.qty_actual::numeric * di.price::numeric), 0) AS s
            FROM delivery_items di
            JOIN deliveries d ON d.id = di.delivery_id
            WHERE di.price IS NOT NULL AND di.qty_actual IS NOT NULL
              AND ${enforceD} AND ${periodD}
          )
        SELECT
          (SELECT COUNT(*) FROM del)::int AS "deliveries",
          (SELECT COUNT(*) FROM sh)::int  AS "shipments",
          ((SELECT COUNT(*) FROM del) + (SELECT COUNT(*) FROM sh))::int AS "vehicles",
          (SELECT s FROM del_sum)::text   AS "sumDeliveries"
      `;
      // Серия по дням через generate_series + LEFT JOIN: ноль-дни тоже
      // присутствуют в ответе (важно для непрерывной оси X в bar chart).
      const dailySql = `
        WITH
          days AS (
            SELECT generate_series(
              '${fromStr}'::date,
              '${toStr}'::date,
              '1 day'::interval
            )::date AS d
          ),
          del_by_day AS (
            SELECT ${dateExprD} AS op_date, COUNT(*)::int AS n
            FROM deliveries d
            WHERE ${enforceD} AND ${periodD}
            GROUP BY ${dateExprD}
          ),
          sh_by_day AS (
            SELECT ${dateExprS} AS op_date, COUNT(*)::int AS n
            FROM shipments s
            WHERE ${enforceS} AND ${periodS}
            GROUP BY ${dateExprS}
          )
        SELECT
          to_char(days.d, 'YYYY-MM-DD')      AS "date",
          COALESCE(del_by_day.n, 0)::int     AS "deliveries",
          COALESCE(sh_by_day.n, 0)::int      AS "shipments"
        FROM days
        LEFT JOIN del_by_day ON del_by_day.op_date = days.d
        LEFT JOIN sh_by_day  ON sh_by_day.op_date  = days.d
        ORDER BY days.d
      `;

      // ─── 2) inProgressToday / overdue — period-independent ─────────────
      // Это «сейчас» — не зависит от выбранного периода. SQL — копия
      // /operations-counters, чтобы цифры в Attention и в шапке Операций
      // совпадали по построению. Site-фильтр пользовательского периода
      // тут НЕ применяю (как и в operations-counters).
      const currentSql = `
        WITH
          del_progress_today AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            JOIN statuses st ON st.id = d.status_id
            WHERE st.entity_type = 'delivery' AND st.code = 'filled'
              AND d.pending_deletion_at IS NULL
              AND d.arrived_at IS NOT NULL
              AND DATE(d.arrived_at AT TIME ZONE 'Europe/Moscow')
                = DATE(NOW() AT TIME ZONE 'Europe/Moscow')
              ${inspectorFilterD}
          ),
          sh_progress_today AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            JOIN statuses st ON st.id = s.status_id
            WHERE st.entity_type = 'shipment' AND st.code = 'shipped'
              AND s.pending_deletion_at IS NULL
              AND s.shipped_at IS NOT NULL
              AND DATE(s.shipped_at AT TIME ZONE 'Europe/Moscow')
                = DATE(NOW() AT TIME ZONE 'Europe/Moscow')
              ${inspectorFilterS}
          ),
          del_overdue AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            JOIN statuses st ON st.id = d.status_id
            WHERE st.entity_type = 'delivery' AND st.code = 'filled'
              AND d.pending_deletion_at IS NULL
              AND (d.arrived_at IS NULL OR
                   DATE(d.arrived_at AT TIME ZONE 'Europe/Moscow')
                     < DATE(NOW() AT TIME ZONE 'Europe/Moscow'))
              ${inspectorFilterD}
          ),
          sh_overdue AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            JOIN statuses st ON st.id = s.status_id
            WHERE st.entity_type = 'shipment' AND st.code = 'shipped'
              AND s.pending_deletion_at IS NULL
              AND (s.shipped_at IS NULL OR
                   DATE(s.shipped_at AT TIME ZONE 'Europe/Moscow')
                     < DATE(NOW() AT TIME ZONE 'Europe/Moscow'))
              ${inspectorFilterS}
          )
        SELECT
          ((SELECT n FROM del_progress_today) + (SELECT n FROM sh_progress_today))::int AS "inProgressToday",
          ((SELECT n FROM del_overdue)        + (SELECT n FROM sh_overdue))::int        AS "overdue"
      `;

      // ─── 3) Attention counters — за выбранный период ───────────────────
      const attentionSql = `
        WITH
          del_no_doc AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            WHERE ${enforceD} AND ${periodD}
              AND NOT EXISTS (
                SELECT 1 FROM delivery_sources ds WHERE ds.delivery_id = d.id
              )
          ),
          sh_no_doc AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            WHERE ${enforceS} AND ${periodS}
              AND NOT EXISTS (
                SELECT 1 FROM shipment_sources ss WHERE ss.shipment_id = s.id
              )
          ),
          del_no_photos AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            WHERE ${enforceD} AND ${periodD}
              AND NOT EXISTS (
                SELECT 1 FROM delivery_photos dp WHERE dp.delivery_id = d.id
              )
          ),
          sh_no_photos AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            WHERE ${enforceS} AND ${periodS}
              AND NOT EXISTS (
                SELECT 1 FROM shipment_photos sp WHERE sp.shipment_id = s.id
              )
          ),
          del_transit AS (
            SELECT COUNT(*)::int AS n
            FROM deliveries d
            WHERE ${enforceD} AND ${periodD} AND d.in_transit = TRUE
          ),
          sh_transit AS (
            SELECT COUNT(*)::int AS n
            FROM shipments s
            WHERE ${enforceS} AND ${periodS} AND s.in_transit = TRUE
          ),
          mismatch AS (
            SELECT COUNT(*)::int AS n
            FROM source_documents sd
            WHERE sd.parse_error_code = 'validation_mismatch'
              AND DATE(sd.processed_at AT TIME ZONE 'Europe/Moscow')
                BETWEEN '${fromStr}'::date AND '${toStr}'::date
              ${
                sIds.length
                  ? ` AND ${uuidInClause('sd.site_id', sIds)}`
                  : ''
              }
              ${
                inspectorSiteId
                  ? ` AND sd.site_id = '${inspectorSiteId}'::uuid`
                  : ''
              }
          )
        SELECT
          (SELECT n FROM del_no_doc)    AS "noDocumentDeliveries",
          (SELECT n FROM sh_no_doc)     AS "noDocumentShipments",
          (SELECT n FROM del_no_photos) AS "noPhotosDeliveries",
          (SELECT n FROM sh_no_photos) AS "noPhotosShipments",
          (SELECT n FROM mismatch)      AS "mismatchDocs",
          ((SELECT n FROM del_transit) + (SELECT n FROM sh_transit))::int AS "transit"
      `;

      const [kpiRows, dailyRows, currentRows, attentionRows] = await Promise.all([
        execRows(app, kpiSql),
        execRows(app, dailySql),
        execRows(app, currentSql),
        execRows(app, attentionSql),
      ]);

      const k = kpiRows[0] ?? {};
      const c = currentRows[0] ?? {};
      const a = attentionRows[0] ?? {};
      const deliveries = Number(k.deliveries ?? 0);
      const shipments = Number(k.shipments ?? 0);
      const vehicles = Number(k.vehicles ?? deliveries + shipments);
      const inProgressToday = Number(c.inProgressToday ?? 0);
      const overdue = Number(c.overdue ?? 0);

      return {
        range: { from: fromStr, to: toStr, days },
        kpi: {
          deliveries,
          shipments,
          vehicles,
          sumDeliveries: String(k.sumDeliveries ?? '0'),
          avgPerDay: Math.round(((deliveries + shipments) / days) * 100) / 100,
          inProgressToday,
        },
        daily: dailyRows.map((r) => ({
          date: String(r.date),
          deliveries: Number(r.deliveries ?? 0),
          shipments: Number(r.shipments ?? 0),
        })),
        attention: {
          noDocumentDeliveries: Number(a.noDocumentDeliveries ?? 0),
          noDocumentShipments: Number(a.noDocumentShipments ?? 0),
          noPhotosDeliveries: Number(a.noPhotosDeliveries ?? 0),
          noPhotosShipments: Number(a.noPhotosShipments ?? 0),
          overdue,
          mismatchDocs: Number(a.mismatchDocs ?? 0),
          transit: Number(a.transit ?? 0),
        },
      };
    },
  );
}
