/**
 * Выгрузка договоров по полной описи и проверка, что выгрузка завершена.
 *
 * Два шлюза, которые нельзя путать:
 *   - полнота ОПИСИ — без неё выгрузка не начинается (обхода нет);
 *   - полнота ВЫГРУЗКИ — у каждой выбранной строки есть итог по исходному
 *     файлу, по каждой найденной подписи и по печатной форме. Итог — «скачано»
 *     или «недоступно с причиной» (409 печатной формы); ошибка итогом не
 *     считается. Пока шлюз не пройден, упаковывать архив нельзя.
 *
 * Перед скачиванием сообщения его состав читается заново (`GetMessage`):
 * подписи, появившиеся после описи, тоже попадут в архив. Подписи — все
 * сущности-подписи документа, каждая отдельным файлом, в том виде, в каком
 * Диадок отдаёт их по умолчанию (CAdES-T, с меткой времени).
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiadocClient } from '../diadoc.client.js';
import type { DiadocEntity, DiadocMessage } from '../diadoc.types.js';
import { detectEdoFile } from '../edo-file-kind.js';
import { EdoLeaseLost } from '../inventory.js';
import { NONFORMALIZED_TYPE, REVIEW_CATEGORIES, type ReviewCategory } from './classify.js';
import { isDocumentEntity, isSignatureEntity } from './inventory.js';
import { PRINT_FORM_FILE, computeLayout, fitFileName, signatureFileName, splitExt, type RowLayout } from './layout.js';
import {
  SELECTION_FILE,
  appendProgress,
  artifactKey,
  readProgress,
  readSelection,
  writeJsonAtomic,
  type InventorySnapshot,
  type ProgressRecord,
  type RecipientState,
  type Selected,
  type SignatureRole,
  type SnapshotRow,
} from './snapshot.js';

export type DownloadSession = {
  account: { id: string; name: string };
  boxId: string;
  client: Pick<DiadocClient, 'getMessage' | 'getEntityContent' | 'generatePrintForm'>;
  ensureLease: () => Promise<void>;
};

export type DownloadOptions = {
  outDir: string;
  include: ReviewCategory[];
  addRows: number[];
  /** Сколько документов обработать за этот запуск. */
  limit?: number | null;
  /** После этого момента новые документы не начинаются. */
  deadline?: Date | null;
  maxFileBytes: number;
  printFormAttempts?: number;
  printFormMaxWaitMs?: number;
  /** Пауза перед каждым запросом к Диадоку — сверх повторов на 429/5xx в транспорте. */
  pauseMs?: number;
  /** Свободное место в папке выгрузки; меньше `minFreeBytes` — остановка до переполнения диска. */
  freeBytes?: () => Promise<number>;
  minFreeBytes?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type DownloadRun = {
  selected: number;
  processed: number;
  stoppedBy: 'limit' | 'deadline' | 'lease_lost' | 'disk' | null;
  errors: number;
  requests: number;
};

/** Выгрузка не начата: опись неполная, чужая или выбор указан неверно. */
export class DownloadRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DownloadRefused';
  }
}

const REJECTION = /SignatureRequestRejection|XmlSignatureRejection/i;

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export function assertDownloadable(snapshot: InventorySnapshot, session?: Pick<DownloadSession, 'account' | 'boxId'>): void {
  if (!snapshot.complete) {
    throw new DownloadRefused(
      `опись неполная — выгрузка по ней запрещена. Причины: ${snapshot.reasons.join('; ') || 'не указаны'}. Составьте опись заново.`,
    );
  }
  if (session && (session.account.id !== snapshot.accountId || session.boxId !== snapshot.boxId)) {
    throw new DownloadRefused('опись составлена по другой учётке или другому ящику');
  }
}

/**
 * Выбор строк: «Берём» + категории «на просмотр», включённые целиком, + номера
 * строк, добавленные вручную. Выбор копится от запуска к запуску (выбранное раньше
 * не теряется) и хранится в selection.json — по нему же работает проверка.
 */
export async function resolveSelection(
  snapshot: InventorySnapshot,
  outDir: string,
  include: readonly ReviewCategory[],
  addRows: readonly number[],
): Promise<{ selected: Selected; rows: SnapshotRow[] }> {
  for (const c of include) {
    if (!(REVIEW_CATEGORIES as readonly string[]).includes(c)) throw new DownloadRefused(`неизвестная категория «${c}»`);
  }
  const byRow = new Map(snapshot.rows.map((r) => [r.row, r]));
  const unknown = addRows.filter((n) => !byRow.has(n));
  if (unknown.length > 0) throw new DownloadRefused(`строк ${unknown.join(', ')} нет в описи`);

  const previous = await readSelection(outDir);
  if (previous && previous.snapshotCreatedAt !== snapshot.createdAt) {
    throw new DownloadRefused('в папке выбор строк от другой описи — новую опись выгружайте в другую папку');
  }
  const includeAll = new Set<ReviewCategory>([...(previous?.include ?? []), ...include]);
  const addAll = new Set<number>([...(previous?.addRows ?? []), ...addRows]);
  const picked = snapshot.rows.filter(
    (r) =>
      r.selection === 'auto' ||
      (r.selection === 'review' && includeAll.has(r.category as ReviewCategory)) ||
      addAll.has(r.row),
  );
  const selected: Selected = {
    snapshotCreatedAt: snapshot.createdAt,
    rows: picked.map((r) => r.row),
    include: [...includeAll],
    addRows: [...addAll].sort((a, b) => a - b),
  };
  await writeJsonAtomic(path.join(outDir, SELECTION_FILE), selected);
  return { selected, rows: picked };
}

async function fileOk(outDir: string, rec: ProgressRecord | undefined): Promise<boolean> {
  if (!rec || !('outcome' in rec) || rec.outcome !== 'done') return false;
  try {
    const st = await stat(path.join(outDir, rec.path));
    return st.isFile() && st.size === rec.size;
  } catch {
    return false;
  }
}

/** Итог есть: скачано (и файл на месте нужного размера) или недоступно с причиной. */
async function settled(outDir: string, rec: ProgressRecord | undefined): Promise<boolean> {
  if (!rec || !('outcome' in rec)) return false;
  if (rec.outcome === 'unavailable') return true;
  return fileOk(outDir, rec);
}

export type RowDownloadState = {
  row: number;
  complete: boolean;
  missing: string[];
  file: 'скачан' | 'ошибка' | 'нет';
  signatures: Record<SignatureRole, number>;
  recipientState: RecipientState | null;
  newSignatures: number | null;
  printForm: 'есть' | 'недоступна' | 'ошибка' | 'нет';
  printFormReason: string | null;
  dir: string | null;
  error: string | null;
};

export type DownloadState = {
  selected: Selected | null;
  rows: Map<number, RowDownloadState>;
  complete: boolean;
  done: number;
  pending: number;
};

/** Состояние выгрузки по файлам на диске и журналу — без обращения к Диадоку. */
export async function collectDownloadState(outDir: string, snapshot: InventorySnapshot): Promise<DownloadState> {
  const read = await readSelection(outDir);
  // Выбор от другой описи к этой не относится: проверять по нему нечего.
  const selected = read && read.snapshotCreatedAt === snapshot.createdAt ? read : null;
  const progress = await readProgress(outDir);
  const rows = new Map<number, RowDownloadState>();
  const byRow = new Map(snapshot.rows.map((r) => [r.row, r]));
  let done = 0;
  for (const n of selected?.rows ?? []) {
    const row = byRow.get(n);
    if (!row) continue;
    const state = await rowState(outDir, row, progress);
    rows.set(n, state);
    if (state.complete) done += 1;
  }
  const total = selected?.rows.length ?? 0;
  return { selected, rows, complete: selected !== null && done === total, done, pending: total - done };
}

async function rowState(outDir: string, row: SnapshotRow, progress: Map<string, ProgressRecord>): Promise<RowDownloadState> {
  const missing: string[] = [];
  const docRec = progress.get(artifactKey(row, 'doc'));
  const fileRec = progress.get(artifactKey(row, 'file'));
  const printRec = progress.get(artifactKey(row, 'printform'));
  const signatures: Record<SignatureRole, number> = { sender: 0, recipient: 0, approvement: 0, other: 0 };
  let error: string | null = null;
  let recipientState: RecipientState | null = null;
  let newSignatures: number | null = null;

  if (!docRec || docRec.kind !== 'doc' || ('outcome' in docRec && docRec.outcome === 'error')) {
    missing.push('состав документа не прочитан');
    if (docRec && 'outcome' in docRec && docRec.outcome === 'error') error = docRec.reason;
  } else if (!('outcome' in docRec)) {
    recipientState = docRec.recipientState;
    newSignatures = docRec.newSignatures;
    for (const id of docRec.signatureIds) {
      const rec = progress.get(artifactKey(row, 'signature', id));
      if (await fileOk(outDir, rec)) signatures[docRec.roles[id] ?? 'other'] += 1;
      else {
        missing.push(`подпись ${id}`);
        if (rec && 'outcome' in rec && rec.outcome === 'error') error = rec.reason;
      }
    }
  }

  const fileDone = await fileOk(outDir, fileRec);
  if (!fileDone) {
    missing.push('исходный файл');
    if (fileRec && 'outcome' in fileRec && fileRec.outcome === 'error') error = fileRec.reason;
  }
  const printSettled = await settled(outDir, printRec);
  if (!printSettled) {
    missing.push('печатная форма');
    if (printRec && 'outcome' in printRec && printRec.outcome === 'error') error = printRec.reason;
  }
  const printForm: RowDownloadState['printForm'] = !printRec
    ? 'нет'
    : 'outcome' in printRec && printRec.outcome === 'unavailable'
      ? 'недоступна'
      : printSettled
        ? 'есть'
        : 'ошибка';

  return {
    row: row.row,
    complete: missing.length === 0,
    missing,
    file: fileDone ? 'скачан' : fileRec ? 'ошибка' : 'нет',
    signatures,
    recipientState,
    newSignatures,
    printForm,
    printFormReason: printRec && 'outcome' in printRec && printRec.outcome === 'unavailable' ? printRec.reason : null,
    dir: fileRec && 'outcome' in fileRec && fileRec.outcome === 'done' ? path.posix.dirname(fileRec.path) : null,
    error,
  };
}

export function signatureRoles(message: DiadocMessage, signatures: DiadocEntity[]): Record<string, SignatureRole> {
  const out: Record<string, SignatureRole> = {};
  for (const s of signatures) {
    out[s.EntityId] = s.IsApprovementSignature
      ? 'approvement'
      : s.SignerBoxId && s.SignerBoxId === message.FromBoxId
        ? 'sender'
        : s.SignerBoxId && s.SignerBoxId === message.ToBoxId
          ? 'recipient'
          : 'other';
  }
  return out;
}

/**
 * Состояние ответной подписи. «Не требуется» — только когда Диадок прямо
 * сказал это у неформализованного документа; у прочих типов признак не
 * приходит, и без подписи и отказа честный ответ — «неизвестно».
 */
export function recipientStateOf(
  doc: DiadocEntity,
  typeNamedId: string | null,
  recipientSignatures: number,
  rejected: boolean,
): RecipientState {
  if (recipientSignatures > 0) return 'есть';
  if (rejected) return 'отказ';
  if (typeNamedId === NONFORMALIZED_TYPE && doc.NeedRecipientSignature === false) return 'не требуется';
  if (typeNamedId === NONFORMALIZED_TYPE && doc.NeedRecipientSignature === true) return 'ещё не подписан';
  return 'неизвестно';
}

export async function runContractDownload(
  session: DownloadSession,
  snapshot: InventorySnapshot,
  opts: DownloadOptions,
): Promise<DownloadRun> {
  assertDownloadable(snapshot, session);
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const attempts = opts.printFormAttempts ?? 10;
  const maxWait = opts.printFormMaxWaitMs ?? 30_000;
  const { client, boxId } = session;
  const { outDir } = opts;

  const { rows } = await resolveSelection(snapshot, outDir, opts.include, opts.addRows);
  const layout = computeLayout(snapshot, rows);
  const progress = await readProgress(outDir);
  const run: DownloadRun = { selected: rows.length, processed: 0, stoppedBy: null, errors: 0, requests: 0 };

  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (opts.pauseMs) await sleep(opts.pauseMs);
    await session.ensureLease();
    run.requests += 1;
    return fn();
  };
  // Диск — общий с порталом: при нехватке места выгрузка останавливается сама.
  const diskLow = async (): Promise<boolean> => {
    if (!opts.freeBytes || opts.minFreeBytes === undefined) return false;
    const free = await opts.freeBytes();
    if (free >= opts.minFreeBytes) return false;
    log(`Мало места на диске: свободно ${Math.round(free / 2 ** 20)} МБ, нужно не меньше ${Math.round(opts.minFreeBytes / 2 ** 20)} МБ`);
    return true;
  };
  const record = async (rec: ProgressRecord) => {
    progress.set(rec.key, rec);
    if ('outcome' in rec && rec.outcome === 'error') run.errors += 1;
    await appendProgress(outDir, rec);
  };
  const stamp = () => now().toISOString();

  const pending: SnapshotRow[] = [];
  for (const row of rows) {
    if (!(await rowState(outDir, row, progress)).complete) pending.push(row);
  }
  log(`Выбрано ${rows.length}, осталось ${pending.length}`);

  const byMessage = new Map<string, SnapshotRow[]>();
  for (const row of pending) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push(row);
    byMessage.set(row.messageId, list);
  }

  try {
    outer: for (const [messageId, msgRows] of byMessage) {
      if (opts.deadline && now() >= opts.deadline) {
        run.stoppedBy = 'deadline';
        break;
      }
      if (await diskLow()) {
        run.stoppedBy = 'disk';
        break;
      }
      let message: DiadocMessage | null = null;
      try {
        message = await call(() => client.getMessage(boxId, messageId));
      } catch (err) {
        if (err instanceof EdoLeaseLost) throw err;
        for (const row of msgRows) {
          await record({ kind: 'doc', key: artifactKey(row, 'doc'), row: row.row, at: stamp(), outcome: 'error', reason: `состав сообщения: ${errorText(err)}` });
        }
        continue;
      }
      for (const row of msgRows) {
        if (opts.limit != null && run.processed >= opts.limit) {
          run.stoppedBy = 'limit';
          break outer;
        }
        if (opts.deadline && now() >= opts.deadline) {
          run.stoppedBy = 'deadline';
          break outer;
        }
        if (await diskLow()) {
          run.stoppedBy = 'disk';
          break outer;
        }
        await downloadRow(row, message, layout.get(row.row)!);
        run.processed += 1;
        if (run.processed % 25 === 0) log(`Обработано ${run.processed} из ${pending.length}`);
      }
    }
  } catch (err) {
    if (!(err instanceof EdoLeaseLost)) throw err;
    run.stoppedBy = 'lease_lost';
  }
  return run;

  async function writeArtifact(rel: string, buf: Buffer): Promise<{ size: number; sha256: string }> {
    const full = path.join(outDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.part`;
    await writeFile(tmp, buf);
    await rename(tmp, full);
    return { size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  async function downloadRow(row: SnapshotRow, message: DiadocMessage, place: RowLayout): Promise<void> {
    const doc = message.Entities.find((e) => e.EntityId === row.entityId && isDocumentEntity(e));
    if (!doc) {
      await record({ kind: 'doc', key: artifactKey(row, 'doc'), row: row.row, at: stamp(), outcome: 'error', reason: 'документа нет в сообщении' });
      return;
    }
    const sigs = message.Entities.filter((e) => isSignatureEntity(e) && e.ParentEntityId === row.entityId);
    const roles = signatureRoles(message, sigs);
    const rejected = message.Entities.some((e) => e.ParentEntityId === row.entityId && REJECTION.test(e.AttachmentType ?? ''));
    const recipientCount = Object.values(roles).filter((r) => r === 'recipient').length;
    await record({
      kind: 'doc',
      key: artifactKey(row, 'doc'),
      row: row.row,
      at: stamp(),
      signatureIds: sigs.map((s) => s.EntityId),
      roles,
      recipientState: recipientStateOf(doc, row.typeNamedId, recipientCount, rejected),
      newSignatures: row.inventorySignatures === null ? 0 : Math.max(0, sigs.length - row.inventorySignatures),
    });

    // Исходный файл.
    const fileKey = artifactKey(row, 'file');
    if (!(await fileOk(outDir, progress.get(fileKey)))) {
      try {
        const buf = await call(() => client.getEntityContent(boxId, row.messageId, row.entityId, opts.maxFileBytes));
        const original = doc.FileName ?? doc.DocumentInfo?.FileName ?? row.fileName ?? '';
        const ext = splitExt(original).ext ?? `.${detectEdoFile(buf, original || null).ext}`;
        const rel = `${place.dir}/${fitFileName(place.stem, ext)}`;
        await record({ kind: 'file', key: fileKey, row: row.row, at: stamp(), outcome: 'done', path: rel, ...(await writeArtifact(rel, buf)) });
      } catch (err) {
        if (err instanceof EdoLeaseLost) throw err;
        await record({ kind: 'file', key: fileKey, row: row.row, at: stamp(), outcome: 'error', reason: errorText(err) });
      }
    }

    // Подписи — каждая отдельно; номер внутри роли — по порядку в сообщении.
    const seenByRole: Record<SignatureRole, number> = { sender: 0, recipient: 0, approvement: 0, other: 0 };
    for (const sig of sigs) {
      const role = roles[sig.EntityId]!;
      seenByRole[role] += 1;
      const key = artifactKey(row, 'signature', sig.EntityId);
      if (await fileOk(outDir, progress.get(key))) continue;
      try {
        const buf = await call(() => client.getEntityContent(boxId, row.messageId, sig.EntityId, opts.maxFileBytes));
        const rel = `${place.dir}/${signatureFileName(place.stem, role, seenByRole[role])}`;
        await record({ kind: 'signature', key, row: row.row, at: stamp(), outcome: 'done', path: rel, ...(await writeArtifact(rel, buf)) });
      } catch (err) {
        if (err instanceof EdoLeaseLost) throw err;
        await record({ kind: 'signature', key, row: row.row, at: stamp(), outcome: 'error', reason: errorText(err) });
      }
    }

    // Печатная форма.
    const printKey = artifactKey(row, 'printform');
    if (await settled(outDir, progress.get(printKey))) return;
    try {
      for (let attempt = 1; ; attempt++) {
        const res = await call(() => client.generatePrintForm(boxId, row.messageId, row.entityId, opts.maxFileBytes));
        if (res.state === 'ready') {
          const rel = `${place.dir}/${PRINT_FORM_FILE}`;
          await record({ kind: 'printform', key: printKey, row: row.row, at: stamp(), outcome: 'done', path: rel, ...(await writeArtifact(rel, res.pdf)) });
          return;
        }
        if (res.state === 'unavailable') {
          await record({ kind: 'printform', key: printKey, row: row.row, at: stamp(), outcome: 'unavailable', reason: `Диадок не формирует PDF (409): ${res.text || 'без текста'}` });
          return;
        }
        if (attempt >= attempts) {
          await record({ kind: 'printform', key: printKey, row: row.row, at: stamp(), outcome: 'error', reason: `форма не готова за ${attempts} попыток` });
          return;
        }
        await sleep(Math.min(res.afterMs, maxWait));
      }
    } catch (err) {
      if (err instanceof EdoLeaseLost) throw err;
      await record({ kind: 'printform', key: printKey, row: row.row, at: stamp(), outcome: 'error', reason: errorText(err) });
    }
  }
}
