/**
 * Снимок описи договоров и журнал выгрузки — файлы в папке выгрузки.
 *
 * Снимок (`inventory.json`) фиксирует ящик, границы периода и решение по
 * каждому документу. Выгрузка работает только с полным снимком и только с
 * ним: продолжение после остановки качает то же самое, а не то, что ящик
 * покажет завтра.
 *
 * Журнал (`progress.jsonl`) — по строке на каждый итог: исходный файл, каждая
 * подпись, печатная форма, состав документа. Последняя запись по ключу главная.
 * Отметке «скачано» без файла нужного размера не верим — см. download.ts.
 */
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { NameCategory, ReviewCategory, Selection } from './classify.js';

export const SNAPSHOT_VERSION = 1;
export const RULES_VERSION = 'contracts-v1';

export const INVENTORY_FILE = 'inventory.json';
export const PROGRESS_FILE = 'progress.jsonl';
export const SELECTION_FILE = 'selection.json';
export const SUMMARY_FILE = 'summary.json';
export const XLSX_FILE = 'опись.xlsx';
export const FILES_DIR = 'files';

export type Direction = 'inbound' | 'outbound';
export type RowCategory = NameCategory | 'package';

export type SnapshotRow = {
  /** Устойчивый номер строки в снимке — по нему пользователь добавляет строки. */
  row: number;
  messageId: string;
  entityId: string;
  direction: Direction;
  typeNamedId: string | null;
  fileName: string | null;
  number: string | null;
  date: string | null;
  /** Доставка для входящих, отправка для исходящих (ISO). */
  at: string | null;
  counteragentBoxId: string | null;
  packetId: string | null;
  docflowText: string | null;
  recipientResponse: string | null;
  revocation: string | null;
  category: RowCategory;
  /** Что сказало имя/тип — у строк «в пакете» отличается от категории. */
  nameCategory: NameCategory | null;
  selection: Selection;
  reason: string;
  contractRef: string | null;
  /** Строка «в пакете»: то же сообщение, что у договора/ДС, или другое — по PacketId. */
  packageVia: 'message' | 'packet' | null;
  /** Из GetMessage при описи; у строк вне раскрытых сообщений — null. */
  needRecipientSignature: boolean | null;
  inventorySignatures: number | null;
};

export type SnapshotMessage = {
  messageId: string;
  fromBoxId: string | null;
  toBoxId: string | null;
  fromTitle: string | null;
  toTitle: string | null;
  expandedBy: 'anchor' | 'packet';
};

export type Counterparty = {
  boxId: string;
  inn: string | null;
  kpp: string | null;
  name: string | null;
  source: 'organization' | 'message' | 'unknown';
};

export type WindowRecord = { category: string; from: string; to: string; total: number; read: number };

export type TypeControl = {
  typeNamedId: string;
  direction: 'Inbound' | 'Outbound';
  state: 'ok' | 'mismatch' | 'error' | 'not_in_box';
  expected: number | null;
  listed: number;
  error?: string;
};

export type InventorySnapshot = {
  version: number;
  rulesVersion: string;
  accountId: string;
  accountName: string;
  boxId: string;
  since: string;
  until: string;
  sinceTicks: string;
  untilTicks: string;
  createdAt: string;
  finishedAt: string | null;
  /** Шлюз: выгрузка разрешена только при `true`. */
  complete: boolean;
  reasons: string[];
  /** Замечания, которые шлюз не трогают: справочник типов, реквизиты контрагентов. */
  notes: string[];
  requests: number;
  boxTypes: { name: string; title: string | null }[] | null;
  windows: WindowRecord[];
  typeControls: TypeControl[];
  /** `ГГГГ|направление|тип` → число документов. */
  counts: Record<string, number>;
  skipped: { test: number; deleted: number; deletedInPackages: number };
  firstDocumentAt: { inbound: string | null; outbound: string | null };
  rows: SnapshotRow[];
  messages: SnapshotMessage[];
  counterparties: Counterparty[];
};

export type ArtifactKind = 'doc' | 'file' | 'signature' | 'printform';
export type SignatureRole = 'sender' | 'recipient' | 'approvement' | 'other';
export type RecipientState = 'есть' | 'отказ' | 'ещё не подписан' | 'не требуется' | 'неизвестно';

/** Итог по одной вещи. `error` — не итог: при следующем запуске повторяется. */
export type ProgressRecord =
  | {
      kind: 'doc';
      key: string;
      row: number;
      at: string;
      signatureIds: string[];
      roles: Record<string, SignatureRole>;
      recipientState: RecipientState;
      newSignatures: number;
    }
  | {
      kind: 'file' | 'signature' | 'printform';
      key: string;
      row: number;
      at: string;
      outcome: 'done';
      path: string;
      size: number;
      sha256: string;
    }
  | { kind: 'printform'; key: string; row: number; at: string; outcome: 'unavailable'; reason: string }
  | { kind: 'doc' | 'file' | 'signature' | 'printform'; key: string; row: number; at: string; outcome: 'error'; reason: string };

/** Выбор строк привязан к описи: номера строк имеют смысл только в своём снимке. */
export type Selected = { snapshotCreatedAt: string; rows: number[]; include: ReviewCategory[]; addRows: number[] };

export function docKey(r: Pick<SnapshotRow, 'messageId' | 'entityId'>): string {
  return `${r.messageId}/${r.entityId}`;
}

export function artifactKey(
  r: Pick<SnapshotRow, 'messageId' | 'entityId'>,
  kind: ArtifactKind,
  signatureEntityId?: string,
): string {
  return kind === 'signature' ? `${docKey(r)}/signature/${signatureEntityId}` : `${docKey(r)}/${kind}`;
}

export class SnapshotInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotInvalid';
  }
}

/** Запись через временный файл: обрыв не оставит половину JSON. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmp, file);
}

export async function readSnapshot(outDir: string): Promise<InventorySnapshot> {
  const file = path.join(outDir, INVENTORY_FILE);
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    throw new SnapshotInvalid(`нет описи ${file}: сначала запустите --inventory`);
  }
  const snap = JSON.parse(raw) as InventorySnapshot;
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new SnapshotInvalid(`опись другой версии (${snap.version}), нужна ${SNAPSHOT_VERSION}: составьте заново`);
  }
  return snap;
}

export async function readProgress(outDir: string): Promise<Map<string, ProgressRecord>> {
  const out = new Map<string, ProgressRecord>();
  let raw: string;
  try {
    raw = await readFile(path.join(outDir, PROGRESS_FILE), 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // Последняя строка могла оборваться вместе с процессом — она просто не считается.
    try {
      const rec = JSON.parse(line) as ProgressRecord;
      out.set(rec.key, rec);
    } catch {
      continue;
    }
  }
  return out;
}

export async function appendProgress(outDir: string, rec: ProgressRecord): Promise<void> {
  await appendFile(path.join(outDir, PROGRESS_FILE), `${JSON.stringify(rec)}\n`, 'utf-8');
}

export async function readSelection(outDir: string): Promise<Selected | null> {
  try {
    return JSON.parse(await readFile(path.join(outDir, SELECTION_FILE), 'utf-8')) as Selected;
  } catch {
    return null;
  }
}
