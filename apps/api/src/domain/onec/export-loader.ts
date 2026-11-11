/**
 * Чтение приёмок для 1С пакетом: ~10 запросов на порцию, независимо от числа
 * приёмок в ней. Вызывающий обязан держать один снимок БД на всё чтение —
 * `readInSnapshot` (REPEATABLE READ READ ONLY): иначе шапка, строки и документы
 * могли бы прийти из разных моментов, и хеш описывал бы состояние, которого не
 * было.
 *
 * Сырой SQL, а не построитель drizzle: типы выходных колонок задаются явно
 * (numeric::text, даты через to_char) — деньги не проходят через float, а
 * время не зависит от сериализатора Date у общего клиента. Списки id уходят
 * строкой через string_to_array: postgres.js в первом запросе на свежем
 * соединении портит параметры-массивы.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type {
  RawBundle,
  RawContract,
  RawCounterparty,
  RawDocument,
  RawEdo,
  RawHeader,
  RawItem,
  RawLink,
  RawMol,
} from './export-payload.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;

/** ISO-8601 в UTC с микросекундами — без потерь и без Date. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export const isoUtc = (expr: string): SQL => sql.raw(`to_char((${expr}) AT TIME ZONE 'UTC', ${ISO})`);

export function uuidList(ids: readonly string[]): SQL {
  return sql`string_to_array(${ids.join(',')}, ',')::uuid[]`;
}

async function rows<T>(ex: Executor, query: SQL): Promise<T[]> {
  return [...(await ex.execute(query))] as T[];
}

/**
 * Один снимок БД на всё чтение. Первым оператором берётся время — оно идёт в
 * snapshotAt только для справки: clock_timestamp() — время вызова, а не момент
 * снимка, порядок версий на нём не строится (docs/ONEC_API.md).
 */
export async function readInSnapshot<T>(
  db: Db,
  fn: (tx: Tx, snapshotAt: string) => Promise<T>,
): Promise<T> {
  return db.transaction(
    async (tx) => {
      const [now] = await rows<{ now: string }>(tx, sql`select ${isoUtc('clock_timestamp()')} as now`);
      return fn(tx, now!.now);
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

function cp(id: string | null, inn: string | null, kpp: string | null, name: string | null): RawCounterparty | null {
  return id ? { id, inn: inn?.trim() || null, kpp: kpp?.trim() || null, name: name ?? '' } : null;
}

function mol(id: string | null, name: string | null): RawMol | null {
  return id ? { id, name: name ?? '' } : null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function groupBy<T extends { delivery_id: string }>(list: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of list) {
    const bucket = out.get(r.delivery_id);
    if (bucket) bucket.push(r);
    else out.set(r.delivery_id, [r]);
  }
  return out;
}

/**
 * Данные приёмок по id. Приёмки, которых нет, в ответе отсутствуют.
 * Порядок не задан — вызывающий ищет по id.
 */
export async function loadDeliveryBundles(
  ex: Executor,
  deliveryIds: readonly string[],
): Promise<Map<string, RawBundle>> {
  const out = new Map<string, RawBundle>();
  if (deliveryIds.length === 0) return out;
  const ids = uuidList(deliveryIds);

  const headers = await rows<{
    id: string;
    display_id: string;
    status_code: string;
    confirmed_at: string | null;
    arrived_at: string | null;
    pending_deletion_at: string | null;
    site_code: string;
    site_name: string;
    fot_site_id: string | null;
    purpose: string | null;
    supplier_id: string | null;
    supplier_inn: string | null;
    supplier_kpp: string | null;
    supplier_name: string | null;
    contractor_id: string | null;
    contractor_inn: string | null;
    contractor_kpp: string | null;
    contractor_name: string | null;
    mol_id: string | null;
    mol_name: string | null;
    source_shipment_id: string | null;
    shipment_display_id: string | null;
  }>(
    ex,
    sql`
      select d.id::text as id,
             d.display_id::text as display_id,
             s.code as status_code,
             ${isoUtc('d.confirmed_by_mol_at')} as confirmed_at,
             ${isoUtc('d.arrived_at')} as arrived_at,
             ${isoUtc('d.pending_deletion_at')} as pending_deletion_at,
             st.code as site_code,
             st.name as site_name,
             st.fot_site_id::text as fot_site_id,
             d.purpose,
             sup.id::text as supplier_id, sup.inn as supplier_inn, sup.kpp as supplier_kpp, sup.name as supplier_name,
             con.id::text as contractor_id, con.inn as contractor_inn, con.kpp as contractor_kpp,
             con.name as contractor_name,
             rp.id::text as mol_id, rp.full_name as mol_name,
             d.source_shipment_id::text as source_shipment_id,
             sh.display_id::text as shipment_display_id
        from deliveries d
        join statuses s on s.id = d.status_id
        join sites st on st.id = d.site_id
        left join counterparties sup on sup.id = d.supplier_id
        left join counterparties con on con.id = d.contractor_id
        left join responsible_persons rp on rp.id = d.recipient_mol_id
        left join shipments sh on sh.id = d.source_shipment_id
       where d.id = any(${ids})`,
  );
  if (headers.length === 0) return out;

  const items = await rows<{
    delivery_id: string;
    line_no: number;
    name_raw: string;
    material_id: string | null;
    material_code: string | null;
    material_name: string | null;
    unit: string | null;
    qty_planned: string | null;
    qty_actual: string | null;
    price: string | null;
    vat_rate: string | null;
    vat_sum: string | null;
    item_kind: string;
    inventory_number: string | null;
    serial_number: string | null;
    source_document_id: string | null;
  }>(
    ex,
    sql`
      select i.delivery_id::text as delivery_id, i.line_no, i.name_raw,
             m.id::text as material_id, m.code as material_code, m.name as material_name,
             i.unit, i.qty_planned::text as qty_planned, i.qty_actual::text as qty_actual,
             i.price::text as price, i.vat_rate::text as vat_rate, i.vat_sum::text as vat_sum,
             i.item_kind::text as item_kind, i.inventory_number, i.serial_number,
             i.source_document_id::text as source_document_id
        from delivery_items i
        left join materials m on m.id = i.material_id
       where i.delivery_id = any(${ids})`,
  );

  const links = await rows<{
    delivery_id: string;
    source_document_id: string;
    own_recipient: boolean;
    own_purpose: boolean;
    purpose: string | null;
    contractor_id: string | null;
    contractor_inn: string | null;
    contractor_kpp: string | null;
    contractor_name: string | null;
    mol_id: string | null;
    mol_name: string | null;
  }>(
    ex,
    sql`
      select ds.delivery_id::text as delivery_id, ds.source_document_id::text as source_document_id,
             ds.own_recipient, ds.own_purpose, ds.purpose,
             c.id::text as contractor_id, c.inn as contractor_inn, c.kpp as contractor_kpp,
             c.name as contractor_name,
             rp.id::text as mol_id, rp.full_name as mol_name
        from delivery_sources ds
        left join counterparties c on c.id = ds.contractor_id
        left join responsible_persons rp on rp.id = ds.recipient_mol_id
       where ds.delivery_id = any(${ids})`,
  );

  // Документы приёмки — связанные ∪ из происхождения строк (то же правило, что
  // у карточки, source-document-summary.ts). Технические записи пакета — нет.
  const docIdSet = new Set<string>();
  for (const l of links) docIdSet.add(l.source_document_id);
  for (const i of items) if (i.source_document_id) docIdSet.add(i.source_document_id);
  const docIds = [...docIdSet];

  // ИНН сторон — тот же приоритет, что в истории операций (routes/deliveries.ts,
  // supplierInn/buyerInn/consigneeInn): распознанное впереди справочника,
  // NULLIF(BTRIM) на каждом источнике (suppliers.inn NOT NULL DEFAULT '').
  const documents =
    docIds.length === 0
      ? []
      : await rows<{
          id: string;
          kind: string;
          doc_number: string | null;
          doc_date: string | null;
          total_sum: string | null;
          vat_sum: string | null;
          supplier_inn: string | null;
          supplier_kpp: string | null;
          supplier_name: string | null;
          buyer_inn: string | null;
          buyer_kpp: string | null;
          buyer_name: string | null;
          consignee_inn: string | null;
          consignee_kpp: string | null;
          consignee_name: string | null;
        }>(
          ex,
          sql`
            select sd.id::text as id, sd.kind::text as kind, sd.doc_number,
                   to_char(sd.doc_date, 'YYYY-MM-DD') as doc_date,
                   sd.total_sum::text as total_sum, sd.vat_sum::text as vat_sum,
                   COALESCE(NULLIF(BTRIM(sd.supplier_inn_raw), ''), NULLIF(BTRIM(sdir.inn), ''),
                            NULLIF(BTRIM(scp.inn), '')) as supplier_inn,
                   scp.kpp as supplier_kpp,
                   COALESCE(sdir.name, scp.name) as supplier_name,
                   COALESCE(NULLIF(BTRIM(sd.buyer_inn_raw), ''), NULLIF(BTRIM(b.inn), '')) as buyer_inn,
                   b.kpp as buyer_kpp,
                   COALESCE(sd.buyer_name_raw, b.name) as buyer_name,
                   COALESCE(NULLIF(BTRIM(sd.consignee_inn_raw), ''), NULLIF(BTRIM(cn.inn), '')) as consignee_inn,
                   cn.kpp as consignee_kpp,
                   COALESCE(sd.consignee_name_raw, cn.name) as consignee_name
              from source_documents sd
              left join suppliers sdir on sdir.id = sd.supplier_directory_id
              left join counterparties scp on scp.id = sd.supplier_id
              left join counterparties b on b.id = sd.buyer_id
              left join counterparties cn on cn.id = sd.consignee_id
             where sd.id = any(${uuidList(docIds)})
               and not sd.is_technical`,
        );

  // Другие приёмки с той же УПД (общая УПД на несколько рейсов).
  const shared =
    docIds.length === 0
      ? []
      : await rows<{ doc_id: string; delivery_id: string; display_id: string }>(
          ex,
          sql`
            select ds.source_document_id::text as doc_id, d.id::text as delivery_id,
                   d.display_id::text as display_id
              from delivery_sources ds
              join deliveries d on d.id = ds.delivery_id
             where ds.source_document_id = any(${uuidList(docIds)})
               and d.pending_deletion_at is null`,
        );

  // Возможные дубли — тот же ключ, что у поиска дублей УПД в портале
  // (source_upd_dedup_idx / source_upd_dedup_directory_idx).
  const duplicates =
    docIds.length === 0
      ? []
      : await rows<{ doc_id: string; dup_id: string }>(
          ex,
          sql`
            select a.id::text as doc_id, b.id::text as dup_id
              from source_documents a
              join source_documents b
                on b.kind = 'upd' and b.id <> a.id and not b.is_technical
               and b.doc_number = a.doc_number and b.doc_date = a.doc_date
               and ((a.supplier_directory_id is not null and b.supplier_directory_id = a.supplier_directory_id)
                 or (a.supplier_id is not null and b.supplier_id = a.supplier_id))
             where a.id = any(${uuidList(docIds)})
               and a.kind = 'upd' and a.doc_number is not null and a.doc_date is not null`,
        );

  const contracts = await rows<{
    delivery_id: string;
    source_document_id: string | null;
    onec_id: string;
    counterparty_onec_id: string | null;
    number: string | null;
    contract_date: string | null;
    name: string;
  }>(
    ex,
    sql`
      select dc.delivery_id::text as delivery_id, dc.source_document_id::text as source_document_id,
             sc.onec_id::text as onec_id, sc.counterparty_onec_id::text as counterparty_onec_id,
             sc.number, sc.contract_date::text as contract_date, sc.name
        from delivery_contracts dc
        join supplier_contracts sc on sc.id = dc.contract_id
       where dc.delivery_id = any(${ids})`,
  );

  // УПД из ЭДО, привязанные вручную: реестр (Диадок/СБИС) — основной путь,
  // импортированная карточка Диадока — старый.
  const edo = await rows<{
    delivery_id: string;
    match_id: string;
    section_document_id: string | null;
    export_document_id: string | null;
    source_document_id: string | null;
    operator: string | null;
    number: string | null;
    date: string | null;
    correction_number: string | null;
    supplier_inn: string | null;
    total_sum: string | null;
    vat_sum: string | null;
    sha256: string | null;
    size_bytes: number | null;
    xml_available: boolean;
  }>(
    ex,
    sql`
      select m.delivery_id::text as delivery_id, m.id::text as match_id,
             m.section_document_id::text as section_document_id,
             m.export_document_id::text as export_document_id,
             m.source_document_id::text as source_document_id,
             CASE WHEN m.export_document_id IS NOT NULL THEN a.provider ELSE 'diadoc' END as operator,
             COALESCE(x.document_number, isd.doc_number) as number,
             COALESCE(to_char(x.document_date, 'YYYY-MM-DD'), to_char(isd.doc_date, 'YYYY-MM-DD')) as date,
             x.correction_number,
             COALESCE(NULLIF(BTRIM(x.supplier_inn), ''), NULLIF(BTRIM(isd.supplier_inn_raw), '')) as supplier_inn,
             COALESCE(x.total_sum, isd.total_sum)::text as total_sum,
             COALESCE(x.vat_sum, isd.vat_sum)::text as vat_sum,
             x.content_sha256 as sha256,
             COALESCE(x.size_bytes, att.size_bytes) as size_bytes,
             CASE WHEN m.export_document_id IS NOT NULL
                  THEN (x.status = 'stored' AND x.s3_key IS NOT NULL)
                  ELSE att.s3_key IS NOT NULL END as xml_available
        from delivery_edo_matches m
        left join edo_export_documents x on x.id = m.export_document_id
        left join edo_accounts a on a.id = x.edo_account_id
        left join source_documents isd on isd.id = m.source_document_id
        left join lateral (
          select sda.s3_key, sda.size_bytes
            from source_document_attachments sda
           where m.source_document_id is not null
             and sda.source_document_id = m.source_document_id
             and sda.role = 'original'
           order by sda.created_at desc
           limit 1
        ) att on true
       where m.delivery_id = any(${ids})`,
  );

  const units = await rows<{ code: string; okei_code: string }>(
    ex,
    sql`select lower(btrim(code)) as code, okei_code from units where okei_code is not null and okei_code <> ''`,
  );
  const okeiByUnit = new Map(units.map((u) => [u.code, u.okei_code]));

  const docById = new Map<string, RawDocument>(
    documents.map((d) => [
      d.id,
      {
        id: d.id,
        kind: d.kind,
        number: d.doc_number,
        date: d.doc_date,
        totalSum: d.total_sum,
        vatSum: d.vat_sum,
        supplier: { inn: d.supplier_inn, kpp: d.supplier_kpp?.trim() || null, name: d.supplier_name },
        buyer: { inn: d.buyer_inn, kpp: d.buyer_kpp?.trim() || null, name: d.buyer_name },
        consignee: { inn: d.consignee_inn, kpp: d.consignee_kpp?.trim() || null, name: d.consignee_name },
      },
    ]),
  );
  const sharedByDoc = new Map<string, { id: string; displayId: number }[]>();
  for (const s of shared) {
    const list = sharedByDoc.get(s.doc_id) ?? [];
    list.push({ id: s.delivery_id, displayId: Number(s.display_id) });
    sharedByDoc.set(s.doc_id, list);
  }
  const dupByDoc = new Map<string, string[]>();
  for (const d of duplicates) {
    const list = dupByDoc.get(d.doc_id) ?? [];
    list.push(d.dup_id);
    dupByDoc.set(d.doc_id, list);
  }

  const itemsBy = groupBy(items);
  const linksBy = groupBy(links);
  const contractsBy = groupBy(contracts);
  const edoBy = groupBy(edo);

  for (const h of headers) {
    const header: RawHeader = {
      id: h.id,
      displayId: Number(h.display_id),
      statusCode: h.status_code,
      confirmedAt: h.confirmed_at,
      arrivedAt: h.arrived_at,
      pendingDeletionAt: h.pending_deletion_at,
      siteCode: h.site_code,
      siteName: h.site_name,
      fotSiteId: num(h.fot_site_id),
      purpose: h.purpose,
      supplier: cp(h.supplier_id, h.supplier_inn, h.supplier_kpp, h.supplier_name),
      contractor: cp(h.contractor_id, h.contractor_inn, h.contractor_kpp, h.contractor_name),
      mol: mol(h.mol_id, h.mol_name),
      sourceShipmentId: h.source_shipment_id,
      sourceShipmentDisplayId: num(h.shipment_display_id),
    };
    const myItems: RawItem[] = (itemsBy.get(h.id) ?? []).map((i) => ({
      lineNo: i.line_no,
      nameRaw: i.name_raw,
      material: i.material_id
        ? { id: i.material_id, code: i.material_code, name: i.material_name ?? '' }
        : null,
      unit: i.unit,
      qtyPlanned: i.qty_planned,
      qtyActual: i.qty_actual,
      price: i.price,
      vatRate: i.vat_rate,
      vatSum: i.vat_sum,
      itemKind: i.item_kind,
      inventoryNumber: i.inventory_number,
      serialNumber: i.serial_number,
      sourceDocumentId: i.source_document_id,
    }));
    const myLinks: RawLink[] = (linksBy.get(h.id) ?? []).map((l) => ({
      sourceDocumentId: l.source_document_id,
      ownRecipient: l.own_recipient,
      contractor: cp(l.contractor_id, l.contractor_inn, l.contractor_kpp, l.contractor_name),
      mol: mol(l.mol_id, l.mol_name),
      ownPurpose: l.own_purpose,
      purpose: l.purpose,
    }));
    const myDocIds = new Set<string>([
      ...myLinks.map((l) => l.sourceDocumentId),
      ...myItems.map((i) => i.sourceDocumentId).filter((x): x is string => x !== null),
    ]);
    const myDocs = new Map<string, RawDocument>();
    for (const id of myDocIds) {
      const doc = docById.get(id);
      if (doc) myDocs.set(id, doc);
    }
    const myContracts: RawContract[] = (contractsBy.get(h.id) ?? []).map((c) => ({
      sourceDocumentId: c.source_document_id,
      onecId: c.onec_id,
      counterpartyOnecId: c.counterparty_onec_id,
      number: c.number,
      date: c.contract_date,
      name: c.name,
    }));
    const myEdo: RawEdo[] = (edoBy.get(h.id) ?? []).map((e) => ({
      matchId: e.match_id,
      sectionDocumentId: e.section_document_id,
      exportDocumentId: e.export_document_id,
      sourceDocumentId: e.source_document_id,
      operator: e.operator ?? 'unknown',
      number: e.number,
      date: e.date,
      correctionNumber: e.correction_number,
      supplierInn: e.supplier_inn,
      totalSum: e.total_sum,
      vatSum: e.vat_sum,
      sha256: e.sha256,
      sizeBytes: e.size_bytes,
      xmlAvailable: e.xml_available,
    }));
    out.set(h.id, {
      header,
      items: myItems,
      links: myLinks,
      documents: myDocs,
      contracts: myContracts,
      edo: myEdo,
      sharedWith: sharedByDoc,
      duplicates: dupByDoc,
      okeiByUnit,
    });
  }
  return out;
}
