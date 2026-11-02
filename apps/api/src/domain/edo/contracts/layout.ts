/**
 * Куда в архиве ложится каждый документ.
 *
 * Архив откроют в Windows, поэтому имена — по её правилам: без `\/:*?"<>|`,
 * без точки и пробела в конце, без зарезервированных имён (CON, NUL…), без
 * совпадений «с точностью до регистра». Длина ограничена на каждом уровне так,
 * чтобы путь внутри архива не выходил за ~200 знаков: распакованный в обычную
 * папку, он укладывается в 260.
 *
 * Раскладка считается заново при каждом запуске выгрузки, но из одного и того
 * же снимка и в порядке номеров строк — поэтому она детерминирована, и
 * продолжение пишет туда же, куда начало.
 */
import { CATEGORY_LABELS } from './classify.js';
import { FILES_DIR, type Counterparty, type InventorySnapshot, type SignatureRole, type SnapshotRow } from './snapshot.js';
import { REVOCATION_ACCEPTED } from '../document-meta.js';

export const NAME_LIMITS = { counterparty: 45, docFolder: 55, file: 64 } as const;
export const ANNULLED_DIR = '_аннулированные и отклонённые';
export const PRINT_FORM_FILE = 'печатная форма.pdf';

const FORBIDDEN = /[\\/:*?"<>|]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Обрезка по символам, а не байтам: кириллица не рвётся пополам. */
function cut(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

function trimEnds(value: string): string {
  return value.replace(/^[\s.]+|[\s.]+$/g, '');
}

/** Один сегмент пути, безопасный для Windows и Linux. */
export function safeSegment(raw: string, max: number): string {
  // Управляющие символы (коды 0–31) — тоже запрещены в Windows.
  const visible = Array.from(raw, (ch) => (ch.charCodeAt(0) < 32 ? '_' : ch)).join('');
  let s = trimEnds(visible.replace(FORBIDDEN, '_').replace(/\s+/g, ' '));
  s = trimEnds(cut(s, max));
  if (!s) s = '_';
  if (RESERVED.test(s)) s = cut(`_${s}`, max);
  return s;
}

export function splitExt(name: string): { stem: string; ext: string | null } {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,5})$/.exec(name);
  return m && m[1] ? { stem: m[1], ext: m[2]!.toLowerCase() } : { stem: name, ext: null };
}

/** Имя файла не длиннее `max`: режется основа, хвост (подпись, расширение) сохраняется. */
export function fitFileName(stem: string, tail: string, max: number = NAME_LIMITS.file): string {
  const room = Math.max(8, max - Array.from(tail).length);
  return `${safeSegment(stem, room)}${tail}`;
}

const ROLE_LABELS: Record<SignatureRole, string> = {
  sender: 'подпись отправителя',
  recipient: 'подпись получателя',
  approvement: 'согласующая подпись',
  other: 'подпись',
};

/** `<основа> — подпись получателя 2.sig`; номер — с второй подписи той же роли. */
export function signatureFileName(stem: string, role: SignatureRole, index: number): string {
  return fitFileName(stem, ` — ${ROLE_LABELS[role]}${index > 1 ? ` ${index}` : ''}.sig`);
}

export function isAnnulledOrRejected(row: Pick<SnapshotRow, 'revocation' | 'recipientResponse'>): boolean {
  return row.revocation === REVOCATION_ACCEPTED || /rejected/i.test(row.recipientResponse ?? '');
}

const moscowDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function moscowDay(iso: string | null): string {
  if (!iso) return 'без даты';
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? moscowDate.format(d) : 'без даты';
}

export function counterpartyTitle(cp: Counterparty | undefined, boxId: string | null): string {
  const inn = cp?.inn ? ` (${cp.inn})` : '';
  const name = cp?.name?.trim() || (boxId ? `Без названия ${boxId.slice(0, 8)}` : 'Без контрагента');
  return `${safeSegment(name, NAME_LIMITS.counterparty - inn.length)}${inn}`;
}

export type RowLayout = {
  /** Папка документа относительно папки выгрузки, через `/`. */
  dir: string;
  /** Основа имени исходного файла (уже безопасная) и расширение, если известно. */
  stem: string;
  ext: string | null;
};

/**
 * Папки всех выбранных строк. Совпадения имён разводятся суффиксом « (2)» —
 * без учёта регистра, как в Windows.
 */
export function computeLayout(snapshot: InventorySnapshot, rows: readonly SnapshotRow[]): Map<number, RowLayout> {
  const cps = new Map(snapshot.counterparties.map((c) => [c.boxId, c]));
  const cpFolders = new Map<string, string>();
  const usedCpFolders = new Map<string, string>();
  const usedDocFolders = new Set<string>();
  const out = new Map<number, RowLayout>();

  const cpFolderOf = (boxId: string | null): string => {
    const k = boxId ?? '';
    const known = cpFolders.get(k);
    if (known) return known;
    let folder = counterpartyTitle(boxId ? cps.get(boxId) : undefined, boxId);
    const owner = usedCpFolders.get(folder.toLowerCase());
    if (owner !== undefined && owner !== k) {
      folder = `${safeSegment(folder, NAME_LIMITS.counterparty - 9)} [${k.slice(0, 6)}]`;
    }
    usedCpFolders.set(folder.toLowerCase(), k);
    cpFolders.set(k, folder);
    return folder;
  };

  for (const row of [...rows].sort((a, b) => a.row - b.row)) {
    const parent = [FILES_DIR, cpFolderOf(row.counteragentBoxId), ...(isAnnulledOrRejected(row) ? [ANNULLED_DIR] : [])].join('/');
    const { stem, ext } = splitExt(row.fileName?.trim() || `документ ${row.row}`);
    const base = `${moscowDay(row.at)} ${CATEGORY_LABELS[row.category]} ${stem}`;
    let folder = safeSegment(base, NAME_LIMITS.docFolder);
    for (let n = 2; usedDocFolders.has(`${parent}/${folder}`.toLowerCase()); n++) {
      folder = `${safeSegment(base, NAME_LIMITS.docFolder - 5)} (${n})`;
    }
    usedDocFolders.add(`${parent}/${folder}`.toLowerCase());
    out.set(row.row, { dir: `${parent}/${folder}`, stem: safeSegment(stem, NAME_LIMITS.file), ext });
  }
  return out;
}
