/**
 * Опись договоров и ДС в ящике Диадока — без скачивания содержимого.
 *
 * Порядок:
 *   1. Доступ учётки и справочник типов ящика.
 *   2. Список ВСЕХ документов (`Any.Inbound`, `Any.Outbound`) за [since; until]:
 *      окна делятся до точного счёта, каждое окно читается до пустой страницы и
 *      сверяется «прочитано = счёт». Отдельного класса «договорные» нет, а
 *      договоры почти всегда неформализованные, поэтому отбор — у нас.
 *   3. Контроль по типам: точные счёты `Contract`/`SupplementaryAgreement` по
 *      обоим направлениям против числа таких документов в общем списке.
 *   4. Отбор по типу и имени (classify.ts).
 *   5. Пакеты: `GetMessage` для каждого сообщения с договором/ДС, затем для
 *      сообщений с тем же `PacketId` — до неподвижной точки.
 *   6. Контрагенты: `GetOrganization` по каждому ящику контрагента.
 *
 * Шлюз полноты: опись полная, только если сошлись все окна, контроль по типам и
 * каждый `GetMessage` прошёл. Любой отказ Диадока на этих шагах (в том числе
 * 400 — это ошибка параметров, а не «типа нет») делает опись неполной, и
 * выгрузка по ней не запустится. Отказ `GetOrganization` шлюз не трогает:
 * строка останется без ИНН и будет помечена.
 */
import type { DiadocClient } from '../diadoc.client.js';
import { REQUIRED_ACCESS_LEVEL } from '../check-access.js';
import {
  diadocTimestampToDate,
  type DiadocDocumentInfo,
  type DiadocEmployee,
  type DiadocEntity,
  type DiadocListedDocument,
  type DiadocMessage,
} from '../diadoc.types.js';
import { metadataMap } from '../document-meta.js';
import { EdoLeaseLost } from '../inventory.js';
import { listedDocumentState } from '../list-compare.js';
import { dateToTicks, readWindowPages, splitToExactWindows, ticksToDate, type ListFn, type TickWindow } from '../list-windows.js';
import {
  CLASSIFIED_TYPES,
  CONTRACT_TYPE,
  SUPPLEMENTARY_TYPE,
  classifyDocument,
  extractContractRef,
} from './classify.js';
import { moscowDay } from './layout.js';
import {
  RULES_VERSION,
  SNAPSHOT_VERSION,
  docKey,
  type Counterparty,
  type Direction,
  type InventorySnapshot,
  type SnapshotMessage,
  type SnapshotRow,
  type TypeControl,
} from './snapshot.js';

export type InventorySession = {
  account: { id: string; name: string };
  boxId: string;
  client: Pick<
    DiadocClient,
    'getMyEmployee' | 'getDocuments' | 'getDocumentTypes' | 'getMessage' | 'getOrganization'
  >;
  /** Продлевает лиз; потерян — бросает EdoLeaseLost. */
  ensureLease: () => Promise<void>;
};

export type InventoryOptions = {
  since: Date;
  until: Date;
  now?: () => Date;
  log?: (line: string) => void;
};

const LIST_CATEGORIES: { category: string; direction: Direction }[] = [
  { category: 'Any.Inbound', direction: 'inbound' },
  { category: 'Any.Outbound', direction: 'outbound' },
];
const CONTROLLED_TYPES = [CONTRACT_TYPE, SUPPLEMENTARY_TYPE] as const;

/** Документ из списка — то, что нужно описи; полный документ не храним. */
type Listed = Omit<
  SnapshotRow,
  'row' | 'category' | 'nameCategory' | 'selection' | 'reason' | 'contractRef' | 'packageVia' | 'needRecipientSignature' | 'inventorySignatures'
>;

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function iso(value: unknown): string | null {
  return diadocTimestampToDate(value as string | number | undefined)?.toISOString() ?? null;
}

function summarize(doc: DiadocListedDocument | DiadocDocumentInfo, ids: { messageId: string; entityId: string }, direction: Direction, fileName?: string | null): Listed {
  const meta = metadataMap(doc.Metadata);
  const state = listedDocumentState(doc as DiadocListedDocument);
  const at =
    direction === 'inbound'
      ? iso(doc.DeliveryTimestampTicks)
      : (iso(doc.SendTimestampTicks) ?? iso(doc.CreationTimestampTicks));
  const packetId = (doc as { PacketId?: unknown }).PacketId;
  return {
    messageId: ids.messageId,
    entityId: ids.entityId,
    direction,
    typeNamedId: doc.TypeNamedId ?? doc.DocumentType ?? null,
    fileName: fileName ?? doc.FileName ?? doc.Title ?? null,
    number: meta.DocumentNumber ?? doc.DocumentNumber ?? null,
    date: meta.DocumentDate ?? doc.DocumentDate ?? null,
    at,
    counteragentBoxId: doc.CounteragentBoxId ?? null,
    packetId: typeof packetId === 'string' && packetId ? packetId : null,
    docflowText: state.docflowText,
    recipientResponse: state.recipientResponse,
    revocation: state.revocation,
  };
}

export function isSignatureEntity(e: DiadocEntity): boolean {
  return /^signature$/i.test(String(e.EntityType ?? ''));
}

/** Документ сообщения: вложение без родителя, у которого Диадок описал документ. */
export function isDocumentEntity(e: DiadocEntity): boolean {
  return /^attachment$/i.test(String(e.EntityType ?? '')) && !e.ParentEntityId && Boolean(e.DocumentInfo);
}

export function emptySnapshot(
  session: Pick<InventorySession, 'account' | 'boxId'>,
  opts: Pick<InventoryOptions, 'since' | 'until'>,
  createdAt: Date,
): InventorySnapshot {
  return {
    version: SNAPSHOT_VERSION,
    rulesVersion: RULES_VERSION,
    accountId: session.account.id,
    accountName: session.account.name,
    boxId: session.boxId,
    since: opts.since.toISOString(),
    until: opts.until.toISOString(),
    sinceTicks: dateToTicks(opts.since).toString(),
    untilTicks: dateToTicks(opts.until).toString(),
    createdAt: createdAt.toISOString(),
    finishedAt: null,
    complete: false,
    reasons: [],
    notes: [],
    requests: 0,
    boxTypes: null,
    windows: [],
    typeControls: [],
    counts: {},
    skipped: { test: 0, deleted: 0, deletedInPackages: 0 },
    firstDocumentAt: { inbound: null, outbound: null },
    rows: [],
    messages: [],
    counterparties: [],
  };
}

export async function runContractInventory(
  session: InventorySession,
  opts: InventoryOptions,
): Promise<InventorySnapshot> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const snap = emptySnapshot(session, opts, now());
  try {
    await collect(session, snap, log);
  } catch (err) {
    if (!(err instanceof EdoLeaseLost)) throw err;
    snap.reasons.push('лиз учётки потерян — опись прервана');
  }
  snap.complete = snap.reasons.length === 0;
  snap.finishedAt = now().toISOString();
  return snap;
}

async function collect(
  session: InventorySession,
  snap: InventorySnapshot,
  log: (line: string) => void,
): Promise<void> {
  const { client, boxId } = session;
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    await session.ensureLease();
    snap.requests += 1;
    return fn();
  };
  const list: ListFn = (q) =>
    call(() =>
      client.getDocuments({
        boxId,
        filterCategory: q.filterCategory,
        fromTicks: q.fromTicks,
        toTicks: q.toTicks,
        afterIndexKey: q.afterIndexKey,
        count: q.count,
      }),
    );
  const period: TickWindow = { from: BigInt(snap.sinceTicks), to: BigInt(snap.untilTicks) };

  // 1. Доступ: без полного доступа список покажет не всё.
  let employee: DiadocEmployee;
  try {
    employee = await call(() => client.getMyEmployee(boxId));
  } catch (err) {
    if (err instanceof EdoLeaseLost) throw err;
    snap.reasons.push(`проверка доступа: ${errorText(err)}`);
    return;
  }
  const level = employee.Permissions?.DocumentAccessLevel ?? employee.DocumentAccessLevel ?? null;
  if (level !== REQUIRED_ACCESS_LEVEL) {
    snap.reasons.push(`доступ учётки «${level ?? '?'}», нужен ${REQUIRED_ACCESS_LEVEL}: список был бы неполным`);
    return;
  }
  try {
    const types = await call(() => client.getDocumentTypes(boxId));
    snap.boxTypes = types.map((t) => ({ name: t.name, title: t.title }));
  } catch (err) {
    if (err instanceof EdoLeaseLost) throw err;
    snap.notes.push(`справочник типов недоступен: ${errorText(err)}`);
  }

  // 2. Весь список за период.
  const listed = new Map<string, Listed>();
  const messagesByPacket = new Map<string, Set<string>>();
  for (const { category, direction } of LIST_CATEGORIES) {
    log(`Список ${category}: деление периода на окна…`);
    let windows;
    try {
      windows = await splitToExactWindows(list, category, period);
    } catch (err) {
      if (err instanceof EdoLeaseLost) throw err;
      snap.reasons.push(`список ${category}: ${errorText(err)}`);
      continue;
    }
    log(`Список ${category}: окон ${windows.length}, документов ${windows.reduce((s, w) => s + w.total, 0)}`);
    for (const w of windows) {
      const record = { category, from: w.window.from.toString(), to: w.window.to.toString(), total: w.total, read: 0 };
      snap.windows.push(record);
      let docs: DiadocListedDocument[];
      try {
        docs = (await readWindowPages(list, category, w.window)).documents;
      } catch (err) {
        if (err instanceof EdoLeaseLost) throw err;
        snap.reasons.push(`список ${category}, окно ${describe(w.window)}: ${errorText(err)}`);
        continue;
      }
      record.read = docs.length;
      if (docs.length !== w.total) {
        snap.reasons.push(`список ${category}, окно ${describe(w.window)}: прочитано ${docs.length} из ${w.total}`);
      }
      for (const doc of docs) {
        if (doc.IsTest === true) {
          snap.skipped.test += 1;
          continue;
        }
        if (doc.IsDeleted === true) {
          snap.skipped.deleted += 1;
          continue;
        }
        const s = summarize(doc, { messageId: doc.MessageId, entityId: doc.EntityId }, direction);
        listed.set(docKey(s), s);
        countDocument(snap, s);
        if (s.packetId) {
          const set = messagesByPacket.get(s.packetId) ?? new Set<string>();
          set.add(s.messageId);
          messagesByPacket.set(s.packetId, set);
        }
      }
    }
  }

  // 3. Контроль по типам.
  const boxTypeNames = snap.boxTypes ? new Set(snap.boxTypes.map((t) => t.name)) : null;
  for (const type of CONTROLLED_TYPES) {
    for (const dir of ['Inbound', 'Outbound'] as const) {
      const direction: Direction = dir === 'Inbound' ? 'inbound' : 'outbound';
      let count = 0;
      for (const s of listed.values()) if (s.typeNamedId === type && s.direction === direction) count += 1;
      const control: TypeControl = { typeNamedId: type, direction: dir, state: 'ok', expected: null, listed: count };
      if (boxTypeNames && !boxTypeNames.has(type)) {
        control.state = 'not_in_box';
        if (count > 0) snap.reasons.push(`тип ${type} не заведён у ящика, а в списке ${count} таких документов`);
      } else {
        try {
          const windows = await splitToExactWindows(list, `${type}.${dir}`, period);
          control.expected = windows.reduce((sum, w) => sum + w.total, 0);
          if (control.expected !== count) {
            control.state = 'mismatch';
            snap.reasons.push(`контроль ${type}.${dir}: по типу ${control.expected}, в общем списке ${count}`);
          }
        } catch (err) {
          if (err instanceof EdoLeaseLost) throw err;
          control.state = 'error';
          control.error = errorText(err);
          snap.reasons.push(`контроль ${type}.${dir}: ${control.error}`);
        }
      }
      snap.typeControls.push(control);
    }
  }

  // 4. Отбор.
  type Draft = Omit<SnapshotRow, 'row'>;
  const drafts = new Map<string, Draft>();
  const draftOf = (s: Listed): Draft => {
    const c = classifyDocument(s.typeNamedId, s.fileName);
    return {
      ...s,
      category: c.category,
      nameCategory: c.category,
      selection: c.selection,
      reason: c.reason,
      contractRef: extractContractRef(s.fileName),
      packageVia: null,
      needRecipientSignature: null,
      inventorySignatures: null,
    };
  };
  for (const s of listed.values()) {
    if (s.typeNamedId && CLASSIFIED_TYPES.has(s.typeNamedId)) drafts.set(docKey(s), draftOf(s));
  }

  // 5. Пакеты.
  const anchorMessages = new Set([...drafts.values()].filter((d) => d.selection === 'auto').map((d) => d.messageId));
  const packets = new Set<string>();
  const queue: { messageId: string; by: 'anchor' | 'packet' }[] = [...anchorMessages].map((messageId) => ({
    messageId,
    by: 'anchor' as const,
  }));
  const seen = new Set<string>();
  log(`Пакеты: сообщений с договором/ДС ${anchorMessages.size}`);
  while (queue.length > 0) {
    const { messageId, by } = queue.shift()!;
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    let message: DiadocMessage;
    try {
      message = await call(() => client.getMessage(boxId, messageId));
    } catch (err) {
      if (err instanceof EdoLeaseLost) throw err;
      snap.reasons.push(`состав сообщения ${messageId}: ${errorText(err)}`);
      continue;
    }
    snap.messages.push(messageInfo(message, by));
    const viaMessage = anchorMessages.has(messageId);
    const entities = message.Entities;
    for (const e of entities.filter(isDocumentEntity)) {
      const key = `${messageId}/${e.EntityId}`;
      const known = listed.get(key);
      const packetId = e.PacketId ?? known?.packetId ?? null;
      // В сообщении, найденном по PacketId, в пакет входят только документы этого пакета.
      if (!viaMessage && !(packetId && packets.has(packetId))) continue;
      if (e.DocumentInfo?.IsDeleted) {
        snap.skipped.deletedInPackages += 1;
        continue;
      }
      let draft = drafts.get(key);
      if (!draft) {
        const direction: Direction = /outbound/i.test(e.DocumentInfo?.DocumentDirection ?? '')
          ? 'outbound'
          : message.FromBoxId === boxId
            ? 'outbound'
            : 'inbound';
        const s =
          known ?? summarize(e.DocumentInfo!, { messageId, entityId: e.EntityId }, direction, e.FileName ?? null);
        const classified = s.typeNamedId !== null && CLASSIFIED_TYPES.has(s.typeNamedId);
        draft = classified ? draftOf(s) : { ...draftOf(s), nameCategory: null };
        drafts.set(key, draft);
      }
      if (draft.selection !== 'auto' || draft.category === 'package') {
        draft.category = 'package';
        draft.selection = 'auto';
        draft.packageVia = viaMessage ? 'message' : 'packet';
        draft.reason = viaMessage
          ? 'пришёл в одном сообщении с договором/ДС'
          : 'в том же пакете (PacketId), другое сообщение';
      }
      draft.needRecipientSignature = typeof e.NeedRecipientSignature === 'boolean' ? e.NeedRecipientSignature : null;
      draft.inventorySignatures = entities.filter((x) => isSignatureEntity(x) && x.ParentEntityId === e.EntityId).length;
      if (packetId && !packets.has(packetId)) {
        packets.add(packetId);
        for (const other of messagesByPacket.get(packetId) ?? []) {
          if (!seen.has(other)) queue.push({ messageId: other, by: 'packet' });
        }
      }
    }
  }

  // 6. Контрагенты — по каждому ящику.
  const boxes = new Set<string>();
  for (const d of drafts.values()) if (d.counteragentBoxId) boxes.add(d.counteragentBoxId);
  log(`Контрагенты: ящиков ${boxes.size}`);
  const titles = titlesFromMessages(snap.messages, boxId);
  let orgFailures = 0;
  for (const box of boxes) {
    let cp: Counterparty = { boxId: box, inn: null, kpp: null, name: titles.get(box) ?? null, source: titles.has(box) ? 'message' : 'unknown' };
    try {
      const org = await call(() => client.getOrganization(box));
      if (org) cp = { boxId: box, inn: org.inn, kpp: org.kpp, name: org.name ?? cp.name, source: 'organization' };
    } catch (err) {
      if (err instanceof EdoLeaseLost) throw err;
      orgFailures += 1;
    }
    snap.counterparties.push(cp);
  }
  if (orgFailures > 0) snap.notes.push(`реквизиты не получены у ${orgFailures} ящиков контрагентов — у их строк нет ИНН`);

  // Номера строк — по времени, затем по идентификаторам: устойчиво внутри снимка.
  const ordered = [...drafts.values()].sort(
    (a, b) =>
      (a.at ?? '').localeCompare(b.at ?? '') ||
      a.messageId.localeCompare(b.messageId) ||
      a.entityId.localeCompare(b.entityId),
  );
  snap.rows = ordered.map((d, i) => ({ row: i + 1, ...d }));
}

function describe(w: TickWindow): string {
  return `${ticksToDate(w.from).toISOString()} – ${ticksToDate(w.to).toISOString()}`;
}

function countDocument(snap: InventorySnapshot, s: Listed): void {
  const year = s.at ? moscowDay(s.at).slice(0, 4) : 'без даты';
  const k = `${year}|${s.direction}|${s.typeNamedId ?? '?'}`;
  snap.counts[k] = (snap.counts[k] ?? 0) + 1;
  if (s.at) {
    const first = snap.firstDocumentAt[s.direction];
    if (!first || s.at < first) snap.firstDocumentAt[s.direction] = s.at;
  }
}

function messageInfo(m: DiadocMessage, by: 'anchor' | 'packet'): SnapshotMessage {
  return {
    messageId: m.MessageId,
    fromBoxId: m.FromBoxId ?? null,
    toBoxId: m.ToBoxId ?? null,
    fromTitle: m.FromTitle ?? null,
    toTitle: m.ToTitle ?? null,
    expandedBy: by,
  };
}

/** Название контрагента из раскрытых сообщений — запасное, если GetOrganization не ответил. */
function titlesFromMessages(messages: SnapshotMessage[], ourBoxId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m.fromBoxId && m.fromBoxId !== ourBoxId && m.fromTitle) out.set(m.fromBoxId, m.fromTitle);
    if (m.toBoxId && m.toBoxId !== ourBoxId && m.toTitle) out.set(m.toBoxId, m.toTitle);
  }
  return out;
}
